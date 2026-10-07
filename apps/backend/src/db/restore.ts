import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { type BackupManifest, opensslEncrypt, sha256File } from './backup';
import { pgEnv, quoteIdent, run } from './pg-process';

export interface RestoreOptions {
  /** A superuser on the TARGET server. The database named in the URL is not touched. */
  adminUrl: string;
  backupDir: string;
  passphraseFile?: string;
  /** Keep the restored database afterwards (a real recovery). Default: a throwaway that is dropped. */
  keep?: boolean;
  /** Restore into this named database instead of a random throwaway one. Implies keep. */
  targetDatabase?: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RestoreReport {
  ok: boolean;
  database: string;
  kept: boolean;
  checks: Check[];
}

const SAFE_DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Restores a backup into a fresh database and PROVES it is a faithful, working copy:
 * file integrity, row counts against the baseline taken inside the backup's own snapshot,
 * migrations, schema shape, and that row-level security still isolates owners.
 * Never touches an existing database. Exits "not ok" rather than guessing.
 */
export async function restoreAndVerify(options: RestoreOptions): Promise<RestoreReport> {
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const manifest = JSON.parse(readFileSync(join(options.backupDir, 'manifest.json'), 'utf8')) as BackupManifest;
  const dumpPath = join(options.backupDir, manifest.dump.file);
  const database = options.targetDatabase ?? `restore_check_${randomBytes(5).toString('hex')}`;
  const keep = Boolean(options.keep || options.targetDatabase);
  const failed = (): RestoreReport => ({ ok: false, database, kept: false, checks });

  if (!SAFE_DB_NAME.test(database)) throw new Error('Target database name must be lowercase letters, digits and underscores');

  // 1. The backup file is exactly what was written.
  if (!existsSync(dumpPath)) {
    record('backup file present', false, manifest.dump.file);
    return failed();
  }
  const actualSha = await sha256File(dumpPath);
  record('backup file checksum', actualSha === manifest.dump.sha256, actualSha === manifest.dump.sha256 ? 'matches manifest' : 'DOES NOT match manifest (file corrupted or altered)');
  if (actualSha !== manifest.dump.sha256) return failed();

  // 2. Decrypt into a private temp dir (removed no matter what).
  const workDir = mkdtempSync(join(tmpdir(), 'restore-'));
  try {
    let restoreFrom = dumpPath;
    if (manifest.dump.encrypted) {
      if (!options.passphraseFile) {
        record('decrypt', false, 'backup is encrypted but no passphrase file was given');
        return failed();
      }
      restoreFrom = join(workDir, 'db.dump');
      try {
        await opensslEncrypt(dumpPath, restoreFrom, options.passphraseFile, true);
      } catch {
        record('decrypt', false, 'could not decrypt (wrong passphrase?)');
        return failed();
      }
      const plain = await sha256File(restoreFrom);
      record('decrypted checksum', plain === manifest.dump.plaintextSha256, plain === manifest.dump.plaintextSha256 ? 'matches manifest' : 'DOES NOT match manifest');
      if (plain !== manifest.dump.plaintextSha256) return failed();
    }

    // 3. Restore into a brand-new database.
    const admin = new Client({ connectionString: options.adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
    } finally {
      await admin.end();
    }
    const restoredUrl = withDatabase(options.adminUrl, database);

    try {
      await run('pg_restore', ['--exit-on-error', '--no-owner', `--dbname=${database}`, restoreFrom], pgEnv(options.adminUrl, database));
      record('pg_restore', true, 'completed without errors');
      await verify(restoredUrl, manifest, record);
    } catch (error) {
      record('pg_restore', false, (error as Error).message.slice(0, 300));
    } finally {
      if (!keep) await dropDatabase(options.adminUrl, database);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  return { ok: checks.every((c) => c.ok), database, kept: keep && checks.every((c) => c.ok), checks };
}

async function dropDatabase(adminUrl: string, database: string) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function verify(url: string, manifest: BackupManifest, record: (n: string, ok: boolean, d: string) => void) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    // Row counts: the restored database against the baseline taken in the backup's OWN snapshot.
    const names = (await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
    const expectedNames = Object.keys(manifest.tables).sort();
    record('tables present', JSON.stringify(names) === JSON.stringify(expectedNames), names.join(', '));

    const mismatches: string[] = [];
    for (const name of expectedNames) {
      if (!names.includes(name)) continue;
      const n = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoteIdent(name)}`)).rows[0]!.n);
      if (n !== manifest.tables[name]!.rows) mismatches.push(`${name}: restored ${n}, expected ${manifest.tables[name]!.rows}`);
    }
    const total = expectedNames.reduce((sum, name) => sum + manifest.tables[name]!.rows, 0);
    record('row counts', mismatches.length === 0, mismatches.length === 0 ? `all ${expectedNames.length} tables match (${total} rows)` : mismatches.join('; '));

    const migrations = names.includes('schema_migrations')
      ? (await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)
      : [];
    record('migrations', JSON.stringify(migrations) === JSON.stringify(manifest.migrations), migrations.join(', ') || '(none)');

    const count = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);
    const schema = {
      constraints: await count(`SELECT count(*) AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace`),
      indexes: await count(`SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public'`),
      triggers: await count(`SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal`),
    };
    record('schema shape (constraints, indexes, triggers)', JSON.stringify(schema) === JSON.stringify(manifest.schema), JSON.stringify(schema));

    // Row-level security survived, and still isolates owners.
    const flags = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );
    const policies = await db.query<{ tablename: string; n: number }>(`SELECT tablename, count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename`);
    const rlsProblems = expectedNames.filter((name) => {
      const want = manifest.tables[name]!;
      const flag = flags.rows.find((f) => f.relname === name);
      return flag?.relrowsecurity !== want.rlsEnabled || flag?.relforcerowsecurity !== want.rlsForced || (policies.rows.find((p) => p.tablename === name)?.n ?? 0) !== want.policies;
    });
    record('row-level security settings', rlsProblems.length === 0, rlsProblems.length === 0 ? 'enabled, forced and policies intact' : `changed: ${rlsProblems.join(', ')}`);

    await verifyIsolation(db, expectedNames.filter((name) => manifest.tables[name]!.rlsEnabled), record);
  } finally {
    await db.end();
  }
}

/** Acts as the application role: with no owner it must see nothing; with one owner, exactly that owner's rows. */
async function verifyIsolation(db: Client, tables: string[], record: (n: string, ok: boolean, d: string) => void) {
  const role = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = 'telesphoros_app'`);
  if (role.rowCount === 0) {
    record('row-level security isolation', false, `role telesphoros_app does not exist on this server; create it (migration 0002) before relying on this restore`);
    return;
  }
  const problems: string[] = [];
  for (const table of tables) {
    const owner = (await db.query<{ owner_id: string }>(`SELECT owner_id FROM ${quoteIdent(table)} LIMIT 1`)).rows[0]?.owner_id;
    if (owner === undefined) continue; // an empty table proves nothing and breaks nothing
    const expected = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoteIdent(table)} WHERE owner_id = $1`, [owner])).rows[0]!.n);
    for (const scenario of ['with owner', 'without owner'] as const) {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE telesphoros_app');
        if (scenario === 'with owner') await db.query(`SELECT set_config('app.current_owner_id', $1, true)`, [owner]);
        const seen = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoteIdent(table)}`)).rows[0]!.n);
        const want = scenario === 'with owner' ? expected : 0;
        if (seen !== want) problems.push(`${table} ${scenario}: saw ${seen}, expected ${want}`);
      } finally {
        await db.query('ROLLBACK');
      }
    }
  }
  record('row-level security isolation', problems.length === 0, problems.length === 0 ? `owners isolated on ${tables.length} tables` : problems.join('; '));
}
