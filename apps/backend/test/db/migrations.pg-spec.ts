import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'pg';
import { loadMigrations, MIGRATIONS_DIR, type Compat, migrateDown, migrateUp, migrationReadiness, migrationStatus, MigrationError, pendingMigrations } from '../../src/db/migrator';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { allVersions, revertAbove } from '../helpers/migration-history';

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

/**
 * The migrations that ship, read from the directory: adding a migration edits no list here. What pins the history (a gap, a repeat, an edited,
 * removed or renumbered shipped file) is test/migration-history.spec.ts, which needs no database.
 */
const SHIPPED = allVersions();
/** The first migration that creates append-only audit tables: reverting it (and everything after it) needs the explicit setting. */
const FIRST_AUDIT_MIGRATION = '0005';
const nextVersion = String(SHIPPED.length + 1).padStart(4, '0');
/** The version `offset` places after the last shipped one (1 = the next migration to be written). */
const version = (offset: number) => String(SHIPPED.length + offset).padStart(4, '0');
/** Writes a harmless additive migration into a copy of the migrations directory, with or without a compat label. */
const addMigration = (dir: string, offset: number, label: Compat | undefined) => {
  const name = `${version(offset)}_t_compat_${offset}`;
  writeFileSync(join(dir, `${name}.up.sql`), `${label ? `-- compat: ${label}\n` : ''}CREATE TABLE t_compat_${offset} (id integer);`);
  writeFileSync(join(dir, `${name}.down.sql`), `DROP TABLE t_compat_${offset};`);
};

/** Reverts `steps` migrations in one session that has the audit-drop setting on, as an operator would on purpose. */
const down = (db: EphemeralDatabase, steps: number) =>
  withAdmin(db.adminUrl, async (c) => {
    await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
    return migrateDown(c, steps);
  });

describe('migration runner', () => {
  it('ships a non-empty up and down for every migration (the history itself is pinned in test/migration-history.spec.ts)', () => {
    for (const migration of loadMigrations()) {
      expect(migration.upSql.length).toBeGreaterThan(0);
      expect(migration.downSql.length).toBeGreaterThan(0);
    }
  });

  it('applies every migration in order, and a second run does nothing', async () => {
    const db = await emptyDb();
    expect(await run(db, (c) => migrateUp(c))).toEqual(SHIPPED);
    expect(await run(db, (c) => migrateUp(c))).toEqual([]);
    const status = await run(db, (c) => migrationStatus(c));
    expect(status.applied.map((m) => m.version)).toEqual(SHIPPED);
    expect(status.pending).toEqual([]);
  });

  it('reverts step by step, and can re-apply after a full revert', async () => {
    const db = await emptyDb();
    await run(db, (c) => migrateUp(c));
    expect(await down(db, 1)).toEqual([SHIPPED[SHIPPED.length - 1]]);
    expect((await run(db, (c) => migrationStatus(c))).pending.map((m) => m.version)).toEqual([SHIPPED[SHIPPED.length - 1]]);
    expect(await down(db, SHIPPED.length)).toEqual(SHIPPED.slice(0, -1).reverse());
    const tables = await run(db, (c) => c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`));
    expect(tables.rows).toEqual([]);
    // Functions go too (roles are cluster-wide and stay, like telesphoros_app).
    const functions = await run(db, (c) => c.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace`));
    expect(functions.rows).toEqual([]);
    expect(await run(db, (c) => migrateUp(c))).toEqual(SHIPPED);
  });

  it('refuses to revert the audit tables unless the session says so on purpose (and only the exact word counts)', async () => {
    const db = await emptyDb();
    await run(db, (c) => migrateUp(c));
    // 0011 removes the incident tables, so it needs the setting like the other audit migrations. 0010 only guards a database that holds
    // evidence identities (tested in report-evidence), so on an empty one it reverts freely; the audit migrations start below it.
    // 0021 (merge records and duplicate flags) and 0020 (patient-link decisions) hold audit records: both are guarded like the other audit migrations.
    // 0023 (the job queue) reverts freely while no attempt is recorded, and so does 0022 (intake rejections) while no rejection is recorded; the guards on populated ones are tested in jobs and security-events.
    // 0028 (the tenant capability) reverts freely while its issuance log is empty; the guard on a populated one is tested in tenant-capability.
    // 0029 (the synthetic agentic fixtures) reverts freely while none of its tables holds a row; the guard on a populated one is tested in the ai-service durable schema-roles suite.
    const aboveMerge = revertAbove('patient_duplicates_and_merge'); // everything above 0021, whatever has been added since
    expect(await down(db, aboveMerge.steps)).toEqual(aboveMerge.reverted);
    await expect(run(db, (c) => migrateDown(c, 1))).rejects.toThrow(/Refusing to drop patient merge records/);
    expect(await down(db, 1)).toEqual(['0021']);
    await expect(run(db, (c) => migrateDown(c, 1))).rejects.toThrow(/Refusing to drop patient-link decisions/);
    expect(await down(db, 1)).toEqual(['0020']);
    expect(await run(db, (c) => migrateDown(c, 8))).toEqual(['0019', '0018', '0017', '0016', '0015', '0014', '0013', '0012']);
    await expect(run(db, (c) => migrateDown(c, 1))).rejects.toThrow(/Refusing to drop ledger incidents/);
    expect(await down(db, 1)).toEqual(['0011']);
    expect(await run(db, (c) => migrateDown(c, 1))).toEqual(['0010']);
    const SHIPPED_NOW = SHIPPED.slice(0, SHIPPED.indexOf('0010'));
    const attempt = (setting: string | null) =>
      run(db, async (c) => {
        if (setting !== null) await c.query(`SET telesphoros.allow_audit_drop = '${setting}'`);
        return migrateDown(c, 1);
      });
    // Never set (SQL NULL), empty, wrong case, wrong words: all refused, and nothing was reverted.
    for (const setting of [null, '', 'YES', 'Yes', 'true', 'on', '1', 'yes ', ' yes']) {
      await expect(attempt(setting)).rejects.toThrow(/Refusing to drop|audit/i);
    }
    expect((await run(db, (c) => migrationStatus(c))).applied.map((m) => m.version)).toEqual(SHIPPED_NOW);
    // A setting that was used and then ended in the same session reads '' afterwards, not NULL, and still refuses.
    await run(db, async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL telesphoros.allow_audit_drop = 'yes'`);
      await c.query('COMMIT');
      await expect(migrateDown(c, 1)).rejects.toThrow(/Refusing to drop/);
    });
    // The migrations BEFORE the first audit one revert without it (they hold no audit data).
    const early = await run(db, async (c) => {
      await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
      return migrateDown(c, SHIPPED_NOW.length - SHIPPED_NOW.indexOf(FIRST_AUDIT_MIGRATION));
    });
    expect(early[early.length - 1]).toBe(FIRST_AUDIT_MIGRATION);
    expect(await run(db, (c) => migrateDown(c, 1))).toEqual(['0004']); // no setting needed
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
    writeFileSync(join(dir, `${nextVersion}_broken.up.sql`), 'CREATE TABLE half_done (id int); SELECT 1/0;');
    writeFileSync(join(dir, `${nextVersion}_broken.down.sql`), 'DROP TABLE IF EXISTS half_done;');
    await expect(run(db, (c) => migrateUp(c, dir))).rejects.toThrow(new RegExp(`Migration ${nextVersion} failed and was rolled back`));
    const left = await run(db, (c) => c.query(`SELECT to_regclass('public.half_done') AS t`));
    expect(left.rows[0].t).toBeNull();
    expect((await run(db, (c) => migrationStatus(c))).applied.map((m) => m.version)).toEqual(SHIPPED);
  });

  it('is safe when two deploys start at the same moment (advisory lock)', async () => {
    const db = await emptyDb();
    const results = await Promise.all([run(db, (c) => migrateUp(c)), run(db, (c) => migrateUp(c))]);
    expect(results.flat().sort()).toEqual(SHIPPED); // each migration applied exactly once, no error
  });

  it('reports pending migrations read-only (what /ready relies on)', async () => {
    const db = await emptyDb();
    expect(await run(db, (c) => pendingMigrations(c))).toEqual(SHIPPED);
    await run(db, (c) => migrateUp(c));
    expect(await run(db, (c) => pendingMigrations(c))).toEqual([]);
  });

  it('validates readiness history using only the non-owner runtime login in a read-only transaction', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    // withAdmin is a short-lived connection helper: passing appUrl uses the real restricted login.
    await withAdmin(db.appUrl, async (c) => {
      const {
        rows: [role],
      } = await c.query(`SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
        pg_has_role(current_user, t.relowner, 'MEMBER') AS owns_history,
        has_table_privilege(current_user, 'schema_migrations', 'SELECT') AS can_read,
        has_table_privilege(current_user, 'schema_migrations', 'INSERT') AS can_insert,
        has_table_privilege(current_user, 'schema_migrations', 'UPDATE') AS can_update,
        has_table_privilege(current_user, 'schema_migrations', 'DELETE') AS can_delete
        FROM pg_roles r CROSS JOIN pg_class t WHERE r.rolname = current_user AND t.oid = 'schema_migrations'::regclass`);
      expect(role).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        owns_history: false,
        can_read: true,
        can_insert: false,
        can_update: false,
        can_delete: false,
      });
      await expect(c.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', ['refused', SHIPPED[0]])).rejects.toMatchObject({ code: '42501' });
      const before = (await c.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
      await c.query('BEGIN READ ONLY');
      try {
        await expect(pendingMigrations(c)).resolves.toEqual([]);
      } finally {
        await c.query('ROLLBACK');
      }
      expect((await c.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(before);
    });
    await run(db, (c) => c.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', ['t02-drift', SHIPPED[0]]));
    await withAdmin(db.appUrl, async (c) => {
      await c.query('BEGIN READ ONLY');
      try {
        await expect(pendingMigrations(c)).rejects.toBeInstanceOf(MigrationError);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it.each(['up', 'down', 'missing pair'] as const)('rejects shipped artifact drift: %s', async (fault) => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const dir = tempMigrations();
    await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c, dir))).resolves.toEqual([]);
    if (fault === 'missing pair') rmSync(join(dir, '0001_core_tables.down.sql'));
    else writeFileSync(join(dir, `0001_core_tables.${fault}.sql`), '\n-- T02 changed artifact\n', { flag: 'a' });
    await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c, dir))).rejects.toBeInstanceOf(MigrationError);
    await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c))).resolves.toEqual([]);
  });

  it('enforces the strict N/N+1 history matrix even for an additive migration', async () => {
    const db = await createEphemeralDatabase();
    dbs.push(db);
    const newer = tempMigrations();
    writeFileSync(join(newer, `${nextVersion}_t02_expansion.up.sql`), 'CREATE TABLE t02_expansion (id integer);');
    writeFileSync(join(newer, `${nextVersion}_t02_expansion.down.sql`), 'DROP TABLE t02_expansion;');
    await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c))).resolves.toEqual([]); // N / N
    await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c, newer))).resolves.toEqual([nextVersion]); // N+1 / N
    expect(await run(db, (c) => migrateUp(c, newer))).toEqual([nextVersion]);
    await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c))).rejects.toBeInstanceOf(MigrationError); // N / N+1
    await expect(withAdmin(db.appUrl, (c) => pendingMigrations(c, newer))).resolves.toEqual([]); // N+1 / N+1
  });

  it("records each migration's compat label, and an unlabeled one is stored as breaking", async () => {
    const db = await emptyDb();
    const dir = tempMigrations();
    addMigration(dir, 1, 'expand');
    addMigration(dir, 2, undefined);
    await run(db, (c) => migrateUp(c, dir));
    const rows = (await run(db, (c) => c.query('SELECT version, compat FROM schema_migrations ORDER BY version'))).rows;
    // Shipped migrations before the label carry none (stored as breaking); from 0028 on each states its own.
    expect(rows.slice(0, SHIPPED.length).map((r) => [r.version, r.compat])).toEqual(loadMigrations().map((m) => [m.version, m.compat]));
    expect(rows.slice(SHIPPED.length)).toEqual([
      { version: version(1), compat: 'expand' },
      { version: version(2), compat: 'breaking' },
    ]);
  });

  it('adds the compat column to a database an older migrator created, without touching its rows', async () => {
    const db = await emptyDb();
    await run(db, (c) => migrateUp(c));
    await run(db, (c) => c.query('ALTER TABLE schema_migrations DROP COLUMN compat'));
    await expect(run(db, (c) => migrationReadiness(c))).resolves.toEqual({ pending: [], tolerated: [] }); // nothing newer: the column is never read
    await run(db, (c) => migrateUp(c));
    const rows = (await run(db, (c) => c.query('SELECT version, compat FROM schema_migrations ORDER BY version'))).rows;
    expect(rows.map((r) => r.version)).toEqual(SHIPPED);
    expect(rows.every((r) => r.compat === null)).toBe(true); // legacy rows stay NULL, which reads as breaking
  });

  describe('readiness across a rolling deploy (the database is ahead of the code)', () => {
    /** A database migrated by the NEWER code (`newer` has extra migrations), probed by the OLDER code as the restricted runtime login. */
    const aheadOfCode = async (...labels: (Compat | undefined)[]) => {
      const db = await createEphemeralDatabase();
      dbs.push(db);
      const newer = tempMigrations();
      labels.forEach((label, index) => addMigration(newer, index + 1, label));
      expect(await run(db, (c) => migrateUp(c, newer))).toEqual(labels.map((_l, index) => version(index + 1)));
      return { db, newer };
    };
    const asRuntimeLogin = <T>(db: EphemeralDatabase, work: (c: Client) => Promise<T>) =>
      withAdmin(db.appUrl, async (c) => {
        await c.query('BEGIN READ ONLY');
        try {
          return await work(c);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    const readiness = (db: EphemeralDatabase) => asRuntimeLogin(db, (c) => migrationReadiness(c));

    it('tolerates newer migrations that are all expand, using only the read-only runtime login', async () => {
      const { db, newer } = await aheadOfCode('expand');
      await expect(readiness(db)).resolves.toEqual({ pending: [], tolerated: [version(1)] }); // N / N+1
      await expect(asRuntimeLogin(db, (c) => migrationReadiness(c, newer))).resolves.toEqual({ pending: [], tolerated: [] }); // N+1 / N+1
      const two = await aheadOfCode('expand', 'expand');
      await expect(readiness(two.db)).resolves.toEqual({ pending: [], tolerated: [version(1), version(2)] });
    });

    it('leaves the migrator strict: it still refuses history it does not know', async () => {
      const { db } = await aheadOfCode('expand');
      await expect(run(db, (c) => migrateUp(c))).rejects.toThrow(/does not know/);
      await expect(run(db, (c) => migrateDown(c, 1))).rejects.toThrow(/does not know/);
      await expect(run(db, (c) => migrationStatus(c))).rejects.toBeInstanceOf(MigrationError);
      await expect(run(db, (c) => pendingMigrations(c))).rejects.toBeInstanceOf(MigrationError);
    });

    it.each([
      ['a breaking migration', ['breaking']],
      ['an unlabeled migration', [undefined]],
      ['an expand then a breaking migration', ['expand', 'breaking']],
      ['a breaking then an expand migration', ['breaking', 'expand']],
    ] as const)('refuses %s', async (_name, labels) => {
      const { db } = await aheadOfCode(...labels);
      await expect(readiness(db)).rejects.toThrow(/not declared expand/);
    });

    it('refuses a newer migration whose stored label is missing or unreadable', async () => {
      const { db } = await aheadOfCode('expand');
      await run(db, (c) => c.query('UPDATE schema_migrations SET compat = NULL WHERE version = $1', [version(1)]));
      await expect(readiness(db)).rejects.toThrow(/not declared expand/);
      for (const stray of ['Expand', 'additive', 'expand ', '']) {
        // anything but the exact text 'expand' is not a promise
        await run(db, (c) => c.query('UPDATE schema_migrations SET compat = $1 WHERE version = $2', [stray, version(1)]));
        await expect(readiness(db)).rejects.toThrow(/not declared expand/);
      }
      await run(db, (c) => c.query(`UPDATE schema_migrations SET compat = 'expand' WHERE version = $1`, [version(1)]));
      await expect(readiness(db)).resolves.toMatchObject({ tolerated: [version(1)] });
      await run(db, (c) => c.query('ALTER TABLE schema_migrations DROP COLUMN compat')); // no column at all: nothing can be trusted
      await expect(readiness(db)).rejects.toThrow(/not declared expand/);
    });

    it('still refuses drift in the history this code knows, even with only expand migrations ahead', async () => {
      const { db } = await aheadOfCode('expand');
      await run(db, (c) => c.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', ['t-drift', SHIPPED[0]]));
      await expect(readiness(db)).rejects.toThrow(/modified after it was applied/);
      const gap = await aheadOfCode('expand');
      await run(gap.db, (c) => c.query('DELETE FROM schema_migrations WHERE version = $1', [SHIPPED[1]]));
      await expect(readiness(gap.db)).rejects.toBeInstanceOf(MigrationError);
    });

    it('refuses newer history that does not continue the numbering, even if it is labeled expand', async () => {
      const { db } = await aheadOfCode('expand');
      await run(db, (c) => c.query(`INSERT INTO schema_migrations (version, name, checksum, compat) VALUES ($1, 't_gap', 'x', 'expand')`, [version(3)]));
      await expect(readiness(db)).rejects.toThrow(/not contiguous/);
    });

    it('still reports pending migrations (the database is behind the code), and tolerates nothing then', async () => {
      const db = await createEphemeralDatabase();
      dbs.push(db);
      await run(db, (c) => c.query('DELETE FROM schema_migrations WHERE version = $1', [SHIPPED.at(-1)]));
      await expect(readiness(db)).resolves.toEqual({ pending: [SHIPPED.at(-1)], tolerated: [] });
    });
  });

  it('rejects incomplete or gapped migration sets', () => {
    const dir = tempMigrations();
    rmSync(join(dir, '0002_row_level_security.down.sql'));
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
    const gap = tempMigrations();
    for (const file of readdirSync(gap).filter((f) => f.startsWith('0002'))) rmSync(join(gap, file));
    expect(() => loadMigrations(gap)).toThrow(/gap/);
    const extra = tempMigrations();
    writeFileSync(join(extra, '9999_x.up.sql'), 'SELECT 1;');
    writeFileSync(join(extra, '9999_x.down.sql'), 'SELECT 1;');
    expect(() => loadMigrations(extra)).toThrow(/gap/);
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
  const patient = async (tenant: string, label: string) =>
    (await q('INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, $1, $2) RETURNING id', [tenant, label])).rows[0].id as string;
  const report = async (tenant: string, patientId: string, extra = '') =>
    (
      await q(
        `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1, $1, $2, 'structured', 'a.json', 100${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`,
        [tenant, patientId],
      )
    ).rows[0].id as string;

  it('every foreign key states ON DELETE RESTRICT explicitly (the rule, not a list of names: a new table is held to it too)', async () => {
    const { rows } = await q(`SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' ORDER BY conname`);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.filter((r) => r.confdeltype !== 'r').map((r) => r.conname)).toEqual([]);
    // The original is still there.
    expect(rows.map((r) => r.conname)).toContain('reports_patient_fk');
  });

  it('ids are UUIDs generated by the database, and every table has NOT NULL created_at / updated_at', async () => {
    const cols = await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
                           WHERE table_schema = 'public' AND table_name IN ('patients','reports')`);
    for (const table of ['patients', 'reports']) {
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
      'patients_tenant_label_uq',
      'patients_tenant_seq_idx',
      'reports_storage_key_uq',
      'reports_tenant_seq_idx',
      'reports_tenant_patient_idx',
      'reports_patient_idx',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('enforces the label rules and uniqueness (case-insensitive, per tenant, live rows only)', async () => {
    await expectCode(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('o1', 'o1', 'Jane Doe')`, '23514');
    await expectCode(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('o1', 'o1', '')`, '23514');
    await expectCode(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('', '', 'SYN-1')`, '23514');
    const id = await patient('o-uq', 'SYN-UQ');
    await expectCode(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('o-uq', 'o-uq', 'syn-uq')`, '23505');
    await patient('o-other', 'SYN-UQ'); // another tenant may reuse it
    await q('UPDATE patients SET deleted_at = now() WHERE id = $1', [id]);
    await patient('o-uq', 'SYN-UQ'); // a soft-deleted row frees its label
  });

  it('validates report fields', async () => {
    const p = await patient('o-rf', 'SYN-RF');
    const bad = (cols: string, vals: string) => expectCode(`INSERT INTO reports (tenant_id, created_by, patient_id, ${cols}) VALUES ('o-rf', 'o-rf', '${p}', ${vals})`, '23514');
    await bad('type, original_filename, size_bytes', `'pdf', 'a.json', 10`);
    await bad('type, original_filename, size_bytes', `'structured', '../a.json', 10`);
    await bad('type, original_filename, size_bytes', `'structured', 'a.json', 0`);
    await bad('type, original_filename, size_bytes', `'structured', 'a.json', 10485761`);
    await bad('type, original_filename, size_bytes, status', `'structured', 'a.json', 10, 'done'`);
    await bad('type, original_filename, size_bytes, sha256', `'structured', 'a.json', 10, '${'A'.repeat(64)}'`);
    await bad('type, original_filename, size_bytes, uploaded_at', `'structured', 'a.json', 10, now()`); // uploaded needs key+sha+type
  });

  it('never lets the same object key be registered twice', async () => {
    const p = await patient('o-key', 'SYN-KEY');
    const sha = 'a'.repeat(64);
    await report('o-key', p, `storage_key='reports/x/1'`);
    await expectCode(
      `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes, storage_key, sha256, content_type)
       VALUES ('o-key', 'o-key', '${p}', 'structured', 'b.json', 5, 'reports/x/1', '${sha}', 'text/plain')`,
      '23505',
    );
  });

  it('composite foreign keys stop a child pointing at another tenant’s parent', async () => {
    const mine = await patient('o-fk1', 'SYN-FK1');
    await expectCode(
      `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes) VALUES ('o-fk2', 'o-fk2', '${mine}', 'structured', 'a.json', 1)`,
      '23503',
    );
  });

  it('RESTRICT: hard delete is refused while children exist, and so is soft delete (a report with evaluations: drop-recommendations.pg-spec.ts)', async () => {
    const p = await patient('o-rs', 'SYN-RS');
    await report('o-rs', p);
    await expectCode('DELETE FROM patients WHERE id = $1', '23503', [p]);
    await expectCode('UPDATE patients SET deleted_at = now() WHERE id = $1', '23503', [p]);
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
