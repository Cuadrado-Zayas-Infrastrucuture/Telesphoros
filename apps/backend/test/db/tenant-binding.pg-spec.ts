import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

/**
 * DATA-01 slice 3 PR B (specs/001-tenant-capability, migration 0032, tasks T020, T021, T024): the tenant binding policies and the definer functions
 * read the capability through app_tenant() and app_actor(), in mode 'dual' (the setting still works without a capability).
 *
 * Every login is a REAL login (a member of one NOLOGIN group), as in tenant-capability.pg-spec.ts. Data is synthetic: org-alpha has 4 patients,
 * org-beta has 1. Each control that must go red is paired with a positive control in the same run.
 */
jest.setTimeout(60_000);

type Settings = Record<string, string>;
let db: EphemeralDatabase;

const token = () => randomBytes(32).toString('base64url');
const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Runs `work` on its own connection as `url`, in one transaction with these transaction-local settings, then rolls back. */
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
const scalar = async <T>(url: string, settings: Settings, sql: string, params: unknown[] = []): Promise<T> =>
  as(url, settings, async (c) => Object.values((await c.query(sql, params)).rows[0] as object)[0] as T);
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: { code?: string }) => e.code);
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);

/** Mints through the issuer login at the current membership version (0031). */
async function issueCurrent(tenant: string, sub: string) {
  const value = token();
  const c = new Client({ connectionString: db.issuerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ expires_at: Date | null; refusal: string | null; membership_version: string | null }>(
      'SELECT * FROM tenant_capability_issue_current($1, $2, $3, $4, $5)', [tenant, sub, 'request', hashOf(value), 'req-binding-0001'],
    );
    return { token: value, ...rows[0]! };
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  db = await createEphemeralDatabase();
  await owner(async (c) => {
    for (const tenant of ['org-alpha', 'org-beta']) await registerTenantRow(c, tenant);
    for (const [tenant, sub] of [['org-alpha', 'alice'], ['org-beta', 'bob']]) {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['clinician'], 'test')`, [tenant, sub]);
    }
    for (const [tenant, n] of [['org-alpha', 4], ['org-beta', 1]] as const) {
      for (let i = 0; i < n; i += 1) await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, 'test', $2)`, [tenant, `SYN-${tenant}-${i}`]);
    }
  });
});
afterAll(async () => {
  await db.drop();
});

describe('T020: every tenant-setting policy reads the capability, for every role (0032)', () => {
  it('no policy text reads the setting any more, and exactly 48 read app_tenant() (the inventory of 0031)', async () => {
    const rows = await owner((c) => c.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND (qual LIKE '%app.current_tenant_id%' OR with_check LIKE '%app.current_tenant_id%' OR qual LIKE '%app_tenant()%' OR with_check LIKE '%app_tenant()%')`,
    )).then((r) => r.rows);
    expect(rows.filter((r) => `${r.qual ?? ''}${r.with_check ?? ''}`.includes('app.current_tenant_id'))).toEqual([]);
    expect(rows).toHaveLength(48);
    expect(rows.every((r) => /\(\s*SELECT\s+(public\.)?app_tenant\(\)/.test(`${r.qual ?? ''}${r.with_check ?? ''}`))).toBe(true);
  });

  it('positive control: the capability alone shows its own organization; a foreign setting beside it reads nothing; the matching setting reads the same', async () => {
    const { token: alpha } = await issueCurrent('org-alpha', 'alice');
    expect(await scalar<number>(db.appUrl, { 'app.capability': alpha }, 'SELECT count(*)::int FROM patients')).toBe(4);
    expect(await scalar<number>(db.appUrl, { 'app.capability': alpha, 'app.current_tenant_id': 'org-alpha' }, 'SELECT count(*)::int FROM patients')).toBe(4);
    expect(await scalar<number>(db.appUrl, { 'app.capability': alpha, 'app.current_tenant_id': 'org-beta' }, 'SELECT count(*)::int FROM patients')).toBe(0);
  });

  it('a forged setting for org-beta plus a write that fires a ledger policy and the ledger function is refused, and writes nothing for beta', async () => {
    const { token: alpha } = await issueCurrent('org-alpha', 'alice');
    const settings = { 'app.capability': alpha, 'app.current_tenant_id': 'org-beta', 'app.current_actor': 'mallory' };
    expect(await code(as(db.appUrl, settings, (c) => c.query(`SELECT ledger_append(gen_random_uuid(), 'note', 'patients', gen_random_uuid(), 'x', 1::smallint)`)))).toBe('42501');
    expect(await owner((c) => c.query(`SELECT count(*)::int AS n FROM ledger_events WHERE tenant_id = 'org-beta'`))).toMatchObject({ rows: [{ n: 0 }] });
  });

  it('without a capability, dual keeps the setting path (the control: the same forged setting reads beta, which is the fallback slice 6 removes)', async () => {
    expect(await scalar<number>(db.appUrl, { 'app.current_tenant_id': 'org-beta' }, 'SELECT count(*)::int FROM patients')).toBe(1);
  });
});

describe('T021: definer functions bind the actor from the capability, not from the actor setting (0032)', () => {
  it('job_enqueue stores requested_by from the capability even when app.current_actor says mallory (control: without the forged actor, the same person)', async () => {
    const { token: alpha } = await issueCurrent('org-alpha', 'alice');
    // Each as() rolls back, so the row is read back inside the same transaction that wrote it.
    const forged = await as(db.appUrl, { 'app.capability': alpha, 'app.current_tenant_id': 'org-alpha', 'app.current_actor': 'mallory' }, async (c) => {
      const made = (await c.query(`SELECT * FROM job_enqueue('syn-binding-forged', '{}'::jsonb, 'binding-forged-1')`)).rows[0];
      const row = (await c.query<{ requested_by: string }>(`SELECT requested_by FROM jobs WHERE type = 'syn-binding-forged'`)).rows[0];
      return { made, requested_by: row?.requested_by };
    });
    expect(forged).toMatchObject({ made: { created: true }, requested_by: 'alice' });
    const control = await as(db.appUrl, { 'app.capability': alpha, 'app.current_tenant_id': 'org-alpha' }, async (c) => {
      const made = (await c.query(`SELECT * FROM job_enqueue('syn-binding-control', '{}'::jsonb, 'binding-control-1')`)).rows[0];
      const row = (await c.query<{ requested_by: string }>(`SELECT requested_by FROM jobs WHERE type = 'syn-binding-control'`)).rows[0];
      return { made, requested_by: row?.requested_by };
    });
    expect(control).toMatchObject({ made: { created: true }, requested_by: 'alice' });
  });

  it('membership_assert_current (FR-007): with a capability it answers for the person and version the capability carries, and for nothing else', async () => {
    const { token: alpha, membership_version: version } = await issueCurrent('org-alpha', 'alice');
    const v = Number(version);
    const ask = (sub: string, ver: number, extra: Settings = {}) =>
      scalar<boolean>(db.appUrl, { 'app.capability': alpha, ...extra }, 'SELECT membership_assert_current($1, $2)', [sub, ver]);
    expect(await ask('alice', v)).toBe(true); // positive control
    expect(await ask('alice', v + 1)).toBe(false);
    expect(await ask('bob', v)).toBe(false);
    expect(await ask('alice', v, { 'app.current_tenant_id': 'org-beta' })).toBe(false); // the mismatch fails closed
  });

  it('the internal binding is callable by the three class (b) owner roles only, never by an application, worker, verifier, operator, auditor or issuer login', async () => {
    const logins = [db.appUrl, db.workerUrl, db.verifierUrl, db.operatorUrl, db.auditorUrl, db.issuerUrl];
    for (const url of logins) {
      expect(await code(as(url, {}, (c) => c.query(`SELECT tenant_capability_bind_internal('org-alpha', 'x')`)))).toBe('42501');
    }
    const grants = await owner((c) => c.query<{ role: string; ok: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'public.tenant_capability_bind_internal(text, text)', 'EXECUTE') AS ok FROM unnest(ARRAY['telesphoros_ledger', 'telesphoros_jobs', 'telesphoros_redactor', 'telesphoros_app', 'public']) AS r ORDER BY r`,
    ));
    expect(grants.rows).toEqual([
      { role: 'public', ok: false }, { role: 'telesphoros_app', ok: false }, { role: 'telesphoros_jobs', ok: true },
      { role: 'telesphoros_ledger', ok: true }, { role: 'telesphoros_redactor', ok: true },
    ]);
  });

  it('a class (b) function binds its own tenant and puts app.capability back as it found it, with a forged setting beside it (uploads_sweep as the jobs role)', async () => {
    const result = await owner(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.capability', 'sentinel', true), set_config('app.current_tenant_id', 'org-beta', true)`);
        await c.query('SET LOCAL ROLE telesphoros_jobs');
        const swept = (await c.query(`SELECT * FROM uploads_sweep('org-alpha', 0, true)`)).rows[0];
        await c.query('RESET ROLE');
        const after = (await c.query(`SELECT current_setting('app.capability', true) AS cap`)).rows[0];
        return { swept, after };
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(result.swept).toMatchObject({ released: 0 });
    expect(result.after).toEqual({ cap: 'sentinel' });
  });

  it('the internal binding wins over a forged setting only when they agree: its own tenant reads, a foreign setting beside it reads nothing', async () => {
    const reads = (setting: string) => owner(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [setting]);
        await c.query('SET LOCAL ROLE telesphoros_jobs');
        await c.query(`SELECT tenant_capability_bind_internal('org-alpha', 'uploads-sweep')`);
        return (await c.query(`SELECT public.app_tenant() AS t`)).rows[0];
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(await reads('org-alpha')).toEqual({ t: 'org-alpha' });
    expect(await reads('org-beta')).toEqual({ t: null });
  });
});
