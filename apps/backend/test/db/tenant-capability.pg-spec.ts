import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';
import { revertAbove, revertThrough, versionsFrom } from '../helpers/migration-history';

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
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

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
      input.tenant ?? 'org-alpha',
      input.sub ?? 'alice',
      input.version ?? 1,
      input.purpose ?? 'request',
      input.hash ?? hashOf(value),
      input.request === undefined ? 'req-00000001' : input.request,
    ]);
    return { token: value, ...rows[0]! };
  } finally {
    await c.end();
  }
}

/** Mints through the issuer login with the CURRENT-version function (migration 0031): the caller no longer names a version. */
async function issueCurrent(input: { tenant?: string | null; sub?: string | null; purpose?: string; hash?: Buffer | null; request?: string | null } = {}) {
  const value = token();
  const c = new Client({ connectionString: db.issuerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ expires_at: Date | null; refusal: string | null; membership_version: string | null }>(
      'SELECT * FROM tenant_capability_issue_current($1, $2, $3, $4, $5)',
      [
        input.tenant === undefined ? 'org-alpha' : input.tenant,
        input.sub === undefined ? 'alice' : input.sub,
        input.purpose ?? 'request',
        input.hash === undefined ? hashOf(value) : input.hash,
        input.request === undefined ? 'req-00000002' : input.request,
      ],
    );
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
    for (const [tenant, sub, status] of [
      ['org-alpha', 'alice', 'active'],
      ['org-beta', 'bob', 'active'],
      ['org-alpha', 'carol', 'removed'],
      ['org-gamma', 'gina', 'active'],
    ]) {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, $3, ARRAY['clinician'], 'test')`, [tenant, sub, status]);
    }
    for (const [tenant, n] of [
      ['org-alpha', 4],
      ['org-beta', 1],
    ] as const) {
      for (let i = 0; i < n; i += 1) await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, 'test', $2)`, [tenant, `SYN-${tenant}-${i}`]);
    }
  });
});
afterAll(async () => {
  await db.drop();
});

describe('the login under test is the application, not a superuser', () => {
  it('has no superuser or BYPASSRLS, and is a member of telesphoros_app', async () => {
    const row = await as(
      db.appUrl,
      {},
      async (c) =>
        (await c.query(`SELECT rolsuper, rolbypassrls, pg_has_role(current_user, 'telesphoros_app', 'MEMBER') AS app FROM pg_roles WHERE rolname = current_user`)).rows[0],
    );
    expect(row).toEqual({ rolsuper: false, rolbypassrls: false, app: true });
  });
});

describe('DATA-01 slice 3 PR B (migration 0032): dual mode, the policies read app_tenant()', () => {
  const patients = (settings: Settings) => one<number>(db.appUrl, settings, 'SELECT count(*)::int FROM patients');

  it('the binding mode is dual (0032 moved it from guc as its last statement)', async () => {
    expect(await owner(async (c) => (await c.query('SELECT mode FROM tenant_binding_mode')).rows)).toEqual([{ mode: 'dual' }]);
  });

  it('without a capability, dual keeps the setting working, so a forged setting still reads the other organization (the fallback; slice 6 removes it)', async () => {
    expect(await patients({})).toBe(0); // control: no setting, no rows
    expect(await patients({ 'app.current_tenant_id': 'org-alpha' })).toBe(4);
    expect(await patients({ 'app.current_tenant_id': 'org-beta' })).toBe(1); // dual: nothing proves the login belongs to org-beta
  });

  it('a capability binds the policies: its own organization reads 4, and a foreign setting beside it reads nothing (fails closed, no winner)', async () => {
    const { token: value } = await issue(); // org-alpha
    expect(await patients({ 'app.capability': value })).toBe(4); // the capability alone is enough
    expect(await patients({ 'app.capability': value, 'app.current_tenant_id': 'org-alpha' })).toBe(4); // control: a matching setting
    expect(await patients({ 'app.capability': value, 'app.current_tenant_id': 'org-beta' })).toBe(0); // the mismatch fails closed
    const { token: beta } = await issue({ tenant: 'org-beta', sub: 'bob' });
    expect(await patients({ 'app.capability': beta })).toBe(1);
  });
});

describe('only the issuer can mint, and nobody else can read or change the capability tables', () => {
  const others = () =>
    [
      ['app', db.appUrl],
      ['worker', db.workerUrl],
      ['verifier', db.verifierUrl],
      ['operator', db.operatorUrl],
      ['auditor', db.auditorUrl],
    ] as const;
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
    for (const sql of [
      'SELECT * FROM tenant_capabilities',
      'SELECT * FROM capability_issuance_log',
      'SELECT * FROM tenant_binding_mode',
      'SELECT * FROM patients',
      'SELECT * FROM tenant_memberships',
    ]) {
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
    const row = await owner(
      async (c) => (await c.query(`SELECT *, row_to_json(c)::text AS whole FROM tenant_capabilities c WHERE token_hash = $1`, [hashOf(result.token)])).rows[0],
    );
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
      expect((await c.query('SELECT outcome, reason, tenant_id, sub FROM capability_issuance_log WHERE request_id = $1', [request])).rows).toEqual([
        { outcome: 'issued', reason: null, tenant_id: 'org-alpha', sub: 'alice' },
      ]);
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
    await owner((c) =>
      c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE token_hash = $1`, [
        hashOf(expired.token),
      ]),
    );
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
      await owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = 'dual'`));
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
    await owner((c) =>
      c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '1 hour', expires_at = expires_at - interval '1 hour' WHERE token_hash = $1`, [hashOf(old.token)]),
    );
    const removed = await owner(async (c) => (await c.query('SELECT tenant_capabilities_sweep(1000) AS n')).rows[0].n);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await owner(async (c) =>
      (await c.query('SELECT token_hash FROM tenant_capabilities WHERE token_hash = ANY($1)', [[hashOf(live.token), hashOf(old.token)]])).rows.map((r) =>
        r.token_hash.toString('hex'),
      ),
    );
    expect(left).toEqual([hashOf(live.token).toString('hex')]);
    expect(await owner(async (c) => (await c.query(`SELECT has_function_privilege('telesphoros_jobs', 'tenant_capabilities_sweep(integer)', 'EXECUTE') AS ok`)).rows[0].ok)).toBe(
      true,
    );
  });
});

describe('issuing at the CURRENT membership version (migration 0031, DATA-01 slice 3 PR A)', () => {
  const sub = 'dora';
  const request = () => `req-${randomBytes(6).toString('hex')}`;
  const versionOf = (who: string, tenant = 'org-alpha') =>
    owner(async (c) => (await c.query<{ version: string }>('SELECT version FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2', [tenant, who])).rows[0]!.version);
  const logFor = (id: string) =>
    owner(async (c) => (await c.query('SELECT outcome, reason, membership_version, tenant_id, sub FROM capability_issuance_log WHERE request_id = $1', [id])).rows);
  const mintedFor = (id: string) => owner(async (c) => (await c.query('SELECT count(*)::int AS n FROM tenant_capabilities WHERE request_id = $1', [id])).rows[0].n as number);

  beforeAll(async () => {
    await owner(async (c) => {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-alpha', $1, 'active', ARRAY['reader'], 'test')`, [sub]);
      // two changes, so the current version is not the first one (a function that always answered 1 would pass otherwise)
      await c.query(`UPDATE tenant_memberships SET roles = ARRAY['clinician'], changed_by = 'test' WHERE tenant_id = 'org-alpha' AND sub = $1`, [sub]);
      await c.query(`UPDATE tenant_memberships SET roles = ARRAY['reader', 'clinician'], changed_by = 'test' WHERE tenant_id = 'org-alpha' AND sub = $1`, [sub]);
    });
  });

  it('positive control: mints for an active member, stamps the version it read, and returns it', async () => {
    const current = await versionOf(sub);
    expect(Number(current)).toBeGreaterThanOrEqual(3);
    const id = request();
    const result = await issueCurrent({ sub, request: id });
    expect(result.refusal).toBeNull();
    expect(result.expires_at).toBeInstanceOf(Date);
    expect(result.membership_version).toBe(current);
    const row = await owner(
      async (c) => (await c.query('SELECT membership_version, tenant_id, sub, purpose FROM tenant_capabilities WHERE token_hash = $1', [hashOf(result.token)])).rows[0],
    );
    expect(row).toEqual({ membership_version: current, tenant_id: 'org-alpha', sub, purpose: 'request' });
    expect(await logFor(id)).toEqual([{ outcome: 'issued', reason: null, membership_version: current, tenant_id: 'org-alpha', sub }]);
  });

  it('follows the membership: after a change the next capability carries the new version, and the old one keeps the version it was issued at', async () => {
    const before = await issueCurrent({ sub });
    await owner((c) => c.query(`UPDATE tenant_memberships SET roles = ARRAY['reader'], changed_by = 'test' WHERE tenant_id = 'org-alpha' AND sub = $1`, [sub]));
    const after = await issueCurrent({ sub });
    expect(Number(after.membership_version)).toBe(Number(before.membership_version) + 1);
    expect(after.membership_version).toBe(await versionOf(sub));
    const stored = await owner(
      async (c) =>
        (
          await c.query('SELECT token_hash, membership_version FROM tenant_capabilities WHERE token_hash = ANY($1) ORDER BY issued_at', [
            [hashOf(before.token), hashOf(after.token)],
          ])
        ).rows,
    );
    expect(stored.map((r) => r.membership_version)).toEqual([before.membership_version, after.membership_version]);
  });

  it.each([
    ['a removed person', { sub: 'carol' }, 'membership-not-current'],
    ['a person of another organization', { tenant: 'org-beta' }, 'membership-not-current'],
    ['a person who never existed', { sub: 'nobody-at-all' }, 'membership-not-current'],
    ['a suspended organization', { tenant: 'org-gamma', sub: 'gina' }, 'tenant-inactive'],
    ['an unknown organization', { tenant: 'org-nowhere' }, 'tenant-inactive'],
    ['an unknown purpose', { purpose: 'anything' }, 'unknown-purpose'],
    ['a hash that is not 32 bytes', { hash: randomBytes(31) }, 'malformed'],
    ['no hash', { hash: null }, 'malformed'],
    ['no organization', { tenant: null }, 'malformed'],
    ['no person', { sub: null }, 'malformed'],
  ] as const)('refuses %s, mints nothing and logs one closed reason (then, as a control, the same login mints for an active member)', async (_why, input, reason) => {
    const id = request();
    const result = await issueCurrent({ ...input, request: id });
    expect(result).toMatchObject({ expires_at: null, refusal: reason, membership_version: null });
    expect(await mintedFor(id)).toBe(0);
    const logged = await logFor(id);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ outcome: 'refused', reason });
    // positive control in the same run: the refusal is about the input, not a dead function
    const control = request();
    expect((await issueCurrent({ sub, request: control })).refusal).toBeNull();
    expect(await mintedFor(control)).toBe(1);
  });

  it('logs a person with no active membership at version 0 (no membership has one), and an active member of an inactive organization at their real version', async () => {
    for (const input of [{ sub: 'carol' }, { sub: 'nobody-at-all' }, { tenant: 'org-beta' }] as const) {
      const id = request();
      expect((await issueCurrent({ ...input, request: id })).refusal).toBe('membership-not-current');
      expect((await logFor(id))[0]).toMatchObject({ membership_version: '0' });
    }
    const id = request();
    expect((await issueCurrent({ tenant: 'org-gamma', sub: 'gina', request: id })).refusal).toBe('tenant-inactive');
    expect((await logFor(id))[0]).toMatchObject({ membership_version: await versionOf('gina', 'org-gamma') }); // control: the log does hold real versions
  });

  it('a removed person is refused for the reason of the removal, not for a missing version (and is reinstated at a newer version)', async () => {
    await owner(async (c) => {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-alpha', 'erin', 'active', ARRAY['reader'], 'test')`);
    });
    expect((await issueCurrent({ sub: 'erin' })).refusal).toBeNull(); // control: active
    await owner((c) => c.query(`UPDATE tenant_memberships SET status = 'removed', changed_by = 'test' WHERE tenant_id = 'org-alpha' AND sub = 'erin'`));
    expect((await issueCurrent({ sub: 'erin' })).refusal).toBe('membership-not-current');
    await owner((c) => c.query(`UPDATE tenant_memberships SET status = 'active', changed_by = 'test' WHERE tenant_id = 'org-alpha' AND sub = 'erin'`));
    const back = await issueCurrent({ sub: 'erin' });
    expect(back.refusal).toBeNull();
    expect(back.membership_version).toBe(await versionOf('erin'));
  });

  it('rate limits still count for it (it goes through the same issue function), and a refusal by limit is logged', async () => {
    await owner((c) => c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-beta', 'sam', 'active', ARRAY['reader'], 'test')`));
    await owner((c) => c.query(`UPDATE capability_purposes SET burst_limit = 2, enforce_limits = true WHERE purpose = 'request'`));
    try {
      const results = [
        await issueCurrent({ tenant: 'org-beta', sub: 'sam' }),
        await issueCurrent({ tenant: 'org-beta', sub: 'sam' }),
        await issueCurrent({ tenant: 'org-beta', sub: 'sam' }),
      ];
      expect(results.map((r) => r.refusal)).toEqual([null, null, 'rate-limited']);
    } finally {
      await owner((c) => c.query(`UPDATE capability_purposes SET burst_limit = 120, enforce_limits = false WHERE purpose = 'request'`));
    }
  });

  it('only the issuer login may call it: every other login is refused, and the issuer succeeds in the same run', async () => {
    const sql = `SELECT * FROM tenant_capability_issue_current('org-beta', 'bob', 'request', sha256('x'), NULL)`;
    expect(await code(as(db.issuerUrl, {}, (c) => c.query(sql)))).toBe('ok'); // control
    for (const [name, url] of [
      ['app', db.appUrl],
      ['worker', db.workerUrl],
      ['verifier', db.verifierUrl],
      ['operator', db.operatorUrl],
      ['auditor', db.auditorUrl],
    ] as const) {
      expect([name, await code(as(url, {}, (c) => c.query(sql)))]).toEqual([name, '42501']);
    }
  });

  it('is a definer owned by the capability owner, with a fixed search path, and EXECUTE for the issuer group only (not PUBLIC)', async () => {
    const facts = await owner(
      async (c) =>
        (
          await c.query(`
      SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
             (SELECT array_agg((CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) ORDER BY a.grantee) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
        FROM pg_proc p WHERE p.proname = 'tenant_capability_issue_current' AND p.pronamespace = 'public'::regnamespace`)
        ).rows,
    );
    expect(facts).toEqual([{ owner: 'telesphoros_capability', definer: true, config: ['search_path=pg_catalog, pg_temp'], grantees: ['telesphoros_issuer'] }]);
  });
});

describe('app_capability_version() (migration 0031): the version a presented capability was issued at', () => {
  const versionFor = (settings: Settings) => as(db.appUrl, settings, async (c) => (await c.query<{ v: string | null }>('SELECT app_capability_version() AS v')).rows[0]!.v);
  const setting = { 'app.current_tenant_id': 'org-alpha' };

  beforeAll(async () => {
    await owner((c) => c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ('org-alpha', 'frank', 'active', ARRAY['reader'], 'test')`));
  });

  it("positive control: a valid capability answers the version it was issued at, not the membership's current one", async () => {
    const issued = await issueCurrent({ sub: 'frank' });
    await owner((c) => c.query(`UPDATE tenant_memberships SET roles = ARRAY['reader', 'clinician'], changed_by = 'test' WHERE tenant_id = 'org-alpha' AND sub = 'frank'`));
    const now = await owner(
      async (c) => (await c.query<{ version: string }>(`SELECT version FROM tenant_memberships WHERE tenant_id = 'org-alpha' AND sub = 'frank'`)).rows[0]!.version,
    );
    expect(Number(now)).toBeGreaterThan(Number(issued.membership_version));
    expect(await versionFor({ 'app.capability': issued.token })).toBe(issued.membership_version);
    expect(await versionFor({ 'app.capability': issued.token, ...setting })).toBe(issued.membership_version);
  });

  it('answers nothing for a forged, oversized, expired or revoked token, a mismatching tenant setting, or no token (each beside the valid one)', async () => {
    const valid = await issueCurrent();
    expect(await versionFor({ 'app.capability': valid.token })).toBe(valid.membership_version); // control
    expect(await versionFor({ 'app.capability': token(), ...setting })).toBeNull();
    expect(await versionFor({ 'app.capability': 'x'.repeat(200), ...setting })).toBeNull();
    expect(await versionFor({ 'app.capability': valid.token, 'app.current_tenant_id': 'org-beta' })).toBeNull(); // another organization named: no winner
    expect(await versionFor(setting)).toBeNull(); // the old setting alone carries no version
    expect(await versionFor({})).toBeNull();
    const expired = await issueCurrent();
    await owner((c) =>
      c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE token_hash = $1`, [
        hashOf(expired.token),
      ]),
    );
    expect(await versionFor({ 'app.capability': expired.token })).toBeNull();
    const revoked = await issueCurrent();
    expect(await versionFor({ 'app.capability': revoked.token })).toBe(revoked.membership_version); // control just before revoking
    await owner((c) => c.query('UPDATE tenant_capabilities SET revoked_at = clock_timestamp() WHERE token_hash = $1', [hashOf(revoked.token)]));
    expect(await versionFor({ 'app.capability': revoked.token })).toBeNull();
  });

  it('answers nothing without a token in every binding mode (there is no setting to fall back to), and a token still works in capability mode', async () => {
    const valid = await issueCurrent();
    try {
      for (const mode of ['guc', 'dual', 'capability']) {
        await owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = $1`, [mode]));
        expect([mode, await versionFor({ ...setting })]).toEqual([mode, null]);
        expect([mode, await versionFor({ 'app.capability': valid.token })]).toEqual([mode, valid.membership_version]);
      }
    } finally {
      await owner((c) => c.query(`UPDATE tenant_binding_mode SET mode = 'dual'`));
    }
  });

  it("the expiry is the database's statement clock, the same rule app_tenant() applies (they agree on every state above)", async () => {
    const live = await issueCurrent();
    const old = await issueCurrent();
    await owner((c) =>
      c.query(`UPDATE tenant_capabilities SET issued_at = issued_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE token_hash = $1`, [
        hashOf(old.token),
      ]),
    );
    for (const [who, expected] of [
      [live, 'org-alpha'],
      [old, null],
    ] as const) {
      const both = await as(db.appUrl, { 'app.capability': who.token }, async (c) => (await c.query('SELECT app_tenant() AS t, app_capability_version() AS v')).rows[0]);
      expect([both.t, both.v === null]).toEqual([expected, expected === null]);
    }
  });

  it('EXECUTE goes to the roles that already bind through app_tenant(), and never to PUBLIC: the verifier, operator, auditor and issuer logins are refused', async () => {
    const sql = 'SELECT app_capability_version()';
    for (const [name, url] of [
      ['app', db.appUrl],
      ['worker', db.workerUrl],
    ] as const)
      expect([name, await code(as(url, {}, (c) => c.query(sql)))]).toEqual([name, 'ok']); // controls
    for (const [name, url] of [
      ['verifier', db.verifierUrl],
      ['operator', db.operatorUrl],
      ['auditor', db.auditorUrl],
      ['issuer', db.issuerUrl],
    ] as const) {
      expect([name, await code(as(url, {}, (c) => c.query(sql)))]).toEqual([name, '42501']);
    }
    const grantees = (fn: string) =>
      owner(async (c) =>
        (
          await c.query<{ who: string }>(
            `
      SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) AS who FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1`,
            [fn],
          )
        ).rows.map((r) => r.who),
      );
    expect(await grantees('app_capability_version')).toEqual(await grantees('app_tenant'));
    expect(await grantees('app_capability_version')).not.toContain('PUBLIC');
    // the detector can see a PUBLIC grant: a function created without a REVOKE reports it
    await owner((c) => c.query('CREATE FUNCTION zz_public_control() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'));
    expect(await grantees('zz_public_control')).toContain('PUBLIC');
    await owner((c) => c.query('DROP FUNCTION zz_public_control()'));
  });
});

/** Everything the capability migrations leave in the catalog that a hand-written list could forget: functions with owner, flags, settings and ACL; table ACLs; policies. */
async function catalogSnapshot(c: Client): Promise<string[]> {
  const rows = await c.query<{ line: string }>(`
    SELECT 'fn ' || p.oid::regprocedure::text || ' owner=' || pg_get_userbyid(p.proowner) || ' definer=' || p.prosecdef || ' config=' || coalesce(p.proconfig::text, '-')
           || ' acl=' || coalesce((SELECT string_agg((CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a), '-') AS line
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'rel ' || c.relname || ' owner=' || pg_get_userbyid(c.relowner) || ' rls=' || c.relrowsecurity || ' acl=' || coalesce(c.relacl::text, '-')
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
    UNION ALL
    SELECT 'policy ' || tablename || '.' || policyname || ' ' || cmd || ' ' || roles::text FROM pg_policies WHERE schemaname = 'public'
    ORDER BY 1`);
  return rows.rows.map((r) => r.line);
}

describe('reverting 0031 and 0028', () => {
  it('0031 reverts to exactly the catalog of 0030 (functions, owners, grants, policies), re-applies to exactly the catalog it had, and the snapshot can tell a changed grant', async () => {
    const full = await owner(catalogSnapshot);
    expect(full.filter((l) => /^fn .*(tenant_capability_issue_current|app_capability_version)\(/.test(l))).toHaveLength(2);
    const through = revertThrough('tenant_capability_issue_current'); // this migration and anything above it
    expect(await owner((c) => migrateDown(c, through.steps))).toEqual(through.reverted);
    const down = await owner(catalogSnapshot);
    // 0032 through D01b (0055) go with 0031. H1, H3, H4 and D01b remove their request/receipt/cancellation/decision tables, policies and helpers; 0043's drop is undone below.
    const removed =
      /tenant_capability_issue_current|app_tenant_bound|app_capability_version|tenant_capability_bind_internal|member_sign_out|patient_merge_decisions_hold|patients_guard_delete|outbox_stats|patients_creation_request_guard|patient_identifiers_creation_request_guard|invitations_creation_request_guard|invitation_create_keyed|outbox_append\(text,uuid,text\)|agentic_explain_receipt|agentic_explain_identity|agentic_explain_run|agentic_explain_transition|evaluation_request|evaluation_job_fence|evaluation_job_cancel|evaluation_cancellation_check|evaluation_completion_check|clinician_result_decisions|clinician_decision_codes_valid/;
    expect(down.filter((l) => removed.test(l))).toEqual([]);
    // Reverting 0043 puts the dropped legacy table back (with its policy), so the reverted catalog has those two lines the head catalog lacks; nothing else moved.
    const restoredLegacyTable = (l: string) => l.startsWith('rel recommendations ') || l.startsWith('policy recommendations.');
    expect(down.filter(restoredLegacyTable)).toHaveLength(2);
    expect(full.filter(restoredLegacyTable)).toEqual([]);
    // 0046 (hardening 1) names the upload policies' roles and turns security_events row-level security on; reverting it restores the old lines, so those lines differ by design.
    const hardened = (l: string) => /^policy report_upload_(attempts|runs)\./.test(l) || /^policy security_events\./.test(l) || l.startsWith('rel security_events ');
    expect(down.filter((l) => /^policy report_upload_(attempts|runs)\./.test(l)).every((l) => l.endsWith('{public}'))).toBe(true);
    expect(full.filter((l) => /^policy report_upload_(attempts|runs)\./.test(l)).some((l) => l.includes('{public}'))).toBe(false);
    expect(full.filter((l) => !removed.test(l) && !hardened(l))).toEqual(down.filter((l) => !restoredLegacyTable(l) && !hardened(l)));
    expect(await owner((c) => migrateUp(c))).toEqual(versionsFrom('tenant_capability_issue_current'));
    expect(await owner(catalogSnapshot)).toEqual(full); // and re-applying 0043 drops the legacy table again
    // the snapshot is sensitive to the thing it guards: a grant to PUBLIC changes it
    await owner((c) => c.query('GRANT EXECUTE ON FUNCTION app_capability_version() TO PUBLIC'));
    expect(await owner(catalogSnapshot)).not.toEqual(full);
    await owner((c) => c.query('REVOKE EXECUTE ON FUNCTION app_capability_version() FROM PUBLIC'));
    expect(await owner(catalogSnapshot)).toEqual(full);
  });

  it('0028 refuses while the issuance log holds a record, reverts with the explicit setting, and re-applies', async () => {
    await issue();
    const aboveCapability = revertAbove('tenant_capability'); // whatever sits above 0028 (today the synthetic agentic migration) reverts freely while it is empty
    expect(await owner((c) => migrateDown(c, aboveCapability.steps))).toEqual(aboveCapability.reverted);
    await expect(owner((c) => migrateDown(c, 1))).rejects.toThrow(/Refusing to drop the capability issuance log/);
    expect(await owner(async (c) => (await c.query(`SELECT to_regclass('public.tenant_capabilities') IS NOT NULL AS ok`)).rows[0].ok)).toBe(true);
    expect(
      await owner(async (c) => {
        await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
        return migrateDown(c, 1);
      }),
    ).toEqual(['0028']);
    expect(
      await owner(
        async (c) =>
          (
            await c.query(
              `SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('app_tenant', 'app_actor', 'app_capability_version', 'tenant_capability_issue', 'tenant_capability_issue_current', 'tenant_capabilities_sweep')`,
            )
          ).rows[0].n,
      ),
    ).toBe(0);
    expect(await owner((c) => migrateUp(c))).toEqual(versionsFrom('tenant_capability')); // control: they apply again
  });
});
