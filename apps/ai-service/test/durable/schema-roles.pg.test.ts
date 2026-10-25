import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { durableHarness } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
const h = durableHarness(
  () => fixture,
  () => owner,
);
const migrations = resolve(import.meta.dirname, '../../../backend/migrations');
const TABLES = [
  'agentic_synthetic_capacity',
  'agentic_synthetic_grants',
  'agentic_synthetic_sources',
  'agentic_synthetic_grant_sources',
  'agentic_synthetic_runs',
  'agentic_synthetic_reservations',
  'agentic_synthetic_buckets',
  'agentic_synthetic_invocations',
  'agentic_synthetic_outcomes',
  'agentic_synthetic_audit',
];
const connect = async (url: string) => {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
};
const logins = () => ({ app: fixture.appUrl, worker: fixture.workerUrl, verifier: fixture.verifierUrl, operator: fixture.operatorUrl, auditor: fixture.auditorUrl });

/** Every catalog fact a migration could change in the public schema, as one sorted list of stable strings. */
async function catalog(db: Client): Promise<string[]> {
  const { rows } = await db.query(`
    SELECT 'rel ' || c.relname || ' ' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner) || ' acl=' || coalesce(c.relacl::text,'-')
      || ' rls=' || c.relrowsecurity || '/' || c.relforcerowsecurity AS f
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' coll=' || a.attcollation::regcollation::text
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') owner=' || pg_get_userbyid(p.proowner)
      || ' acl=' || coalesce(p.proacl::text,'-') || ' definer=' || p.prosecdef || ' cfg=' || coalesce(array_to_string(p.proconfig, ','),'-')
      || ' src=' || md5(p.prosrc)
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    UNION ALL SELECT 'trg ' || t.tgname || ' on ' || t.tgrelid::regclass::text || ' ' || md5(pg_get_triggerdef(t.oid))
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
    UNION ALL SELECT 'pol ' || p.polname || ' on ' || p.polrelid::regclass::text || ' ' || md5(coalesce(pg_get_expr(p.polqual, p.polrelid),'')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid),'') || p.polroles::text)
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'con ' || conname || ' on ' || conrelid::regclass::text || ' ' || md5(pg_get_constraintdef(oid))
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace
    UNION ALL SELECT 'schema public acl=' || coalesce(nspacl::text,'-') FROM pg_namespace WHERE nspname = 'public'`);
  return rows.map((r) => r.f as string).sort();
}
const synthetic = (fact: string) => /agentic_synthetic_/.test(fact);

describe('owned PostgreSQL synthetic schema, roles and reversibility', () => {
  beforeAll(async () => {
    fixture = await ownedPostgresFixture();
    owner = await connect(fixture.adminUrl);
  }, 180_000);
  afterAll(async () => {
    await owner?.end();
    await fixture?.drop();
  }, 60_000);
  afterEach(() => h.releaseAllPermits());

  // First: the down migration refuses any data, so this runs before any fixture row exists.
  test('P2-32/P2-34 down then up changes only synthetic objects and restores the catalog exactly; rollback is atomic', async () => {
    const migrated = await catalog(owner);
    await owner.query('BEGIN');
    try {
      // 0030 only replaces three 0029 function bodies and adds a helper; it comes off first and goes on last, so the catalog it hands back is compared whole.
      await owner.query(readFileSync(resolve(migrations, '0030_agentic_synthetic_identity.down.sql'), 'utf8'));
      await owner.query(readFileSync(resolve(migrations, '0029_agentic_synthetic.down.sql'), 'utf8'));
      const before = await catalog(owner); // the schema as migration 0028 left it
      expect(before.filter(synthetic)).toEqual([]);
      // Every shared fact is byte-identical with and without 0029, except one documented grant: the synthetic
      // definer functions run as telesphoros_jobs and call the shared membership check.
      const shared = migrated.filter((f) => !synthetic(f));
      const added = shared.filter((f) => !before.includes(f));
      const removed = before.filter((f) => !shared.includes(f));
      expect(added.map((f) => f.replace(/ src=.*/, ''))).toEqual([expect.stringMatching(/^fn membership_assert_current\(p_sub text, p_version bigint\) .*telesphoros_jobs=X\//)]);
      expect(removed.map((f) => f.replace(/,?telesphoros_jobs=X\/[a-z0-9_]+/, ''))).toEqual(added.map((f) => f.replace(/,?telesphoros_jobs=X\/[a-z0-9_]+/, '')));
      await owner.query(readFileSync(resolve(migrations, '0029_agentic_synthetic.up.sql'), 'utf8'));
      await owner.query(readFileSync(resolve(migrations, '0030_agentic_synthetic_identity.up.sql'), 'utf8'));
      expect(await catalog(owner)).toEqual(migrated);
    } finally {
      await owner.query('ROLLBACK');
    }
    expect(await catalog(owner)).toEqual(migrated); // the rolled-back transaction left nothing behind
    // No schedule or job of the synthetic type exists after migration.
    expect(
      await h.row(
        `SELECT (SELECT count(*)::int FROM public.job_schedules WHERE type LIKE '%synthetic%') AS schedules,
      (SELECT count(*)::int FROM public.jobs WHERE type LIKE '%synthetic%') AS jobs`,
        [],
      ),
    ).toEqual({ schedules: 0, jobs: 0 });
  });

  test('P2-29 no login is superuser or bypasses RLS, none owns or can read or write a synthetic table', async () => {
    await owner.query(`INSERT INTO public.agentic_synthetic_capacity(singleton,tenant_day_units,fleet_month_units)
      VALUES (1,5000000,300000000) ON CONFLICT DO NOTHING`);
    const owners = await owner.query(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS o, r.rolcanlogin
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.relname = ANY($1::text[])`,
      [TABLES],
    );
    expect(owners.rows).toEqual([{ o: 'telesphoros_jobs', rolcanlogin: false }]);
    expect((await owner.query('SELECT count(*)::int AS n FROM public.agentic_synthetic_capacity')).rows[0].n).toBe(1); // positive control
    for (const [name, url] of Object.entries(logins())) {
      const db = await connect(url);
      try {
        const me = (await db.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`)).rows[0];
        expect.soft({ name, me }).toEqual({ name, me: { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false } });
        for (const table of TABLES) {
          for (const sql of [`SELECT 1 FROM public.${table} LIMIT 1`, `DELETE FROM public.${table}`]) {
            const code = await db.query(sql).then(
              () => 'allowed',
              (e: { code?: string }) => e.code,
            );
            expect.soft({ name, sql, code }).toEqual({ name, sql, code: '42501' });
          }
        }
        // Only the app and worker hold synthetic entry points; the other logins hold none.
        const fns = (
          await db.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'agentic_synthetic_%'
          AND has_function_privilege(current_user, oid, 'EXECUTE')`)
        ).rows[0].n;
        expect.soft({ name, fns }).toEqual({ name, fns: { app: 3, worker: 8 }[name as 'app' | 'worker'] ?? 0 });
      } finally {
        await db.end();
      }
    }
  });

  test('P2-30 temp shadow tables and spoofed tenant settings do not change what a definer function reads', async () => {
    const { caller } = await h.seedTenant();
    const worker = await connect(fixture.workerUrl);
    try {
      const real = await h.admitAndClaim(worker, caller);
      // Shadow every name the functions use with attacker rows in this session's pg_temp.
      for (const t of ['jobs', 'tenants', 'tenant_memberships', 'agentic_synthetic_runs', 'agentic_synthetic_grants']) {
        await worker.query(`CREATE TEMP TABLE ${t} (id text, run_id uuid, state text, status text)`);
        await worker.query(`INSERT INTO ${t} VALUES ('x', $1, 'released', 'active')`, [real.runId]);
      }
      // Positive control: unqualified names in this session really resolve to the shadows.
      expect((await worker.query('SELECT state FROM agentic_synthetic_runs')).rows).toEqual([{ state: 'released' }]);
      await worker.query(`SELECT set_config('app.current_tenant_id', 'attacker-tenant', false)`);
      const loaded = await real.store.load(real.stamp, real.expected);
      expect(loaded).toMatchObject({ kind: 'ok', value: { state: 'queued', runId: real.runId } });
      // The membership helper restored the caller's own setting afterwards.
      expect((await worker.query(`SELECT current_setting('app.current_tenant_id') AS t`)).rows[0].t).toBe('attacker-tenant');
    } finally {
      await worker.end();
    }
    // App-side spoofing: a GUC tenant or actor that disagrees with the caller is refused. (No capability is bound here, so after 0030 these are refused
    // for that reason first; the cases that bind a capability and forge the settings are in apps/backend/test/db/agentic-identity.pg-spec.ts, in all modes.)
    for (const [tenant, actor] of [
      ['attacker-tenant', caller.requesterRef],
      [caller.tenantId, 'someone-else'],
    ]) {
      const app = await connect(fixture.appUrl);
      try {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.current_tenant_id',$1,true), set_config('app.current_actor',$2,true)`, [tenant, actor]);
        const r = (
          await app.query('SELECT public.agentic_synthetic_admit($1::jsonb,$2::jsonb) AS r', [
            JSON.stringify({
              schemaVersion: 'agentic.request.v1',
              taskKey: 'business.sop-draft.v1',
              locale: 'en',
              question: 'spoof',
              idempotencyKey: 'spoof/1',
            }),
            JSON.stringify(caller),
          ])
        ).rows[0].r;
        expect.soft({ tenant, actor, r }).toEqual({ tenant, actor, r: { kind: 'refused', code: 'NOT_AUTHORIZED' } });
      } finally {
        await app.query('ROLLBACK');
        await app.end();
      }
    }
  });

  test('P2-30 every synthetic function body schema-qualifies the functions and tables it uses', async () => {
    const { rows } = await owner.query(`SELECT proname, prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'agentic_synthetic_%'`);
    const tables = (await owner.query(`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v')`)).rows.map((r) => r.relname as string);
    const unqualified = (src: string) => [
      ...[...src.matchAll(/(?<![.\w])(agentic_synthetic_\w+|job_\w+|membership_assert_current)\s*\(/g)].map((m) => m[1]),
      ...[...src.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?!public\.)([a-z_]+)/gi)].map((m) => m[1]!).filter((n) => tables.includes(n)),
    ];
    expect(rows.length).toBeGreaterThan(30);
    for (const r of rows) expect.soft({ fn: r.proname, unqualified: unqualified(r.prosrc) }).toEqual({ fn: r.proname, unqualified: [] });
    // Positive control: the scanner finds both forms.
    expect(unqualified('PERFORM agentic_synthetic_sha(x); SELECT 1 FROM jobs; SELECT 1 FROM public.jobs')).toEqual(['agentic_synthetic_sha', 'jobs']);
  });
});
