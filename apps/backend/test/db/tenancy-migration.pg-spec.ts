import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { MIGRATIONS_DIR, migrateDown, migrateUp } from '../../src/db/migrator';
import { adminUrl } from '../helpers/database';

/**
 * Migration 0003 moves records from "owned by one user" to "owned by a tenant". This proves it on a
 * database that ALREADY holds owner-era data, run by a table owner that is NOT a superuser (the
 * production-like case: FORCE ROW LEVEL SECURITY also binds the migrating role, so a careless
 * backfill would silently update nothing).
 */
const MIGRATOR = 'telesphoros_test_migrator';
const MIGRATOR_PASSWORD = 'test-only-migrator-password';
const ROLE_LOCK = 4242;

const urlFor = (database: string, user?: { name: string; password: string }) => {
  const parsed = new URL(adminUrl());
  parsed.pathname = `/${database}`;
  if (user) {
    parsed.username = user.name;
    parsed.password = user.password;
  }
  return parsed.toString();
};

let name: string;
let dir: string;
let admin: Client; // superuser, bypasses RLS: seeds and inspects
let migrator: Client; // owns the tables, bound by FORCE RLS

/** The migrations as they were BEFORE 0003. */
const beforeTenancy = () => {
  const copy = mkdtempSync(join(tmpdir(), 'migrations-pre-tenancy-'));
  cpSync(MIGRATIONS_DIR, copy, { recursive: true });
  for (const file of readdirSync(copy).filter((f) => f.startsWith('0003'))) rmSync(join(copy, file));
  return copy;
};

beforeAll(async () => {
  name = `test_${randomBytes(6).toString('hex')}`;
  dir = beforeTenancy();
  const root = new Client({ connectionString: adminUrl() });
  await root.connect();
  try {
    await root.query('SELECT pg_advisory_lock($1)', [ROLE_LOCK]);
    await root.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_app') THEN
        CREATE ROLE telesphoros_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
        CREATE ROLE ${MIGRATOR} LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END $$`);
    await root.query('SELECT pg_advisory_unlock($1)', [ROLE_LOCK]);
    await root.query(`CREATE DATABASE ${name} OWNER ${MIGRATOR}`);
  } finally {
    await root.end();
  }
  admin = new Client({ connectionString: urlFor(name) });
  migrator = new Client({ connectionString: urlFor(name, { name: MIGRATOR, password: MIGRATOR_PASSWORD }) });
  await Promise.all([admin.connect(), migrator.connect()]);

  expect(await migrateUp(migrator, dir)).toEqual(['0001', '0002']);
  // Owner-era data, written by the superuser (the migrator itself could not see these rows).
  const ids: Record<string, string> = {};
  for (const owner of ['alice', 'bob']) {
    const patient = await admin.query(`INSERT INTO patients (owner_id, label) VALUES ($1, $2) RETURNING id`, [owner, `SYN-${owner}`]);
    ids[owner] = patient.rows[0].id;
    const report = await admin.query(
      `INSERT INTO reports (owner_id, patient_id, type, original_filename, size_bytes) VALUES ($1, $2, 'vcf', 'a.vcf', 5) RETURNING id`,
      [owner, patient.rows[0].id],
    );
    await admin.query(
      `INSERT INTO recommendations (owner_id, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version)
       VALUES ($1, $2, $3, 'G', 'd', 'p', 's', 'Strong', 'v0')`,
      [owner, patient.rows[0].id, report.rows[0].id],
    );
  }
});

afterAll(async () => {
  await Promise.all([admin?.end(), migrator?.end()]);
  const root = new Client({ connectionString: adminUrl() });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await root.end();
  rmSync(dir, { recursive: true, force: true });
});

const snapshot = async () =>
  (await admin.query(`SELECT 'patients' AS t, id, created_at, updated_at, deleted_at FROM patients
                      UNION ALL SELECT 'reports', id, created_at, updated_at, deleted_at FROM reports
                      UNION ALL SELECT 'recommendations', id, created_at, updated_at, deleted_at FROM recommendations
                      ORDER BY 1, 2`)).rows;
const asApp = async <T>(settings: Record<string, string>, work: (c: Client) => Promise<T>) => {
  const c = new Client({ connectionString: urlFor(name) });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE telesphoros_app');
    for (const [key, value] of Object.entries(settings)) await c.query(`SELECT set_config($1, $2, true)`, [key, value]);
    const result = await work(c);
    await c.query('ROLLBACK');
    return result;
  } finally {
    await c.end();
  }
};

describe('migration 0003 on a database that already holds owner-era data', () => {
  let before: Awaited<ReturnType<typeof snapshot>>;

  it('applies as a non-superuser table owner, and no row changes who can see it or when it was last updated', async () => {
    before = await snapshot();
    expect(before).toHaveLength(6);
    expect(await migrateUp(migrator)).toEqual(['0003']);

    // Every former owner is now a tenant of one, and the creator is backfilled with the same value.
    const rows = (await admin.query(`SELECT tenant_id, created_by FROM patients ORDER BY tenant_id`)).rows;
    expect(rows).toEqual([{ tenant_id: 'alice', created_by: 'alice' }, { tenant_id: 'bob', created_by: 'bob' }]);
    for (const table of ['reports', 'recommendations']) {
      const sample = (await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE created_by = tenant_id AND tenant_id IN ('alice','bob')`)).rows[0];
      expect({ table, n: sample.n }).toEqual({ table, n: 2 });
    }
    // History was not rewritten: the updated_at trigger was paused for the backfill.
    expect(await snapshot()).toEqual(before);
  });

  it('row-level security is still ENFORCED for the table owner afterwards (the temporary lift was undone)', async () => {
    const flags = (await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('patients','reports','recommendations') ORDER BY relname`)).rows;
    expect(flags).toEqual([
      { relname: 'patients', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'recommendations', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'reports', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    // ...so the owner, which has no policy, still sees nothing.
    expect((await migrator.query(`SELECT count(*)::int AS n FROM patients`)).rows[0].n).toBe(0);
  });

  it('the policies bind on the tenant setting; the old owner setting finds nothing and fails closed', async () => {
    const policies = (await admin.query(`SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('patients','reports','recommendations') ORDER BY tablename`)).rows;
    expect(policies).toEqual([
      { tablename: 'patients', policyname: 'patients_tenant' },
      { tablename: 'recommendations', policyname: 'recommendations_tenant' },
      { tablename: 'reports', policyname: 'reports_tenant' },
    ]);
    expect(await asApp({ 'app.current_tenant_id': 'alice' }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM patients`)).rows[0].n)).toBe(1);
    expect(await asApp({ 'app.current_owner_id': 'alice' }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM patients`)).rows[0].n)).toBe(0);
    expect(await asApp({}, async (c) => (await c.query(`SELECT count(*)::int AS n FROM reports`)).rows[0].n)).toBe(0);
  });

  it('a row can never change tenant or author, even for the table owner or a superuser', async () => {
    for (const table of ['patients', 'reports', 'recommendations']) {
      for (const column of ['tenant_id', 'created_by']) {
        await expect(admin.query(`UPDATE ${table} SET ${column} = 'mallory' WHERE tenant_id = 'alice'`)).rejects.toMatchObject({ code: '23000' });
      }
    }
    // Ordinary edits are untouched, and setting the same value again is not a change.
    await expect(admin.query(`UPDATE patients SET label = 'SYN-renamed' WHERE tenant_id = 'alice'`)).resolves.toBeDefined();
    await expect(admin.query(`UPDATE patients SET tenant_id = tenant_id, created_by = created_by WHERE tenant_id = 'alice'`)).resolves.toBeDefined();
    await admin.query(`UPDATE patients SET label = 'SYN-alice' WHERE tenant_id = 'alice'`);
  });

  it('created_by is mandatory and length-checked', async () => {
    await expect(admin.query(`INSERT INTO patients (tenant_id, label) VALUES ('x', 'SYN-x')`)).rejects.toMatchObject({ code: '23502' });
    await expect(admin.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('x', '', 'SYN-x')`)).rejects.toMatchObject({ code: '23514' });
  });

  it('reverts cleanly: the column is owner_id again with the same values, the policies bind on the owner setting, and it re-applies', async () => {
    const beforeRevert = await snapshot(); // taken now: an earlier test legitimately edited a label
    expect(await migrateDown(migrator, 1)).toEqual(['0003']);
    expect((await admin.query(`SELECT owner_id FROM patients ORDER BY owner_id`)).rows).toEqual([{ owner_id: 'alice' }, { owner_id: 'bob' }]);
    const columns = (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'patients' AND column_name IN ('tenant_id','created_by')`)).rows;
    expect(columns).toEqual([]);
    expect(await asApp({ 'app.current_owner_id': 'alice' }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM patients`)).rows[0].n)).toBe(1);
    expect(await asApp({ 'app.current_tenant_id': 'alice' }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM patients`)).rows[0].n)).toBe(0);

    expect(await migrateUp(migrator)).toEqual(['0003']);
    expect((await admin.query(`SELECT count(*)::int AS n FROM patients WHERE created_by = tenant_id`)).rows[0].n).toBe(2);
    expect(await snapshot()).toEqual(beforeRevert); // the round trip rewrote no history either
  });

  it('the application role keeps exactly the privileges it had: no DELETE, and recommendations stay insert-only', async () => {
    const privileges = async (table: string) =>
      (await admin.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'telesphoros_app' AND table_name = $1 ORDER BY 1`, [table])).rows.map(
        (r) => r.privilege_type as string,
      );
    expect(await privileges('patients')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await privileges('reports')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await privileges('recommendations')).toEqual(['INSERT', 'SELECT']);
  });
});
