import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PgMembershipAdmin } from '../../src/membership/pg-membership-admin';
import { PgTenantAdmin } from '../../src/membership/pg-tenant-admin';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * AUTH-03 (migration 0033, member_sign_out): a person's own sign-out cuts off their older tokens in their own organization, and nothing else.
 * Tested at the database, as the application login, with the organization and the person bound the way Database.withTenant binds them.
 */
let db: EphemeralDatabase;
beforeAll(async () => {
  db = await createEphemeralDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
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

async function organization(): Promise<{ tenant: string; admin: string; member: string }> {
  const tenant = id('org');
  const admin = id('admin');
  const member = id('member');
  await owner(async (c) => {
    await new PgTenantAdmin(c).registerTenant({ id: tenant, displayName: tenant, by: 'ops' });
    await new PgMembershipAdmin(c).grant({ tenantId: tenant, sub: admin, roles: ['admin'] as never, by: 'ops', reason: 'test' });
    await new PgMembershipAdmin(c).grant({ tenantId: tenant, sub: member, roles: ['clinician'] as never, by: 'ops', reason: 'test' });
  });
  return { tenant, admin, member };
}

/** The cut-off instant, read by the operator so the check does not depend on the application login. */
const cutOff = (tenant: string, sub: string) =>
  owner(async (c) => {
    const { rows } = await c.query<{ valid_after: string; changed_by: string; reason: string }>(
      `SELECT floor(extract(epoch FROM tokens_valid_after))::bigint::text AS valid_after, changed_by, reason
         FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2`,
      [tenant, sub],
    );
    return rows[0]!;
  });

describe('a person can end only their own sessions', () => {
  it("cuts off the caller's older tokens in their own organization, and no one else's", async () => {
    const { tenant, admin, member } = await organization();
    const adminBefore = await cutOff(tenant, admin);
    const memberBefore = await cutOff(tenant, member);
    const started = Math.floor(Date.now() / 1000);

    await asApplication(tenant, member, (c) => c.query('SELECT member_sign_out()'));

    const memberAfter = await cutOff(tenant, member);
    expect(Number(memberAfter.valid_after)).toBeGreaterThanOrEqual(started);
    expect(Number(memberAfter.valid_after)).toBeGreaterThan(Number(memberBefore.valid_after));
    expect(memberAfter).toMatchObject({ changed_by: member, reason: 'signed out' });
    expect(await cutOff(tenant, admin)).toEqual(adminBefore);
  });

  it('does nothing for a caller bound to another organization, even with a valid person in this one', async () => {
    const mine = await organization();
    const other = await organization();
    const before = await cutOff(mine.tenant, mine.member);

    await asApplication(other.tenant, mine.member, (c) => c.query('SELECT member_sign_out()'));

    expect(await cutOff(mine.tenant, mine.member)).toEqual(before);
  });

  it('is a no-op, not an error, for a person with no active membership in the organization', async () => {
    const { tenant } = await organization();
    const stranger = id('stranger');
    await expect(asApplication(tenant, stranger, (c) => c.query('SELECT member_sign_out()'))).resolves.toBeDefined();
    const rows = await owner(async (c) => (await c.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2`, [tenant, stranger])).rows);
    expect(rows).toEqual([]);
  });

  it('is refused when the request names no organization or no person', async () => {
    await expect(asApplication(null, null, (c) => c.query('SELECT member_sign_out()'))).rejects.toMatchObject({ code: '42501' });
    const { tenant } = await organization();
    await expect(asApplication(tenant, null, (c) => c.query('SELECT member_sign_out()'))).rejects.toMatchObject({ code: '42501' });
  });

  it('the application login cannot move the cut-off itself, only through the function', async () => {
    const { tenant, member } = await organization();
    await expect(asApplication(tenant, member, (c) => c.query(`UPDATE tenant_memberships SET tokens_valid_after = now() WHERE sub = $1`, [member]))).rejects.toMatchObject({
      code: '42501',
    });
  });
});
