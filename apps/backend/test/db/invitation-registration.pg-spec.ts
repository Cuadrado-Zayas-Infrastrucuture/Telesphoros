import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PgMembershipAdmin } from '../../src/membership/pg-membership-admin';
import { PgTenantAdmin } from '../../src/membership/pg-tenant-admin';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/** Audit item 25 at the database: invitation_create_keyed, the retry identity on invitations, and who may call it. */
let db: EphemeralDatabase;
beforeAll(async () => {
  db = await createEphemeralDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
async function asApplication<T>(tenant: string | null, actor: string | null, work: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: db.appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (tenant !== null) await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant]);
    if (actor !== null) await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
async function organization(): Promise<{ tenant: string; admin: string }> {
  const tenant = `org-${randomUUID().slice(0, 8)}`;
  const admin = `admin-${randomUUID().slice(0, 8)}`;
  await owner(async (c) => {
    await new PgTenantAdmin(c).registerTenant({ id: tenant, displayName: tenant, by: 'ops' });
    await new PgMembershipAdmin(c).grant({ tenantId: tenant, sub: admin, roles: ['admin'] as never, by: 'ops', reason: 'test' });
  });
  return { tenant, admin };
}
const keyed = (t: string, a: string, digest: Buffer, roles: string[], request: { id: string; hash: string } | null) =>
  asApplication(
    t,
    a,
    async (c) =>
      (await c.query('SELECT invitation_create_keyed($1, $2, $3::text[], $4, $5) AS id', [digest, 'x***@y.test', roles, request?.id ?? null, request?.hash ?? null])).rows[0]
        .id as string,
  );
const hash = (c: string) => c.repeat(64);

describe('invitation_create_keyed', () => {
  it('stores the invitation once and returns the same id to a repeat by the same administrator', async () => {
    const { tenant, admin } = await organization();
    const request = { id: randomUUID(), hash: hash('a') };
    const first = await keyed(tenant, admin, Buffer.alloc(32, 1), ['reader'], request);
    expect(await keyed(tenant, admin, Buffer.alloc(32, 1), ['reader'], request)).toBe(first);
    expect((await owner((c) => c.query('SELECT 1 FROM invitations WHERE tenant_id = $1', [tenant]))).rowCount).toBe(1);
  });

  it('refuses the same id with another fingerprint, as request-id-reused', async () => {
    const { tenant, admin } = await organization();
    const id = randomUUID();
    await keyed(tenant, admin, Buffer.alloc(32, 2), ['reader'], { id, hash: hash('a') });
    await expect(keyed(tenant, admin, Buffer.alloc(32, 3), ['reader'], { id, hash: hash('b') })).rejects.toMatchObject({ message: 'request-id-reused' });
  });

  it("keeps one administrator's ids apart from another's, and without an id acts as invitation_create does (an unkeyed repeat is refused as pending)", async () => {
    const { tenant, admin } = await organization();
    const second = `admin-${randomUUID().slice(0, 8)}`;
    await owner((c) => new PgMembershipAdmin(c).grant({ tenantId: tenant, sub: second, roles: ['admin'] as never, by: 'ops', reason: 'test' }));
    const request = { id: randomUUID(), hash: hash('a') };
    const a = await keyed(tenant, admin, Buffer.alloc(32, 4), ['reader'], request);
    await expect(keyed(tenant, second, Buffer.alloc(32, 4), ['reader'], request)).rejects.toMatchObject({ constraint: 'invitations_one_pending_uq' }); // same address still pending
    expect(a).toBeDefined();
    await expect(keyed(tenant, admin, Buffer.alloc(32, 4), ['reader'], null)).rejects.toMatchObject({ constraint: 'invitations_one_pending_uq' });
  });

  it('is for an active administrator only, like the function it extends', async () => {
    const { tenant } = await organization();
    await expect(keyed(tenant, 'someone-else', Buffer.alloc(32, 5), ['reader'], { id: randomUUID(), hash: hash('a') })).rejects.toMatchObject({ message: 'not-administrator' });
    await expect(
      asApplication(tenant, 'x', (c) => c.query('SELECT invitation_create_keyed($1, $2, $3::text[], $4, $5)', [Buffer.alloc(32), 'x', ['reader'], randomUUID(), 'zz'])),
    ).rejects.toThrow();
  });

  it('is not callable by PUBLIC', async () => {
    const rows = await owner((c) =>
      c.query(`SELECT has_function_privilege('public', 'invitation_create_keyed(bytea, text, text[], uuid, text)', 'EXECUTE') AS pub,
      has_function_privilege('telesphoros_app', 'invitation_create_keyed(bytea, text, text[], uuid, text)', 'EXECUTE') AS app`),
    );
    expect(rows.rows[0]).toEqual({ pub: false, app: true });
  });
});

describe('the retry identity of an invitation', () => {
  it('cannot be changed once stored, and an id needs its hash and the reverse', async () => {
    const { tenant, admin } = await organization();
    const request = { id: randomUUID(), hash: hash('c') };
    await keyed(tenant, admin, Buffer.alloc(32, 6), ['reader'], request);
    await expect(owner((c) => c.query('UPDATE invitations SET creation_request_id = gen_random_uuid() WHERE creation_request_id = $1', [request.id]))).rejects.toThrow(
      /retry identity/,
    );
    await expect(
      owner((c) =>
        c.query(
          `INSERT INTO invitations (tenant_id, email_digest, email_hint, expires_at, created_by, creation_request_id) VALUES ($1, $2, 'x***@y.test', now() + interval '1 day', 'ops', gen_random_uuid())`,
          [tenant, Buffer.alloc(32, 7)],
        ),
      ),
    ).rejects.toThrow(/invitations_creation_request_pair/);
  });
});
