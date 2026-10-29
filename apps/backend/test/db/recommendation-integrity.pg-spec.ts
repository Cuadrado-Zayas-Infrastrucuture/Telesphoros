import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadMigrations, migrateDown, migrateUp } from '../../src/db/migrator';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { revertAbove, versionsAfter } from '../helpers/migration-history';

// Migrations 0012 and 0013 made the database enforce that a recommendation names the patient who owns its report. The table was dropped by 0043, so these
// tests replay only the history up to 0013 (never to the head, where the table no longer exists) and prove what those two migrations did.
// Each test builds a throwaway database and runs migrations up and down; 5 seconds (the default) is tight on a cold runner, as the first run on the public repository showed.
jest.setTimeout(30_000);

const FK = 'recommendations_report_patient_fk';
const tenant = 'syn-integrity';
const insert = `INSERT INTO recommendations (tenant_id, created_by, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version)
  VALUES ($1, 'syn-author', $2, $3, 'G', 'syn-drug', 'syn-phenotype', 'Synthetic', 'Strong', 'syn-1') RETURNING id`;

async function seed(db: EphemeralDatabase) {
  return withAdmin(db.adminUrl, async (c) => {
    const a = (await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, 'syn-author', 'SYN-A') RETURNING id`, [tenant])).rows[0].id as string;
    const b = (await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, 'syn-author', 'SYN-B') RETURNING id`, [tenant])).rows[0].id as string;
    const report = (
      await c.query(
        `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes) VALUES ($1, 'syn-author', $2, 'structured', 'syn.json', 1) RETURNING id`,
        [tenant, a],
      )
    ).rows[0].id as string;
    const otherReport = (
      await c.query(
        `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes) VALUES ($1, 'syn-author', $2, 'structured', 'syn.json', 1) RETURNING id`,
        [tenant, b],
      )
    ).rows[0].id as string;
    return { a, b, report, otherReport };
  });
}

/** Original files only, with original checksums; partial histories exercise separate migration commits. */
async function through(db: EphemeralDatabase, version: string) {
  const dir = mkdtempSync(join(tmpdir(), 'integrity-migrations-'));
  try {
    for (const m of loadMigrations().filter((m) => m.version <= version)) {
      writeFileSync(join(dir, `${m.version}_${m.name}.up.sql`), m.upSql);
      writeFileSync(join(dir, `${m.version}_${m.name}.down.sql`), m.downSql);
    }
    return await withAdmin(db.adminUrl, (c) => migrateUp(c, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it('commits NOT VALID without changing legacy mismatches, refuses new violations, and keeps failed validation separate', async () => {
  const legacy = await createEphemeralDatabase({ migrate: false });
  try {
    await through(legacy, '0011');
    const old = await seed(legacy);
    const bad = await withAdmin(legacy.adminUrl, (c) => c.query(insert, [tenant, old.b, old.report]));
    const before = await withAdmin(legacy.adminUrl, (c) => c.query('SELECT * FROM recommendations WHERE id = $1 AND tenant_id = $2', [bad.rows[0].id, tenant]));
    expect(await through(legacy, '0012')).toEqual(['0012']);
    const after = await withAdmin(legacy.adminUrl, (c) => c.query('SELECT * FROM recommendations WHERE id = $1 AND tenant_id = $2', [bad.rows[0].id, tenant]));
    expect(after.rows).toEqual(before.rows);
    expect((await withAdmin(legacy.adminUrl, (c) => c.query('SELECT convalidated FROM pg_constraint WHERE conname = $1', [FK]))).rows).toEqual([{ convalidated: false }]);
    await expect(withAdmin(legacy.adminUrl, (c) => c.query(insert, [tenant, old.b, old.report]))).rejects.toMatchObject({ code: '23503', constraint: FK });
    await expect(through(legacy, '0013')).rejects.toThrow(/Migration 0013 failed/);
    expect((await withAdmin(legacy.adminUrl, (c) => c.query('SELECT version FROM schema_migrations ORDER BY version'))).rows.at(-1)).toEqual({ version: '0012' });
    expect((await withAdmin(legacy.adminUrl, (c) => c.query('SELECT * FROM recommendations WHERE id = $1 AND tenant_id = $2', [bad.rows[0].id, tenant]))).rows).toEqual(
      before.rows,
    );
    // Fixture-only repair of a deliberately planted synthetic violation; never an operational remediation script.
    await withAdmin(legacy.adminUrl, (c) => c.query('UPDATE recommendations SET report_id = $1 WHERE id = $2 AND tenant_id = $3', [old.otherReport, bad.rows[0].id, tenant]));
    expect(await through(legacy, '0013')).toEqual(['0013']);
    expect((await withAdmin(legacy.adminUrl, (c) => c.query('SELECT convalidated FROM pg_constraint WHERE conname = $1', [FK]))).rows).toEqual([{ convalidated: true }]);
  } finally {
    await legacy.drop();
  }
});

it('rolls back validation to an unvalidated enforced constraint, then removes/reapplies the relationship', async () => {
  const disposable = await createEphemeralDatabase();
  try {
    await withAdmin(disposable.adminUrl, async (c) => {
      // 0021 and 0020 hold audit records (merge and patient-link decisions), so reverting them needs the same deliberate setting as the other audit migrations.
      await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
      const aboveValidation = revertAbove('validate_recommendation_report_patient');
      expect(await migrateDown(c, aboveValidation.steps)).toEqual(aboveValidation.reverted);
      await c.query(`RESET telesphoros.allow_audit_drop`);
      expect(await migrateDown(c, 1)).toEqual(['0013']);
      expect((await c.query('SELECT convalidated FROM pg_constraint WHERE conname = $1', [FK])).rows).toEqual([{ convalidated: false }]);
      expect(await migrateDown(c, 1)).toEqual(['0012']);
      expect((await c.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [FK])).rows).toEqual([]);
      expect(await through(disposable, '0013')).toEqual(['0012', '0013']);
      expect((await c.query('SELECT convalidated FROM pg_constraint WHERE conname = $1', [FK])).rows).toEqual([{ convalidated: true }]);
      // The rest of the history then applies on top, and ends with the table dropped (0043).
      expect(await migrateUp(c)).toEqual(versionsAfter('validate_recommendation_report_patient'));
      expect((await c.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [FK])).rows).toEqual([]);
    });
  } finally {
    await disposable.drop();
  }
});

it('bounds lock waits and rolls back DDL while another connection holds the report table', async () => {
  const disposable = await createEphemeralDatabase({ migrate: false });
  const blocker = new Client({ connectionString: disposable.adminUrl });
  try {
    await through(disposable, '0011');
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE reports IN ROW EXCLUSIVE MODE');
    const start = performance.now();
    await expect(through(disposable, '0012')).rejects.toThrow(/lock timeout/);
    expect(performance.now() - start).toBeLessThan(10_000);
    expect((await withAdmin(disposable.adminUrl, (c) => c.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [FK]))).rowCount).toBe(0);
    await blocker.query('ROLLBACK');
    expect(await through(disposable, '0012')).toEqual(['0012']);
    expect(await through(disposable, '0013')).toEqual(['0013']);
  } finally {
    await blocker.end();
    await disposable.drop();
  }
});
