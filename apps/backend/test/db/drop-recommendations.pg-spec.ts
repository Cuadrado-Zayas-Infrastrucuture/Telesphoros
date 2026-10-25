import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../src/db/database';
import { MIGRATIONS_DIR, migrateDown, migrateUp } from '../../src/db/migrator';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';
import { lastVersion } from '../helpers/migration-history';

// Migration 0043 drops the legacy `recommendations` table (its code went in #19 and #39). Each test builds a throwaway database and replays history.
jest.setTimeout(60_000);

const VERSION = '0043';
const insert = `INSERT INTO recommendations (tenant_id, created_by, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version)
  VALUES ('syn-drop', 'syn-author', $1, $2, 'G', 'syn-drug', 'syn-phenotype', 'Synthetic', 'Strong', 'syn-1')`;

/** A database at the version just before the drop: the migrations numbered below 0043, exactly as shipped. */
async function beforeDrop(): Promise<{ db: EphemeralDatabase; dir: string }> {
  const db = await createEphemeralDatabase({ migrate: false });
  const dir = mkdtempSync(join(tmpdir(), 'drop-recs-'));
  for (const file of readdirSync(MIGRATIONS_DIR)) if (/^\d{4}_/.test(file) && file.slice(0, 4) < VERSION) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  await withAdmin(db.adminUrl, (c) => migrateUp(c, dir));
  return { db, dir };
}
const parents = (db: EphemeralDatabase) =>
  withAdmin(db.adminUrl, async (c) => {
    const patient = (await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('syn-drop', 'syn-author', 'SYN-DROP') RETURNING id`)).rows[0].id as string;
    const report = (await c.query(
      `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes) VALUES ('syn-drop', 'syn-author', $1, 'vcf', 'syn.vcf', 1) RETURNING id`, [patient])).rows[0].id as string;
    return { patient, report };
  });
const tableExists = (db: EphemeralDatabase) =>
  withAdmin(db.adminUrl, async (c) => (await c.query(`SELECT to_regclass('public.recommendations') IS NOT NULL AS present`)).rows[0].present as boolean);

/** Everything about the table that a later migration or the application could depend on, as text: the DDL, policy, privileges, triggers, the guard function. */
async function tableFacts(db: EphemeralDatabase): Promise<string> {
  const ddl = execFileSync('pg_dump', ['-s', '--no-owner', '-t', 'recommendations', db.adminUrl], { encoding: 'utf8' }).replace(/^(--|\\(un)?restrict).*\n/gm, '');
  const rest = await withAdmin(db.adminUrl, async (c) => ({
    policies: (await c.query(`SELECT policyname, roles, cmd, qual, with_check FROM pg_policies WHERE tablename = 'recommendations'`)).rows,
    flags: (await c.query(`SELECT relacl::text AS acl, pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'recommendations'`)).rows,
    triggers: (await c.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'recommendations'::regclass AND NOT tgisinternal ORDER BY 1`)).rows,
    columns: (await c.query(`SELECT attnum, attname, format_type(atttypid, atttypmod) AS type, attnotnull, attidentity FROM pg_attribute WHERE attrelid = 'recommendations'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY 1`)).rows,
    guard: (await c.query(`SELECT pg_get_functiondef('block_report_soft_delete'::regproc) AS def`)).rows,
    tenantPolicies: (await c.query(`SELECT count(*)::int AS n FROM pg_policies WHERE qual LIKE '%app_tenant()%' OR with_check LIKE '%app_tenant()%'`)).rows,
  }));
  return `${ddl}\n${JSON.stringify(rest, null, 1)}`;
}

it('the drop is the last migration so far, and it is labelled breaking', () => {
  expect(lastVersion() >= VERSION).toBe(true);
  const up = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(`${VERSION}_`) && f.endsWith('.up.sql'))!;
  expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith(`${VERSION}_`)).sort()).toEqual([up.replace('.up.', '.down.'), up].sort());
});

it('drops an empty table, with its policy, indexes and grants, and leaves the shared trigger functions', async () => {
  const { db, dir } = await beforeDrop();
  try {
    expect(await tableExists(db)).toBe(true);
    await withAdmin(db.adminUrl, async (c) => expect(await migrateUp(c)).toEqual(expect.arrayContaining([VERSION])));
    expect(await tableExists(db)).toBe(false);
    const left = await withAdmin(db.adminUrl, async (c) => ({
      policies: (await c.query(`SELECT 1 FROM pg_policies WHERE tablename = 'recommendations'`)).rowCount,
      indexes: (await c.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'recommendations'`)).rowCount,
      functions: (await c.query(`SELECT proname FROM pg_proc WHERE proname IN ('set_updated_at', 'forbid_identity_change') ORDER BY 1`)).rows.map((r) => r.proname),
    }));
    expect(left).toEqual({ policies: 0, indexes: 0, functions: ['forbid_identity_change', 'set_updated_at'] });
  } finally { await db.drop(); rmSync(dir, { recursive: true, force: true }); }
});

it('refuses to drop a table that holds a row, run as a non-superuser owner that row-level security hides the row from; only the exact word allows it', async () => {
  const { db, dir } = await beforeDrop();
  // The production-like case: the migrating role owns the table and is no superuser, so FORCE ROW LEVEL SECURITY (policy: telesphoros_app only) hides every row from it.
  const owner = `test_drop_owner_${randomBytes(5).toString('hex')}`;
  try {
    const { patient, report } = await parents(db);
    await withAdmin(db.adminUrl, (c) => c.query(insert, [patient, report]));
    await withAdmin(db.adminUrl, async (c) => {
      await c.query(`CREATE ROLE ${owner} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      await c.query(`ALTER TABLE recommendations OWNER TO ${owner}`);
      await c.query(`ALTER FUNCTION block_report_soft_delete() OWNER TO ${owner}`);
      await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${owner}`);
      await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON schema_migrations TO ${owner}`);
      await c.query(`SET ROLE ${owner}`);
      expect((await c.query('SELECT count(*)::int AS n FROM recommendations')).rows[0].n).toBe(0); // the premise: the owner sees nothing, though a row exists
      try {
        await expect(migrateUp(c)).rejects.toThrow(/Refusing to drop recommendations/);
        expect(await tableExists(db)).toBe(true); // the whole migration rolled back, including the guard rewrite and the row-security change
        expect((await c.query(`SELECT relforcerowsecurity FROM pg_class WHERE relname = 'recommendations'`)).rows).toEqual([{ relforcerowsecurity: true }]);
        expect((await c.query(`SELECT pg_get_functiondef('block_report_soft_delete'::regproc) AS def`)).rows[0].def).toMatch(/live recommendations/);
        await c.query(`SET telesphoros.allow_recommendations_drop = 'Yes'`);
        await expect(migrateUp(c)).rejects.toThrow(/Refusing to drop recommendations/);
        await c.query(`SET telesphoros.allow_recommendations_drop = 'yes'`);
        expect(await migrateUp(c)).toEqual(expect.arrayContaining([VERSION]));
      } finally { await c.query('RESET ROLE'); }
    });
    expect(await tableExists(db)).toBe(false);
  } finally {
    await withAdmin(db.adminUrl, async (c) => { await c.query(`REASSIGN OWNED BY ${owner} TO CURRENT_USER`); await c.query(`DROP OWNED BY ${owner}`); await c.query(`DROP ROLE ${owner}`); }).catch(() => undefined);
    await db.drop(); rmSync(dir, { recursive: true, force: true });
  }
});

it('reverting recreates the table exactly as it stood, so 0032 can be reverted after it', async () => {
  const { db, dir } = await beforeDrop();
  const reverted = await createEphemeralDatabase();
  try {
    const expected = await tableFacts(db);
    expect(expected).toMatch(/app_tenant/); // the policy is the one 0032 left, which is what the revert must reproduce
    await withAdmin(reverted.adminUrl, async (c) => expect(await migrateDown(c, 1)).toEqual([VERSION]));
    expect(await tableFacts(reverted)).toBe(expected);
  } finally { await db.drop(); await reverted.drop(); rmSync(dir, { recursive: true, force: true }); }
});

describe('the report soft-delete guard after the drop', () => {
  let pg: EphemeralDatabase;
  let app: Database;
  let ledger: PostgresLedgerRecordsRepository;
  beforeAll(async () => {
    pg = await createEphemeralDatabase();
    app = new Database({ url: pg.appUrl, ssl: 'disable' });
    ledger = new PostgresLedgerRecordsRepository(app);
  });
  afterAll(async () => { await app?.onModuleDestroy(); await pg?.drop(); });

  const softDelete = (reportId: string) => withAdmin(pg.adminUrl, (c) => c.query(`UPDATE reports SET deleted_at = now() WHERE id = $1`, [reportId]));

  it('refuses to soft-delete a report that has an evaluation, and still allows it for a report that has none', async () => {
    const tenant = 'syn-guard';
    const evaluated = await seedLabReport(pg.adminUrl, tenant);
    const captureInput = captureFor(evaluated);
    const capture = await ledger.insertCapture(tenant, 'syn-uploader', captureInput);
    const accepted = await ledger.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(capture.record.id, captureInput));
    await ledger.insertEvaluation(tenant, 'syn-system', evaluationFor(evaluated, capture.record.id, accepted.record.id));
    await expect(softDelete(evaluated.reportId)).rejects.toMatchObject({ code: '23503', message: 'report has evaluations' });

    const plain = await seedLabReport(pg.adminUrl, tenant);
    await expect(softDelete(plain.reportId)).resolves.toHaveProperty('rowCount', 1);
  });
});
