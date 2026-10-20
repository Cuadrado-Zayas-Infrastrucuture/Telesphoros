import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * DATA-01 slice 1 (specs/001-tenant-capability, migration 0028): the tenant capability exists, only the issuer can mint one, and the database resolves
 * it. Nothing reads it yet, so the forged-tenant read is still open and this spec says so on purpose (T007); slice 5 turns that assertion around.
 *
 * Every login here is a REAL login (a member of one NOLOGIN group, not a superuser using SET ROLE), as in the 2026-10-19 probe P7. Data is synthetic:
 * org-alpha has 4 patients, org-beta has 1. Counts are written by hand.
 */
jest.setTimeout(60_000);

type Settings = Record<string, string>;
let db: EphemeralDatabase;

const token = () => randomBytes(32).toString('base64url');
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: { code?: string }) => e.code);

/** Runs `work` on its own connection as `url`, inside one transaction with these transaction-local settings, then rolls back. */
async function as<T>(url: string, settings: Settings, work: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
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
const one = async <T>(url: string, settings: Settings, sql: string, params: unknown[] = []): Promise<T> =>
  as(url, settings, async (c) => Object.values((await c.query(sql, params)).rows[0] as object)[0] as T);
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);

/** Mints through the issuer login (committed, as the real issuer does before the API opens its transaction). */
async function issue(input: { tenant?: string; sub?: string; version?: number; purpose?: string; hash?: Buffer; request?: string | null } = {}) {
  const value = token();
  const c = new Client({ connectionString: db.issuerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ expires_at: Date | null; refusal: string | null }>('SELECT * FROM tenant_capability_issue($1, $2, $3, $4, $5, $6)', [
      input.tenant ?? 'org-alpha', input.sub ?? 'alice', input.version ?? 1, input.purpose ?? 'request', input.hash ?? hashOf(value), input.request === undefined ? 'req-00000001' : input.request,
    ]);
    return { token: value, ...rows[0]! };
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await createEphemeralDatabase();
  await owner(async (c) => {
    for (const tenant of ['org-alpha', 'org-beta', 'org-gamma']) await registerTenantRow(c, tenant);
    await c.query(`UPDATE tenants SET status = 'suspended', changed_by = 'test' WHERE id = 'org-gamma'`);
    for (const [tenant, sub, status] of [['org-alpha', 'alice', 'active'], ['org-beta', 'bob', 'active'], ['org-alpha', 'carol', 'removed'], ['org-gamma', 'gina', 'active']]) {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, $3, ARRAY['clinician'], 'test')`, [tenant, sub, status]);
    }
    for (const [tenant, n] of [['org-alpha', 4], ['org-beta', 1]] as const) {
      for (let i = 0; i < n; i += 1) await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, 'test', $2)`, [tenant, `SYN-${tenant}-${i}`]);
    }
  });
});
afterAll(async () => {
  await db.drop();
});

describe('the login under test is the application, not a superuser', () => {
  it('has no superuser or BYPASSRLS, and is a member of telesphoros_app', async () => {
    const row = await as(db.appUrl, {}, async (c) => (await c.query(`SELECT rolsuper, rolbypassrls, pg_has_role(current_user, 'telesphoros_app', 'MEMBER') AS app FROM pg_roles WHERE rolname = current_user`)).rows[0]);
    expect(row).toEqual({ rolsuper: false, rolbypassrls: false, app: true });
  });
});

describe('DATA-01 is still open after slice 1 (no policy changes yet)', () => {
  const patients = (settings: Settings) => one<number>(db.appUrl, settings, 'SELECT count(*)::int FROM patients');

  it('the binding mode is guc', async () => {
    expect(await owner(async (c) => (await c.query('SELECT mode FROM tenant_binding_mode')).rows)).toEqual([{ mode: 'guc' }]);
  });

  it('a forged tenant setting still reads the other organization (open on purpose; slice 5 inverts this)', async () => {
    expect(await patients({})).toBe(0); // control: no setting, no rows
    expect(await patients({ 'app.current_tenant_id': 'org-alpha' })).toBe(4);
    expect(await patients({ 'app.current_tenant_id': 'org-beta' })).toBe(1); // DATA-01: nothing proves the login belongs to org-beta
  });

  it('a capability alone binds nothing yet: the policies still read only the setting', async () => {
    const { token: value } = await issue();
    expect(await patients({ 'app.capability': value })).toBe(0);
  });
});

describe('only the issuer can mint, and nobody else can read or change the capability tables', () => {
  const others = () => [['app', db.appUrl], ['worker', db.workerUrl], ['verifier', db.verifierUrl], ['operator', db.operatorUrl], ['auditor', db.auditorUrl]] as const;
  const statements = [
    'SELECT * FROM tenant_capabilities',
    `INSERT INTO tenant_capabilities (token_hash, tenant_id, sub, membership_version, purpose, issued_at, expires_at) VALUES (sha256('x'), 'org-alpha', 'alice', 1, 'request', now(), now() + interval '1 hour')`,
    'SELECT * FROM capability_issuance_log',
    'SELECT * FROM capability_purposes',
    'SELECT * FROM tenant_binding_mode',
    `UPDATE tenant_binding_mode SET mode = 'guc'`,
    `UPDATE capability_purposes SET enforce_limits = false`,
    `SELECT * FROM tenant_capability_issue('org-beta', 'bob', 1, 'request', sha256('x'), NULL)`,
    'SELECT tenant_capabilities_sweep(10)',
  ];

  it.each(statements)('every other login is refused: %s', async (sql) => {
    for (const [name, url] of others()) expect([name, await code(as(url, {}, (c) => c.query(sql)))]).toEqual([name, '42501']);
  });

  it('the issuer cannot read what it writes, or any clinical table', async () => {
    for (const sql of ['SELECT * FROM tenant_capabilities', 'SELECT * FROM capability_issuance_log', 'SELECT * FROM tenant_binding_mode', 'SELECT * FROM patients', 'SELECT * FROM tenant_memberships']) {
      expect([sql, await code(as(db.issuerUrl, {}, (c) => c.query(sql)))]).toEqual([sql, '42501']);
    }
  });

  it('positive control: the issuer mints for an active member', async () => {
    const result = await issue();
    expect(result.refusal).toBeNull();
    expect(result.expires_at).toBeInstanceOf(Date);
  });
});

describe('issuing', () => {
  it('stamps both times from the database clock, lives 60 s, and stores only the hash', async () => {
    const before = await owner(async (c) => (await c.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t);
    const result = await issue({ request: 'req-clock-01' });
    const after = await owner(async (c) => (await c.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t);
    const row = await owner(async (c) => (await c.query(`SELECT *, row_to_json(c)::text AS whole FROM tenant_capabilities c WHERE token_hash = $1`, [hashOf(result.token)])).rows[0]);
    expect(row).toMatchObject({ tenant_id: 'org-alpha', sub: 'alice', membership_version: '1', purpose: 'request', request_id: 'req-clock-01', revoked_at: null });
    expect(row.issued_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.issued_at.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(row.expires_at.getTime() - row.issued_at.getTime()).toBe(60_000);
    expect(result.expires_at!.getTime()).toBe(row.expires_at.getTime());
    expect(row.whole).not.toContain(result.token);
  });

  it.each([
    ['a removed person', { sub: 'carol' }, 'membership-not-current'],
    ['a stale membership version', { version: 2 }, 'membership-not-current'],
    ['a person of another organization', { tenant: 'org-beta' }, 'membership-not-current'],
    ['a suspended organization', { tenant: 'org-gamma', sub: 'gina' }, 'tenant-inactive'],
    ['an unknown organization', { tenant: 'org-nowhere' }, 'tenant-inactive'],
    ['an unknown purpose', { purpose: 'anything' }, 'unknown-purpose'],
    ['a hash that is not 32 bytes', { hash: randomBytes(31) }, 'malformed'],
  ] as const)('refuses %s, mints nothing, and logs the refusal', async (_why, input, reason) => {
    const request = `req-${randomBytes(6).toString('hex')}`;
    const result = await issue({ ...input, request });
    expect(result).toMatchObject({ expires_at: null, refusal: reason });
    const rows = await owner(async (c) => ({
      minted: (await c.query('SELECT count(*)::int AS n FROM tenant_capabilities WHERE request_id = $1', [request])).rows[0].n,
      logged: (await c.query('SELECT outcome, reason FROM capability_issuance_log WHERE request_id = $1', [request])).rows,
    }));
    expect(rows).toEqual({ minted: 0, logged: [{ outcome: 'refused', reason }] });
  });

  it('logs every issuance, and the log cannot be changed afterwards', async () => {
    const request = `req-${randomBytes(6).toString('hex')}`;
    await issue({ request });
    await owner(async (c) => {
      expect((await c.query('SELECT outcome, reason, tenant_id, sub FROM capability_issuance_log WHERE request_id = $1', [request])).rows).toEqual([{ outcome: 'issued', reason: null, tenant_id: 'org-alpha', sub: 'alice' }]);
      expect(await code(c.query('UPDATE capability_issuance_log SET outcome = $1 WHERE request_id = $2', ['refused', request]))).not.toBe('ok');
      expect(await code(c.query('DELETE FROM capability_issuance_log WHERE request_id = $1', [request]))).not.toBe('ok');
    });
  });

  it('rate limits are counted but not enforced by default, and refuse once enforcement is switched on', async () => {
    await owner((c) => c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-beta', 'rita', 'active', ARRAY['reader'], 'test')`));
    await owner((c) => c.query(`UPDATE capability_purposes SET burst_limit = 2 WHERE purpose = 'request'`));
    try {
      const counted = [await issue({ tenant: 'org-beta', sub: 'rita' }), await issue({ tenant: 'org-beta', sub: 'rita' }), await issue({ tenant: 'org-beta', sub: 'rita' })];
      expect(counted.map((r) => r.refusal)).toEqual([null, null, null]);
      const flags = await owner(async (c) => (await c.query(`SELECT over_limit FROM capability_issuance_log WHERE sub = 'rita' ORDER BY seq`)).rows.map((r) => r.over_limit));
      expect(flags).toEqual([false, false, true]);
      await owner((c) => c.query(`UPDATE capability_purposes SET enforce_limits = true WHERE purpose = 'request'`));
      expect((await issue({ tenant: 'org-beta', sub: 'rita' })).refusal).toBe('rate-limited');
    } finally {
      await owner((c) => c.query(`UPDATE capability_purposes SET burst_limit = 120, enforce_limits = false WHERE purpose = 'request'`));
    }
  });
});

describe('resolving a capability: app_tenant() and app_actor()', () => {
  const resolve = (settings: Settings) => as(db.appUrl, settings, async (c) => (await c.query('SELECT app_tenant() AS tenant, app_actor() AS actor')).rows[0]);

  it('a valid capability resolves to its organization and person', async () => {
    const { token: value } = await issue();
    expect(await resolve({ 'app.capability': value })).toEqual({ tenant: 'org-alpha', actor: 'alice' });
    expect(await resolve({ 'app.capability': value, 'app.current_tenant_id': 'org-alpha' })).toEqual({ tenant: 'org-alpha', actor: 'alice' });
  });

  it('the person comes from the capability, not from the actor setting', async () => {
    const { token: value } = await issue();
    expect(await resolve({ 'app.capability': value, 'app.current_actor': 'mallory' })).toEqual({ tenant: 'org-alpha', actor: 'alice' });
  });

  it('a capability for one organization and a setting for another resolve to nothing (fail closed, no winner)', async () => {
    const { token: value } = await issue();
    expect((await resolve({ 'app.capability': value, 'app.current_tenant_id': 'org-beta' })).tenant).toBeNull();
  });

  it('a forged, oversized, expired or revoked token resolves to nothing, and does not fall back to the setting', async () => {
    const setting = { 'app.current_tenant_id': 'org-alpha' };
    expect(await resolve({ ...setting, 'app.capability': token() })).toEqual({ tenant: null, actor: null });
    expect(await resolve({ ...setting, 'app.capability': 'x'.repeat(200) })).toEqual({ tenant: null, actor: null });
    const expired = await issue();
    await owner((c) => c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE token_hash = $1`, [hashOf(expired.token)]));
    expect(await resolve({ ...setting, 'app.capability': expired.token })).toEqual({ tenant: null, actor: null });
    const revoked = await issue();
    await owner((c) => c.query('UPDATE tenant_capabilities SET revoked_at = clock_timestamp() WHERE token_hash = $1', [hashOf(revoked.token)]));
    expect(await resolve({ ...setting, 'app.capability': revoked.token })).toEqual({ tenant: null, actor: null });
  });

  it('with no capability, only the guc and dual modes fall back to the settings', async () => {
    const settings = { 'app.current_tenant_id': 'org-beta', 'app.current_actor': 'bob' };
    expect(await resolve(settings)).toEqual({ tenant: 'org-beta', actor: 'bob' }); // guc: today's behaviour
    try {
      await owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = 'dual'`));
      expect(await resolve(settings)).toEqual({ tenant: 'org-beta', actor: 'bob' });
      await owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = 'capability'`));
      expect(await resolve(settings)).toEqual({ tenant: null, actor: null });
      const { token: value } = await issue();
      expect(await resolve({ 'app.capability': value })).toEqual({ tenant: 'org-alpha', actor: 'alice' }); // control: a capability still works
    } finally {
      await owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = 'guc'`));
    }
  });

  it('the capability setting is transaction-local: the next transaction on the same connection does not see it', async () => {
    const { token: value } = await issue();
    const c = new Client({ connectionString: db.appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.capability', $1, true)`, [value]);
      expect((await c.query('SELECT app_tenant() AS t')).rows[0].t).toBe('org-alpha');
      await c.query('COMMIT');
      expect((await c.query('SELECT app_tenant() AS t')).rows[0].t).toBeNull();
    } finally {
      await c.end();
    }
  });
});

describe('sweeping expired capabilities', () => {
  it('removes rows past their expiry plus grace, keeps live ones, and only the jobs role may run it', async () => {
    const live = await issue();
    const old = await issue();
    await owner((c) => c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '1 hour', expires_at = expires_at - interval '1 hour' WHERE token_hash = $1`, [hashOf(old.token)]));
    const removed = await owner(async (c) => (await c.query('SELECT tenant_capabilities_sweep(1000) AS n')).rows[0].n);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await owner(async (c) => (await c.query('SELECT token_hash FROM tenant_capabilities WHERE token_hash = ANY($1)', [[hashOf(live.token), hashOf(old.token)]])).rows.map((r) => r.token_hash.toString('hex')));
    expect(left).toEqual([hashOf(live.token).toString('hex')]);
    expect(await owner(async (c) => (await c.query(`SELECT has_function_privilege('telesphoros_jobs', 'tenant_capabilities_sweep(integer)', 'EXECUTE') AS ok`)).rows[0].ok)).toBe(true);
  });
});

describe('reverting 0028', () => {
  it('refuses while the issuance log holds a record, reverts with the explicit setting, and re-applies', async () => {
    await issue();
    await expect(owner((c) => migrateDown(c, 1))).rejects.toThrow(/Refusing to drop the capability issuance log/);
    expect(await owner(async (c) => (await c.query(`SELECT to_regclass('public.tenant_capabilities') IS NOT NULL AS ok`)).rows[0].ok)).toBe(true);
    expect(await owner(async (c) => {
      await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
      return migrateDown(c, 1);
    })).toEqual(['0028']);
    expect(await owner(async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('app_tenant', 'app_actor', 'tenant_capability_issue', 'tenant_capabilities_sweep')`)).rows[0].n)).toBe(0);
    expect(await owner((c) => migrateUp(c))).toEqual(['0028']); // control: it applies again
  });
});
