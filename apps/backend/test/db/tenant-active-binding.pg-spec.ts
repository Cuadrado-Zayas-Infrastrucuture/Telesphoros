import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * Migration 0047: a suspended organization is stopped by the database. app_tenant() answers NULL for a registered organization that is not active, so every
 * policy and definer function that binds through it fails closed; the authority tables and four functions read app_tenant_bound() and still see the organization,
 * so the refusal can be read, recorded and the person signed out. Synthetic data. Each refusal is paired with a positive control in the same run.
 */
jest.setTimeout(60_000);

let db: EphemeralDatabase;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const token = () => randomBytes(32).toString('base64url');
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();

async function asApp<T>(settings: Record<string, string>, work: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [key, value] of Object.entries(settings)) await c.query('SELECT set_config($1, $2, true)', [key, value]);
    return await work(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}
const patients = (settings: Record<string, string>) => asApp(settings, async (c) => (await c.query('SELECT count(*)::int AS n FROM patients')).rows[0].n as number);
const setStatus = (tenant: string, status: 'active' | 'suspended') =>
  owner((c) => c.query('UPDATE tenants SET status = $2, changed_by = $3 WHERE id = $1', [tenant, status, 'test-operator']));

async function issue(tenant: string, sub: string) {
  const value = token();
  const c = new Client({ connectionString: db.issuerUrl });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT * FROM tenant_capability_issue_current($1, $2, $3, $4, $5)', [tenant, sub, 'request', hashOf(value), 'req-active-0001']);
    expect(rows[0].refusal).toBeNull();
    return value;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await createEphemeralDatabase();
  await owner(async (c) => {
    await registerTenantRow(c, 'org-live');
    await registerTenantRow(c, 'org-held');
    for (const [tenant, sub] of [['org-live', 'carol'], ['org-held', 'alice']]) {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['clinician'], 'test')`, [tenant, sub]);
      await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, 'test', 'SYN-1')`, [tenant]);
    }
  });
});
afterAll(async () => {
  await db.drop();
});
afterEach(async () => {
  await setStatus('org-held', 'active');
});

describe('a suspended organization reads and writes nothing (0047)', () => {
  it('through the setting (dual mode): visible while active, invisible and unwritable once suspended, visible again on reinstatement', async () => {
    const as = { 'app.current_tenant_id': 'org-held', 'app.current_actor': 'alice' };
    expect(await patients(as)).toBe(1); // positive control
    await setStatus('org-held', 'suspended');
    expect(await patients(as)).toBe(0);
    await expect(asApp(as, (c) => c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('org-held', 'alice', 'SYN-2')`))).rejects.toMatchObject({ code: '42501' });
    await setStatus('org-held', 'active');
    expect(await patients(as)).toBe(1);
    await expect(asApp(as, (c) => c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('org-held', 'alice', 'SYN-2')`))).resolves.toBeDefined(); // control: writable when active
  });

  it('a capability minted while active stops binding the moment the organization is suspended (the window the issuer could not close)', async () => {
    const live = await issue('org-held', 'alice');
    expect(await patients({ 'app.capability': live })).toBe(1);
    await setStatus('org-held', 'suspended');
    expect(await patients({ 'app.capability': live })).toBe(0);
    await setStatus('org-held', 'active');
    expect(await patients({ 'app.capability': live })).toBe(1); // the same capability binds again, nothing was revoked
  });

  it('another organization is unaffected (control)', async () => {
    await setStatus('org-held', 'suspended');
    expect(await patients({ 'app.current_tenant_id': 'org-live', 'app.current_actor': 'carol' })).toBe(1);
  });
});

describe('what a suspended organization must still be able to do (0047)', () => {
  it('the application can read its own organization row and membership, so admission can see it is suspended', async () => {
    await setStatus('org-held', 'suspended');
    const as = { 'app.current_tenant_id': 'org-held', 'app.current_actor': 'alice' };
    const status = await asApp(as, async (c) => (await c.query('SELECT status FROM tenants')).rows.map((r) => r.status));
    expect(status).toEqual(['suspended']);
    expect(await asApp(as, async (c) => (await c.query('SELECT count(*)::int AS n FROM tenant_memberships')).rows[0].n)).toBe(1);
  });

  it('the refusal can be recorded (security_event_append) and the person can be signed out (member_sign_out)', async () => {
    await setStatus('org-held', 'suspended');
    const as = { 'app.current_tenant_id': 'org-held', 'app.current_actor': 'alice' };
    await asApp(as, (c) => c.query(`SELECT security_event_append('access.refused', 'refused', 'person', 'alice', '{"reason":"tenant-suspended"}'::jsonb, 'req-active-0002')`));
    await asApp(as, (c) => c.query('SELECT member_sign_out()'));
  });

  it('but the same call from an ACTIVE organization works too, and an unbound request still reaches nothing (controls)', async () => {
    const as = { 'app.current_tenant_id': 'org-live', 'app.current_actor': 'carol' };
    await asApp(as, (c) => c.query('SELECT member_sign_out()'));
    expect(await patients({})).toBe(0);
  });
});

describe('the catalog', () => {
  it('app_tenant_bound() has the same grantees as app_tenant(), and nobody else', async () => {
    const acl = (name: string) => owner(async (c) => (await c.query(`SELECT string_agg(coalesce(nullif(pg_get_userbyid(a.grantee), ''), 'PUBLIC'), ',' ORDER BY 1) AS g
      FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [name])).rows[0].g as string);
    expect(await acl('app_tenant_bound')).toBe(await acl('app_tenant'));
    expect(await acl('app_tenant_bound')).not.toContain('PUBLIC');
  });
});
