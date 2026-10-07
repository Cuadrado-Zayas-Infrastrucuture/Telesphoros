import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  loadMigrations,
  MIGRATIONS_DIR,
  migrateDown,
  migrateUp,
  migrationStatus,
  MigrationError,
  pendingMigrations,
} from '../../src/db/migrator';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

const dbs: EphemeralDatabase[] = [];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dbs.map((db) => db.drop()));
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const emptyDb = async () => {
  const db = await createEphemeralDatabase({ migrate: false });
  dbs.push(db);
  return db;
};
const tempMigrations = () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  dirs.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
};
const run = <T>(db: EphemeralDatabase, work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);

describe('migration runner', () => {
  it('applies every migration in order, and a second run does nothing', async () => {
    const db = await emptyDb();
    expect(await run(db, (c) => migrateUp(c))).toEqual(['0001', '0002']);
    expect(await run(db, (c) => migrateUp(c))).toEqual([]);
    const status = await run(db, (c) => migrationStatus(c));
    expect(status.applied.map((m) => m.version)).toEqual(['0001', '0002']);
    expect(status.pending).toEqual([]);
  });

  it('reverts step by step, and can re-apply after a full revert', async () => {
    const db = await emptyDb();
    await run(db, (c) => migrateUp(c));
    expect(await run(db, (c) => migrateDown(c, 1))).toEqual(['0002']);
    expect((await run(db, (c) => migrationStatus(c))).pending.map((m) => m.version)).toEqual(['0002']);
    expect(await run(db, (c) => migrateDown(c, 5))).toEqual(['0001']);
    const tables = await run(db, (c) => c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`));
    expect(tables.rows).toEqual([]);
    expect(await run(db, (c) => migrateUp(c))).toEqual(['0001', '0002']);
  });

  it('refuses to run if an applied migration was edited afterwards', async () => {
    const db = await emptyDb();
    const dir = tempMigrations();
    await run(db, (c) => migrateUp(c, dir));
    writeFileSync(join(dir, '0001_core_tables.up.sql'), '-- tampered\n', { flag: 'a' });
    await expect(run(db, (c) => migrateUp(c, dir))).rejects.toThrow(/modified after it was applied/);
  });

  it('rolls back a failing migration completely and reports which one failed', async () => {
    const db = await emptyDb();
    const dir = tempMigrations();
    writeFileSync(join(dir, '0003_broken.up.sql'), 'CREATE TABLE half_done (id int); SELECT 1/0;');
    writeFileSync(join(dir, '0003_broken.down.sql'), 'DROP TABLE IF EXISTS half_done;');
    await expect(run(db, (c) => migrateUp(c, dir))).rejects.toThrow(/Migration 0003 failed and was rolled back/);
    const left = await run(db, (c) => c.query(`SELECT to_regclass('public.half_done') AS t`));
    expect(left.rows[0].t).toBeNull();
    expect((await run(db, (c) => migrationStatus(c))).applied.map((m) => m.version)).toEqual(['0001', '0002']);
  });

  it('is safe when two deploys start at the same moment (advisory lock)', async () => {
    const db = await emptyDb();
    const results = await Promise.all([run(db, (c) => migrateUp(c)), run(db, (c) => migrateUp(c))]);
    expect(results.flat().sort()).toEqual(['0001', '0002']); // each migration applied exactly once, no error
  });

  it('reports pending migrations read-only (what /ready relies on)', async () => {
    const db = await emptyDb();
    expect(await run(db, (c) => pendingMigrations(c))).toEqual(['0001', '0002']);
    await run(db, (c) => migrateUp(c));
    expect(await run(db, (c) => pendingMigrations(c))).toEqual([]);
  });

  it('rejects incomplete or gapped migration sets', () => {
    const dir = tempMigrations();
    rmSync(join(dir, '0002_row_level_security.down.sql'));
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
    const gap = tempMigrations();
    for (const file of readdirSync(gap).filter((f) => f.startsWith('0002'))) rmSync(join(gap, file));
    writeFileSync(join(gap, '0004_x.up.sql'), 'SELECT 1;');
    writeFileSync(join(gap, '0004_x.down.sql'), 'SELECT 1;');
    expect(() => loadMigrations(gap)).toThrow(/gap/);
  });
});

describe('schema (asserted by trying to break it on a real PostgreSQL)', () => {
  let db: EphemeralDatabase;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    dbs.push(db);
  });
  const q = (sql: string, params: unknown[] = []) => run(db, (c) => c.query(sql, params));
  const expectCode = async (sql: string, code: string, params: unknown[] = []) => {
    const error = await q(sql, params).then(
      () => undefined,
      (e: { code?: string }) => e,
    );
    expect(error?.code).toBe(code);
  };
  const patient = async (owner: string, label: string) =>
    (await q('INSERT INTO patients (owner_id, label) VALUES ($1, $2) RETURNING id', [owner, label])).rows[0].id as string;
  const report = async (owner: string, patientId: string, extra = '') =>
    (await q(
      `INSERT INTO reports (owner_id, patient_id, type, original_filename, size_bytes${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1, $2, 'vcf', 'a.vcf', 100${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`,
      [owner, patientId],
    )).rows[0].id as string;

  it('every foreign key states ON DELETE RESTRICT explicitly', async () => {
    const { rows } = await q(`SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' ORDER BY conname`);
    expect(rows.map((r) => r.conname)).toEqual(['recommendations_patient_fk', 'recommendations_report_fk', 'reports_patient_fk']);
    expect(rows.every((r) => r.confdeltype === 'r')).toBe(true);
  });

  it('ids are UUIDs generated by the database, and every table has NOT NULL created_at / updated_at', async () => {
    const cols = await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
                           WHERE table_schema = 'public' AND table_name IN ('patients','reports','recommendations')`);
    for (const table of ['patients', 'reports', 'recommendations']) {
      const mine = cols.rows.filter((c) => c.table_name === table);
      const id = mine.find((c) => c.column_name === 'id');
      expect(id.data_type).toBe('uuid');
      expect(id.column_default).toMatch(/gen_random_uuid/);
      for (const name of ['created_at', 'updated_at']) {
        expect(mine.find((c) => c.column_name === name)).toMatchObject({ is_nullable: 'NO', data_type: 'timestamp with time zone' });
      }
    }
  });

  it('has the indexes the queries rely on', async () => {
    const { rows } = await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      'patients_owner_label_uq', 'patients_owner_seq_idx', 'reports_storage_key_uq', 'reports_owner_seq_idx',
      'reports_owner_patient_idx', 'reports_patient_idx', 'recommendations_owner_seq_idx',
      'recommendations_owner_patient_idx', 'recommendations_owner_report_idx',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('enforces the label rules and uniqueness (case-insensitive, per owner, live rows only)', async () => {
    await expectCode(`INSERT INTO patients (owner_id, label) VALUES ('o1', 'Jane Doe')`, '23514');
    await expectCode(`INSERT INTO patients (owner_id, label) VALUES ('o1', '')`, '23514');
    await expectCode(`INSERT INTO patients (owner_id, label) VALUES ('', 'SYN-1')`, '23514');
    const id = await patient('o-uq', 'SYN-UQ');
    await expectCode(`INSERT INTO patients (owner_id, label) VALUES ('o-uq', 'syn-uq')`, '23505');
    await patient('o-other', 'SYN-UQ'); // another owner may reuse it
    await q('UPDATE patients SET deleted_at = now() WHERE id = $1', [id]);
    await patient('o-uq', 'SYN-UQ'); // a soft-deleted row frees its label
  });

  it('validates report fields', async () => {
    const p = await patient('o-rf', 'SYN-RF');
    const bad = (cols: string, vals: string) => expectCode(`INSERT INTO reports (owner_id, patient_id, ${cols}) VALUES ('o-rf', '${p}', ${vals})`, '23514');
    await bad('type, original_filename, size_bytes', `'pdf', 'a.vcf', 10`);
    await bad('type, original_filename, size_bytes', `'vcf', '../a.vcf', 10`);
    await bad('type, original_filename, size_bytes', `'vcf', 'a.vcf', 0`);
    await bad('type, original_filename, size_bytes', `'vcf', 'a.vcf', 10485761`);
    await bad('type, original_filename, size_bytes, status', `'vcf', 'a.vcf', 10, 'done'`);
    await bad('type, original_filename, size_bytes, sha256', `'vcf', 'a.vcf', 10, '${'A'.repeat(64)}'`);
    await bad('type, original_filename, size_bytes, uploaded_at', `'vcf', 'a.vcf', 10, now()`); // uploaded needs key+sha+type
  });

  it('never lets the same object key be registered twice', async () => {
    const p = await patient('o-key', 'SYN-KEY');
    const sha = 'a'.repeat(64);
    await report('o-key', p, `storage_key='reports/x/1'`);
    await expectCode(
      `INSERT INTO reports (owner_id, patient_id, type, original_filename, size_bytes, storage_key, sha256, content_type)
       VALUES ('o-key', '${p}', 'vcf', 'b.vcf', 5, 'reports/x/1', '${sha}', 'text/plain')`,
      '23505',
    );
  });

  it('composite foreign keys stop a child pointing at another owner’s parent', async () => {
    const mine = await patient('o-fk1', 'SYN-FK1');
    await expectCode(
      `INSERT INTO reports (owner_id, patient_id, type, original_filename, size_bytes) VALUES ('o-fk2', '${mine}', 'vcf', 'a.vcf', 1)`,
      '23503',
    );
    const rep = await report('o-fk1', mine);
    const theirs = await patient('o-fk2', 'SYN-FK2');
    await expectCode(
      `INSERT INTO recommendations (owner_id, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version)
       VALUES ('o-fk2', '${theirs}', '${rep}', 'G', 'd', 'p', 's', 'Strong', 'v')`,
      '23503',
    );
    await expectCode(
      `INSERT INTO recommendations (owner_id, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version)
       VALUES ('o-fk1', '${mine}', '${rep}', 'G', 'd', 'p', 's', 'Mandatory', 'v')`,
      '23514',
    );
  });

  it('RESTRICT: hard delete is refused while children exist, and so is soft delete', async () => {
    const p = await patient('o-rs', 'SYN-RS');
    const r = await report('o-rs', p);
    await expectCode('DELETE FROM patients WHERE id = $1', '23503', [p]);
    await expectCode('UPDATE patients SET deleted_at = now() WHERE id = $1', '23503', [p]);
    await q(
      `INSERT INTO recommendations (owner_id, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version)
       VALUES ('o-rs', $1, $2, 'G', 'd', 'p', 's', 'Strong', 'v')`,
      [p, r],
    );
    await expectCode('UPDATE reports SET deleted_at = now() WHERE id = $1', '23503', [r]);
  });

  it('updated_at moves on its own, but an explicit value from the application is respected', async () => {
    const id = await patient('o-ts', 'SYN-TS');
    const before = (await q('SELECT updated_at FROM patients WHERE id = $1', [id])).rows[0].updated_at as Date;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await q(`UPDATE patients SET label = 'SYN-TS2' WHERE id = $1`, [id]);
    const bumped = (await q('SELECT updated_at FROM patients WHERE id = $1', [id])).rows[0].updated_at as Date;
    expect(bumped.getTime()).toBeGreaterThan(before.getTime());
    await q(`UPDATE patients SET label = 'SYN-TS3', updated_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [id]);
    const explicit = (await q('SELECT updated_at FROM patients WHERE id = $1', [id])).rows[0].updated_at as Date;
    expect(explicit.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('is on the cluster the tests think it is', () => {
    expect(adminUrl()).toMatch(/^postgres/);
  });
});
