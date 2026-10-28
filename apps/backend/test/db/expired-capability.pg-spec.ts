import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { Client } from 'pg';
import { authorityContextMiddleware, bindRequestCapability } from '../../src/auth/authority-context';
import { AppException } from '../../src/common/app-exception';
import { Database } from '../../src/db/database';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * Audit A3: a request keeps the one capability it was issued (at most 60 seconds) for every transaction it runs. Once that has expired the database
 * resolves no organization, so row-level security returns no rows and no error: a slow request answered "empty" instead of failing. The database layer
 * now refuses such a transaction with 503 before it opens one. Synthetic data: org-alpha has 3 patients.
 */
let db: EphemeralDatabase;
let database: Database;
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
      'req-a3-00000001',
    ]);
    return { token, expiresAt: rows[0]!.expires_at };
  } finally {
    await c.end();
  }
}

/** Runs `work` inside a request's slot holding this capability, as AuthGuard leaves it. */
function inRequest<T>(capability: { token: string; expiresAt: Date }, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    authorityContextMiddleware({ id: 'req-a3' } as unknown as Request, {} as Response, () => {
      bindRequestCapability({ ...capability, membershipVersion: 1 });
      work().then(resolve, reject);
    });
  });
}
const patients = () => database.withTenant('org-alpha', async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM patients')).rows[0]!.n);

beforeAll(async () => {
  db = await createEphemeralDatabase();
  database = new Database({ url: db.appUrl, ssl: 'disable' });
  await owner(async (c) => {
    await registerTenantRow(c, 'org-alpha');
    await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-alpha', 'alice', 'active', ARRAY['clinician'], 'test')`);
    for (let i = 0; i < 3; i += 1) await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('org-alpha', 'test', $1)`, [`SYN-a3-${i}`]);
  });
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await db?.drop();
});

it('reads the organization with a capability that is still valid (control)', async () => {
  const capability = await issue();
  expect(await inRequest(capability, patients)).toBe(3);
});

it('refuses with 503, and never answers an empty read, once the request has outlived its capability', async () => {
  const capability = await issue();
  // The request ran past the capability's lifetime: in the database and in the request's own copy alike.
  await owner((c) =>
    c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE token_hash = $1`, [
      hashOf(capability.token),
    ]),
  );
  const expired = { token: capability.token, expiresAt: new Date(capability.expiresAt.getTime() - 120_000) };
  const outcome = await inRequest(expired, patients).then(
    (n) => ({ rows: n }),
    (error: unknown) => ({ status: error instanceof AppException ? error.getStatus() : 'other' }),
  );
  expect(outcome).toEqual({ status: 503 });
  expect(database.capabilityStats().byReason).toMatchObject({ expired: 1 });
});
