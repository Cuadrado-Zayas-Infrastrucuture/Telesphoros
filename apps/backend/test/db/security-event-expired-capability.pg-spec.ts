import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { Client } from 'pg';
import { authorityContextMiddleware, bindRequestCapability } from '../../src/auth/authority-context';
import { Database } from '../../src/db/database';
import { PostgresSecurityEvents } from '../../src/security-events/security-events';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * Audit A3, the security-events half: a refusal recorded after the request's capability expired (an upload rejected as slow, a long write refused at
 * commit) was lost. The transaction was refused with 503 (or, before that, resolved no organization), and the failure was only logged. The event is now
 * written without the expired capability, as organization work without one is in the guc and dual modes. Synthetic data only.
 */
let db: EphemeralDatabase;
let database: Database;
let events: PostgresSecurityEvents;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Mints through the issuer login, as the real issuer does before the API opens its transaction. */
async function issue(): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const c = new Client({ connectionString: db.issuerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ expires_at: Date }>('SELECT * FROM tenant_capability_issue($1, $2, $3, $4, $5, $6)', [
      'org-alpha',
      'alice',
      1,
      'request',
      hashOf(token),
      'req-a3e-0000001',
    ]);
    return { token, expiresAt: rows[0]!.expires_at };
  } finally {
    await c.end();
  }
}

/** Runs `work` inside a request's slot holding this capability, as AuthGuard leaves it. */
function inRequest<T>(capability: { token: string; expiresAt: Date }, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    authorityContextMiddleware({ id: 'req-a3e' } as unknown as Request, {} as Response, () => {
      bindRequestCapability({ ...capability, membershipVersion: 1 });
      work().then(resolve, reject);
    });
  });
}

const recorded = (reason: string) =>
  owner(
    async (c) =>
      (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM security_events WHERE tenant_id = 'org-alpha' AND event_type = 'intake.rejected' AND actor_ref = 'alice' AND details ->> 'reason' = $1`,
          [reason],
        )
      ).rows[0]!.n,
  );

beforeAll(async () => {
  db = await createEphemeralDatabase();
  database = new Database({ url: db.appUrl, ssl: 'disable' });
  events = new PostgresSecurityEvents(database);
  await owner(async (c) => {
    await registerTenantRow(c, 'org-alpha');
    await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-alpha', 'alice', 'active', ARRAY['clinician'], 'test')`);
  });
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await db?.drop();
});

it('records a refusal under a capability that is still valid, and binds it (control)', async () => {
  const capability = await issue();
  const bound = database.capabilityStats().bound;
  await inRequest(capability, () => events.recordIntakeRejected('org-alpha', 'alice', 'size'));
  expect(await recorded('size')).toBe(1);
  expect(database.capabilityStats().bound).toBe(bound + 1);
});

it('records a refusal made after the request outlived its capability, and counts the capability as expired', async () => {
  const capability = await issue();
  // The request ran past the capability's lifetime: in the database and in the request's own copy alike.
  await owner((c) =>
    c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE token_hash = $1`, [
      hashOf(capability.token),
    ]),
  );
  const expired = { token: capability.token, expiresAt: new Date(capability.expiresAt.getTime() - 120_000) };
  await inRequest(expired, () => events.recordIntakeRejected('org-alpha', 'alice', 'slow'));
  expect(await recorded('slow')).toBe(1);
  expect(database.capabilityStats().byReason).toMatchObject({ expired: 1 });
});
