import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { InvitationDigest } from '../../src/members/invitation-digest';
import { PgInvitationAdmin } from '../../src/membership/pg-invitation-admin';
import { PgMembershipAdmin } from '../../src/membership/pg-membership-admin';
import { PgTenantAdmin } from '../../src/membership/pg-tenant-admin';
import { runInvite, runTenant } from '../../src/membership/tenant-cli';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * The tenant registry, the invitation table and the SECURITY DEFINER member-administration functions (migration 0019), tested at the database:
 * what the application login may and may not do, the rules the functions enforce, and who the membership events name.
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

/** The application login, with an organization and a person bound to the transaction the way Database.withTenant binds them. */
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

async function organization(roles: string[] = ['admin']): Promise<{ tenant: string; admin: string }> {
  const tenant = id('org');
  const admin = id('admin');
  await owner(async (c) => {
    await new PgTenantAdmin(c).registerTenant({ id: tenant, displayName: tenant, by: 'ops' });
    await new PgMembershipAdmin(c).grant({ tenantId: tenant, sub: admin, roles: roles as never, by: 'ops', reason: 'test' });
  });
  return { tenant, admin };
}
const grant = (tenant: string, sub: string, roles: string[]) => owner((c) => new PgMembershipAdmin(c).grant({ tenantId: tenant, sub, roles: roles as never, by: 'ops', reason: 'test' }));
const rolesOf = (tenant: string, sub: string) => owner(async (c) => (await c.query(`SELECT roles, status FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2`, [tenant, sub])).rows[0]);
const events = (tenant: string) => owner(async (c) => (await c.query(`SELECT event_type, actor_kind, actor_ref, subject_ref FROM security_events WHERE tenant_id = $1 ORDER BY seq`, [tenant])).rows);

describe('the application login cannot write the authority tables', () => {
  it.each([['tenant_memberships', 'changed_by'], ['tenants', 'changed_by'], ['invitations', 'created_by']])('%s: no insert, update, delete or truncate', async (table, column) => {
    const { tenant } = await organization();
    for (const sql of [
      `INSERT INTO ${table} SELECT * FROM ${table} WHERE false`,
      `UPDATE ${table} SET ${column} = 'x' WHERE false`,
      `DELETE FROM ${table} WHERE false`,
      `TRUNCATE ${table}`,
    ]) {
      await expect(asApplication(tenant, 'someone', (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('can read only its own organization\'s registry row, members and invitations', async () => {
    const a = await organization();
    const b = await organization();
    expect((await asApplication(a.tenant, a.admin, (c) => c.query('SELECT id FROM tenants'))).rows).toEqual([{ id: a.tenant }]);
    expect((await asApplication(a.tenant, a.admin, (c) => c.query('SELECT sub FROM tenant_memberships'))).rows).toEqual([{ sub: a.admin }]);
    expect((await asApplication(null, null, (c) => c.query('SELECT id FROM tenants'))).rows).toEqual([]);
    expect(b.tenant).not.toBe(a.tenant);
  });

  it('cannot call the context check directly, and the four functions are executable only by the application login', async () => {
    const { tenant, admin } = await organization();
    await expect(asApplication(tenant, admin, (c) => c.query('SELECT * FROM member_admin_context()'))).rejects.toMatchObject({ code: '42501' });
    const { rows } = await owner((c) =>
      c.query(`SELECT p.proname, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec, has_function_privilege('telesphoros_app', p.oid, 'EXECUTE') AS app_exec
                 FROM pg_proc p WHERE p.proname = ANY($1) ORDER BY p.proname`, [['member_change_roles', 'member_remove', 'invitation_create', 'invitation_cancel', 'member_admin_context']]),
    );
    expect(rows).toEqual([
      { proname: 'invitation_cancel', public_exec: false, app_exec: true },
      { proname: 'invitation_create', public_exec: false, app_exec: true },
      { proname: 'member_admin_context', public_exec: false, app_exec: false },
      { proname: 'member_change_roles', public_exec: false, app_exec: true },
      { proname: 'member_remove', public_exec: false, app_exec: true },
    ]);
  });
});

describe('the functions take the organization and the person from the transaction, never from the caller', () => {
  it('refuse a transaction that names no organization or no person', async () => {
    const { tenant, admin } = await organization();
    const target = id('t');
    await grant(tenant, target, ['reader']);
    for (const [t, a] of [[null, admin], [tenant, null], [null, null]] as const) {
      await expect(asApplication(t, a, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [target, ['clinician']]))).rejects.toMatchObject({ message: 'member-admin-context' });
    }
    expect((await rolesOf(tenant, target)).roles).toEqual(['reader']);
  });

  it('refuse a person who is not an active administrator of the bound organization, including an administrator of another one', async () => {
    const a = await organization();
    const b = await organization();
    const clinician = id('clin');
    await grant(a.tenant, clinician, ['clinician']);
    const target = id('t');
    await grant(a.tenant, target, ['reader']);
    for (const actor of [clinician, b.admin, id('stranger')]) {
      await expect(asApplication(a.tenant, actor, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [target, ['admin']]))).rejects.toMatchObject({ message: 'not-administrator' });
      await expect(asApplication(a.tenant, actor, (c) => c.query('SELECT member_remove($1)', [target]))).rejects.toMatchObject({ message: 'not-administrator' });
      await expect(asApplication(a.tenant, actor, (c) => c.query('SELECT invitation_create($1, $2, $3::text[])', [Buffer.alloc(32, 1), 'x***@y', ['reader']]))).rejects.toMatchObject({ message: 'not-administrator' });
    }
    expect((await rolesOf(a.tenant, target)).roles).toEqual(['reader']);
  });

  it('cannot be pointed at another organization\'s person: the lookup is inside the bound organization (member-not-found)', async () => {
    const a = await organization();
    const b = await organization();
    const victim = id('victim');
    await grant(b.tenant, victim, ['clinician']);
    await expect(asApplication(a.tenant, a.admin, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [victim, ['reader']]))).rejects.toMatchObject({ message: 'member-not-found' });
    await expect(asApplication(a.tenant, a.admin, (c) => c.query('SELECT member_remove($1)', [victim]))).rejects.toMatchObject({ message: 'member-not-found' });
    expect(await rolesOf(b.tenant, victim)).toMatchObject({ roles: ['clinician'], status: 'active' });
  });

  it('refuse a suspended organization, even for its administrator, and work again once it is active', async () => {
    const { tenant, admin } = await organization();
    const target = id('t');
    await grant(tenant, target, ['reader']);
    await owner((c) => new PgTenantAdmin(c).setTenantStatus({ id: tenant, status: 'suspended', by: 'ops' }));
    await expect(asApplication(tenant, admin, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [target, ['clinician']]))).rejects.toMatchObject({ message: 'tenant-inactive' });
    await owner((c) => new PgTenantAdmin(c).setTenantStatus({ id: tenant, status: 'active', by: 'ops' }));
    await asApplication(tenant, admin, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [target, ['clinician']]));
    expect((await rolesOf(tenant, target)).roles).toEqual(['clinician']);
  });

  it('never let the caller change or remove themselves (member-self), even as the only administrator', async () => {
    const { tenant, admin } = await organization();
    await expect(asApplication(tenant, admin, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [admin, ['reader']]))).rejects.toMatchObject({ message: 'member-self' });
    await expect(asApplication(tenant, admin, (c) => c.query('SELECT member_remove($1)', [admin]))).rejects.toMatchObject({ message: 'member-self' });
    expect(await rolesOf(tenant, admin)).toMatchObject({ roles: ['admin'], status: 'active' });
  });

  it('serialize two administrators acting on each other: exactly one wins and one administrator remains', async () => {
    const { tenant, admin } = await organization();
    const second = id('admin2');
    await grant(tenant, second, ['admin']);
    const outcomes = await Promise.allSettled([
      asApplication(tenant, admin, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [second, ['reader']])),
      asApplication(tenant, second, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [admin, ['reader']])),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')!;
    // The loser had already passed the administrator check when the winner committed; the rule after the lock refuses it (or the check does, if it ran later).
    expect(['last-administrator', 'not-administrator']).toContain((rejected.reason as Error).message);
    const admins = await owner(async (c) => (await c.query(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active' AND 'admin' = ANY(roles)`, [tenant])).rows[0].n);
    expect(admins).toBe(1);
  });

  it('write a version bump and the membership\'s change record, so the person\'s next request sees the change', async () => {
    const { tenant, admin } = await organization();
    const target = id('t');
    await grant(tenant, target, ['reader']);
    const before = await owner(async (c) => (await c.query(`SELECT version FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2`, [tenant, target])).rows[0].version);
    await asApplication(tenant, admin, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [target, ['reader', 'clinician']]));
    const after = await owner(async (c) => (await c.query(`SELECT version, changed_by FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2`, [tenant, target])).rows[0]);
    expect(Number(after.version)).toBeGreaterThan(Number(before));
    expect(after.changed_by).toBe(admin);
  });
});

describe('the membership events name who did it', () => {
  it('a change through the application is a person\'s act; the same change by an operator is an operator\'s', async () => {
    const { tenant, admin } = await organization();
    const target = id('t');
    await grant(tenant, target, ['reader']); // operator
    await asApplication(tenant, admin, (c) => c.query('SELECT member_change_roles($1, $2::text[])', [target, ['clinician']])); // administrator
    await asApplication(tenant, admin, (c) => c.query('SELECT member_remove($1)', [target]));
    const seen = (await events(tenant)).filter((e) => e.subject_ref === target);
    expect(seen).toEqual([
      { event_type: 'membership.granted', actor_kind: 'operator', actor_ref: 'ops', subject_ref: target },
      { event_type: 'membership.roles-changed', actor_kind: 'person', actor_ref: admin, subject_ref: target },
      { event_type: 'membership.removed', actor_kind: 'person', actor_ref: admin, subject_ref: target },
    ]);
  });

  it('an operator who happens to share a name with a bound person is still an operator when nothing is bound', async () => {
    const { tenant } = await organization();
    const target = id('t');
    await grant(tenant, target, ['reader']);
    await owner((c) => new PgMembershipAdmin(c).setRoles({ tenantId: tenant, sub: target, roles: ['clinician'], by: 'ops', reason: 'test' }));
    expect((await events(tenant)).filter((e) => e.subject_ref === target).map((e) => e.actor_kind)).toEqual(['operator', 'operator']);
  });
});

describe('the organization registry', () => {
  it('a membership must name a registered organization (foreign key), and the id and creation record never change', async () => {
    await expect(owner((c) => c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('never-registered', 'p', 'active', '{reader}', 'x')`))).rejects.toMatchObject({ code: '23503', constraint: 'tenant_memberships_tenant_fk' });
    const { tenant } = await organization();
    await expect(owner((c) => c.query(`UPDATE tenants SET id = 'renamed' WHERE id = $1`, [tenant]))).rejects.toMatchObject({ code: '23000' });
    await expect(owner((c) => c.query(`UPDATE tenants SET created_by = 'someone-else' WHERE id = $1`, [tenant]))).rejects.toMatchObject({ code: '23000' });
    await expect(owner((c) => c.query(`DELETE FROM tenants WHERE id = $1`, [tenant]))).rejects.toMatchObject({ code: '23000' });
    await expect(owner((c) => c.query('TRUNCATE tenants CASCADE'))).rejects.toBeTruthy();
    await expect(owner((c) => c.query(`UPDATE tenants SET id = id WHERE id = $1`, [tenant]))).resolves.toBeTruthy(); // control: a no-op update is not refused
  });

  it('the operator commands register, list, suspend and activate, and refuse duplicates and bad input', async () => {
    const t = id('cli');
    const lines: string[] = [];
    const run = (args: string[]) => owner((c) => runTenant(new PgTenantAdmin(c), args, (l) => lines.push(l)));
    expect(await run(['create', '--id', t, '--name', 'Synthetic Clinic', '--by', 'ops'])).toBe(0);
    expect(await run(['create', '--id', t, '--name', 'Again', '--by', 'ops'])).toBe(1);
    expect(await run(['create', '--id', 'Bad Id!', '--name', 'x', '--by', 'ops'])).toBe(1);
    expect(await run(['suspend', '--id', t, '--by', 'ops'])).toBe(0);
    expect(await run(['list'])).toBe(0);
    expect(lines.join('\n')).toContain(`id=${t} name="Synthetic Clinic" status=suspended`);
    expect(await run(['activate', '--id', t, '--by', 'ops'])).toBe(0);
    expect(await run(['suspend', '--id', 'not-registered', '--by', 'ops'])).toBe(1);
  });

  it('the operator cannot grant a membership into an unregistered organization (the command says to register it first)', async () => {
    await expect(owner((c) => new PgMembershipAdmin(c).grant({ tenantId: id('unregistered'), sub: 'p', roles: ['reader'], by: 'ops', reason: 'test' }))).rejects.toMatchObject({ failure: 'unknown-tenant' });
  });
});

describe('invitations', () => {
  const digest = new InvitationDigest();
  const create = (tenant: string, admin: string, email: string, roles: string[] = ['clinician']) =>
    asApplication(tenant, admin, async (c) => (await c.query('SELECT invitation_create($1, $2, $3::text[]) AS id', [digest.digest(email), digest.hint(email), roles])).rows[0].id as string);

  it('store a keyed digest and a hint, never the address, and are read-only to the application', async () => {
    const { tenant, admin } = await organization();
    const email = `private.${randomUUID().slice(0, 6)}@example.test`;
    const invitation = await create(tenant, admin, email);
    const dump = await owner(async (c) => JSON.stringify((await c.query(`SELECT * FROM invitations WHERE id = $1`, [invitation])).rows));
    expect(dump).not.toContain(email);
    expect(dump).not.toContain('private.');
    expect(digest.hint(email)).toMatch(/^p\*\*\*@example\.test$/);
    expect((await owner(async (c) => (await c.query(`SELECT length(email_digest) AS n FROM invitations WHERE id = $1`, [invitation])).rows[0])).n).toBe(32);
    await expect(asApplication(tenant, admin, (c) => c.query(`UPDATE invitations SET status = 'cancelled' WHERE id = $1`, [invitation]))).rejects.toMatchObject({ code: '42501' });
  });

  it('allow one pending invitation per address per organization, the same address in two organizations, and a new one after cancelling', async () => {
    const a = await organization();
    const b = await organization();
    const email = `dup.${randomUUID().slice(0, 6)}@example.test`;
    const first = await create(a.tenant, a.admin, email);
    await expect(create(a.tenant, a.admin, email)).rejects.toMatchObject({ code: '23505', constraint: 'invitations_one_pending_uq' });
    await create(b.tenant, b.admin, email);
    await asApplication(a.tenant, a.admin, (c) => c.query('SELECT invitation_cancel($1)', [first]));
    await create(a.tenant, a.admin, email);
  });

  it('cancel only an invitation of the bound organization, once (invitation-not-found otherwise)', async () => {
    const a = await organization();
    const b = await organization();
    const mine = await create(a.tenant, a.admin, `own.${randomUUID().slice(0, 6)}@example.test`);
    await expect(asApplication(b.tenant, b.admin, (c) => c.query('SELECT invitation_cancel($1)', [mine]))).rejects.toMatchObject({ message: 'invitation-not-found' });
    await asApplication(a.tenant, a.admin, (c) => c.query('SELECT invitation_cancel($1)', [mine]));
    await expect(asApplication(a.tenant, a.admin, (c) => c.query('SELECT invitation_cancel($1)', [mine]))).rejects.toMatchObject({ message: 'invitation-not-found' });
    await expect(owner((c) => c.query(`UPDATE invitations SET status = 'pending' WHERE id = $1`, [mine]))).rejects.toMatchObject({ code: '23000' }); // a decided invitation cannot change
    await expect(owner((c) => c.query(`DELETE FROM invitations WHERE id = $1`, [mine]))).rejects.toMatchObject({ code: '23000' });
  });

  it('stop at 100 pending invitations; one that has expired no longer counts', async () => {
    const { tenant, admin } = await organization();
    const seed = (count: number, expires: string) =>
      owner((c) =>
        c.query(
          `INSERT INTO invitations (tenant_id, email_digest, email_hint, roles, created_by, expires_at)
           SELECT $1, sha256(($3 || g::text)::bytea), 'x***@y', '{reader}', 'seed', ${expires} FROM generate_series(1, $2::int) g`,
          [tenant, count, randomUUID()],
        ),
      );
    await seed(99, `now() + interval '1 day'`);
    await seed(1, `now() - interval '1 minute'`); // expired: not counted
    await create(tenant, admin, `fits.${randomUUID().slice(0, 6)}@example.test`); // the 100th live one
    await expect(create(tenant, admin, `over.${randomUUID().slice(0, 6)}@example.test`)).rejects.toMatchObject({ message: 'invitation-limit' });
  });

  it('are fulfilled by the operator: the address must match, the roles are the invited ones, and it works once', async () => {
    const { tenant, admin } = await organization();
    const email = `fulfil.${randomUUID().slice(0, 6)}@example.test`;
    const invitation = await create(tenant, admin, email, ['clinician', 'reviewer']);
    const lines: string[] = [];
    const run = (args: string[]) => owner((c) => runInvite(new PgInvitationAdmin(c, digest), args, (l) => lines.push(l)));
    const person = id('new-person');
    expect(await run(['fulfil', '--id', invitation, '--email', 'someone.else@example.test', '--sub', person, '--by', 'ops'])).toBe(1);
    expect(await rolesOf(tenant, person)).toBeUndefined(); // a wrong address grants nothing
    expect(await run(['fulfil', '--id', invitation, '--email', email.toUpperCase(), '--sub', person, '--by', 'ops'])).toBe(0);
    expect(await rolesOf(tenant, person)).toMatchObject({ roles: ['clinician', 'reviewer'], status: 'active' });
    expect(await run(['fulfil', '--id', invitation, '--email', email, '--sub', id('again'), '--by', 'ops'])).toBe(1); // only once
    expect(await run(['list', '--tenant', tenant])).toBe(0);
    expect(lines.join('\n')).toContain('status=fulfilled');
    expect(lines.join('\n')).not.toContain(email);
    expect((await owner(async (c) => (await c.query(`SELECT status, fulfilled_sub FROM invitations WHERE id = $1`, [invitation])).rows[0]))).toEqual({ status: 'fulfilled', fulfilled_sub: person });
  });

  it('a cancelled or expired invitation cannot be fulfilled, and a failed grant leaves the invitation pending', async () => {
    const { tenant, admin } = await organization();
    const email = `fail.${randomUUID().slice(0, 6)}@example.test`;
    const cancelled = await create(tenant, admin, email);
    await asApplication(tenant, admin, (c) => c.query('SELECT invitation_cancel($1)', [cancelled]));
    const run = (args: string[]) => owner((c) => runInvite(new PgInvitationAdmin(c, digest), args, () => undefined));
    expect(await run(['fulfil', '--id', cancelled, '--email', email, '--sub', id('p'), '--by', 'ops'])).toBe(1);

    const open = await create(tenant, admin, email);
    const taken = id('taken');
    await grant(tenant, taken, ['reader']); // already an active member: the grant is refused
    expect(await run(['fulfil', '--id', open, '--email', email, '--sub', taken, '--by', 'ops'])).toBe(1);
    expect((await owner(async (c) => (await c.query(`SELECT status FROM invitations WHERE id = $1`, [open])).rows[0])).status).toBe('pending');
  });
});
