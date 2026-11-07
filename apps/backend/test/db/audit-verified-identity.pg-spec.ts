import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { Client } from 'pg';
import { authorityContextMiddleware, bindRequestCapability } from '../../src/auth/authority-context';
import type { SecurityAuditEvent } from '../../src/auth/security-audit';
import { Database } from '../../src/db/database';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';
import { revertThrough } from '../helpers/migration-history';

/**
 * DATA-01 slice 4 (specs/001-tenant-capability, T027; decision D6): the access-audit writer stores the organization and person the request's capability
 * names as verified, and what the caller passes only as claimed. With no capability, or one that is expired or revoked, the verified fields are NULL and
 * the row is still written. Settings never count as verification. Synthetic data only.
 */
let db: EphemeralDatabase;
let database: Database;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();

type Capability = { token: string; expiresAt: Date };

/** Mints through the issuer login, as the real issuer does before the API records anything under it. */
async function issue(): Promise<Capability> {
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
      'req-audit-identity',
    ]);
    return { token, expiresAt: rows[0]!.expires_at };
  } finally {
    await c.end();
  }
}

/** Runs `work` inside a request's slot holding this capability, as AuthGuard leaves it. */
function inRequest<T>(capability: Capability | undefined, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    authorityContextMiddleware({ id: 'req-audit-identity' } as unknown as Request, {} as Response, () => {
      if (capability) bindRequestCapability({ ...capability, membershipVersion: 1 });
      work().then(resolve, reject);
    });
  });
}

const event = (requestId: string, claim: { tenantId: string; actorSub: string }): SecurityAuditEvent => ({
  type: 'private-read',
  outcome: 'succeeded',
  ...claim,
  routeKey: 'PatientsController.list',
  subjectId: null,
  requestId,
});
const mallory = { tenantId: 'org-beta', actorSub: 'mallory' };
const alice = { tenantId: 'org-alpha', actorSub: 'alice' };

/** The claimed and the verified identity of the row a request wrote. */
const stored = (requestId: string) =>
  owner(
    async (c) =>
      (await c.query('SELECT tenant_id, actor_sub, verified_tenant_id, verified_actor_sub FROM security_audit_events WHERE request_id = $1 ORDER BY occurred_at, id', [requestId]))
        .rows,
  );

beforeAll(async () => {
  db = await createEphemeralDatabase();
  database = new Database({ url: db.appUrl, ssl: 'disable' });
  await owner(async (c) => {
    await registerTenantRow(c, 'org-alpha');
    await registerTenantRow(c, 'org-beta');
    await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-alpha', 'alice', 'active', ARRAY['clinician'], 'test')`);
  });
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await db?.drop();
});

describe.each(['dual', 'capability'] as const)('in %s mode', (mode) => {
  beforeAll(() => owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = $1`, [mode])));
  const id = (label: string) => `aud-${mode}-${label}`;

  it('stores the capability as verified and the caller as claimed (US2)', async () => {
    await inRequest(await issue(), () => database.recordSecurityEvent(event(id('claim'), mallory)));
    expect(await stored(id('claim'))).toEqual([{ tenant_id: 'org-beta', actor_sub: 'mallory', verified_tenant_id: 'org-alpha', verified_actor_sub: 'alice' }]);
  });

  it('writes the row with no verified identity when the request has no capability', async () => {
    await inRequest(undefined, () => database.recordSecurityEvent(event(id('none'), alice)));
    expect(await stored(id('none'))).toEqual([{ tenant_id: 'org-alpha', actor_sub: 'alice', verified_tenant_id: null, verified_actor_sub: null }]);
  });

  it.each([
    [
      'expired',
      async (): Promise<Capability> => {
        const capability = await issue();
        await owner((c) =>
          c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE token_hash = $1`, [
            hashOf(capability.token),
          ]),
        );
        return capability; // the request's own copy still says it is current, so the database alone decides
      },
    ],
    [
      'revoked',
      async (): Promise<Capability> => {
        const capability = await issue();
        await owner((c) => c.query(`UPDATE tenant_capabilities SET revoked_at = now() WHERE token_hash = $1`, [hashOf(capability.token)]));
        return capability;
      },
    ],
  ])('verifies nothing under a capability that is %s, and still writes the row', async (label, capability) => {
    await inRequest(await capability(), () => database.recordSecurityEvent(event(id(label), alice)));
    expect(await stored(id(label))).toEqual([{ tenant_id: 'org-alpha', actor_sub: 'alice', verified_tenant_id: null, verified_actor_sub: null }]);
  });

  it('never treats forged settings as verification', async () => {
    const c = new Client({ connectionString: db.appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_tenant_id', 'org-beta', true), set_config('app.current_actor', 'mallory', true)`);
      await c.query('SELECT public.security_audit_record($1,$2,$3,$4,$5,$6,$7)', [
        'private-read',
        'succeeded',
        'org-beta',
        'mallory',
        'PatientsController.list',
        null,
        id('forged'),
      ]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    expect(await stored(id('forged'))).toEqual([{ tenant_id: 'org-beta', actor_sub: 'mallory', verified_tenant_id: null, verified_actor_sub: null }]);
  });
});

it('leaves the capability counts alone: an audit row is not a tenant transaction (D7 evidence)', async () => {
  const before = database.capabilityStats();
  await inRequest(undefined, () => database.recordSecurityEvent(event('aud-count-none', alice)));
  await inRequest(await issue(), () => database.recordSecurityEvent(event('aud-count-bound', alice)));
  expect(database.capabilityStats()).toEqual(before);
});

it('gives the application login no way to the capability lookup itself', async () => {
  const c = new Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await expect(c.query('SELECT * FROM public.security_audit_capability()')).rejects.toMatchObject({ code: '42501' });
  } finally {
    await c.end();
  }
});

it('refuses to drop verified identity evidence on revert, and reverts only when told to', async () => {
  const verified = () => owner(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM security_audit_events WHERE verified_tenant_id IS NOT NULL')).rows[0]!.n);
  const before = await verified();
  expect(before).toBeGreaterThan(0);
  const { steps, reverted } = revertThrough('audit_verified_identity');
  await expect(owner((c) => migrateDown(c, steps))).rejects.toThrow(/Refusing to drop verified access-audit identity/);
  await owner((c) => migrateUp(c));
  expect(await verified()).toBe(before);
  await owner(async (c) => {
    await c.query("SET telesphoros.allow_audit_drop = 'yes'");
    expect(await migrateDown(c, steps)).toEqual(reverted);
    const columns = await c.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'security_audit_events' AND column_name LIKE 'verified%' ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([]);
    expect(await migrateUp(c)).toEqual([...reverted].reverse());
  });
});
