import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import { pgEnv, quoteIdent, run } from './pg-process';

export interface TableFacts {
  rows: number;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: number;
}

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  serverVersion: string;
  database: string;
  migrations: string[];
  /** Counts include soft-deleted rows: they are part of the audit trail and must survive a restore. */
  tables: Record<string, TableFacts>;
  schema: { constraints: number; indexes: number; triggers: number };
  dump: { file: string; bytes: number; sha256: string; plaintextSha256: string; encrypted: boolean };
}

export interface BackupOptions {
  /** A role that can read every row: a superuser or one with BYPASSRLS. NEVER the application role. */
  adminUrl: string;
  destDir: string;
  /** If set, the dump is encrypted at rest (AES-256-CBC, PBKDF2) with the passphrase in this file. */
  passphraseFile?: string;
  upload?: { client: S3Client; bucket: string; prefix: string; kmsKeyId?: string };
  /** Test seam: runs after the snapshot is taken and before the dump starts (to prove snapshot consistency). */
  afterSnapshot?: () => Promise<void>;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function opensslEncrypt(input: string, output: string, passphraseFile: string, decrypt = false) {
  await run('openssl', [
    'enc', decrypt ? '-d' : '-e', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-salt',
    '-in', input, '-out', output, '-pass', `file:${passphraseFile}`,
  ]);
}

/**
 * Takes a consistent logical backup.
 *
 * The facts in the manifest (row counts, migrations, schema shape) are read INSIDE the same
 * exported snapshot that pg_dump then uses. A count taken on another connection, even a second
 * earlier, measures a different moment than the copy; restore verification would then raise false
 * alarms on a busy database, or worse, learn to be ignored.
 */
export async function createBackup(options: BackupOptions): Promise<{ dir: string; manifest: BackupManifest }> {
  if (options.passphraseFile && readFileSync(options.passphraseFile, 'utf8').trim().length < 16) {
    throw new Error('The passphrase file is empty or too short (need at least 16 characters). Nothing was backed up.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(options.destDir, `backup-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const client = new Client({ connectionString: options.adminUrl });
  await client.connect();
  let manifest: BackupManifest;
  try {
    const who = await client.query<{ ok: boolean }>(
      'SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user',
    );
    if (!who.rows[0]?.ok) {
      throw new Error('The backup role must be a superuser or have BYPASSRLS; otherwise row-level security would silently hide rows from the backup.');
    }

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0]!.id;

    const facts = await readFacts(client);
    await options.afterSnapshot?.();

    const plainFile = join(dir, 'db.dump');
    await run(
      'pg_dump',
      ['--format=custom', `--snapshot=${snapshot}`, '--no-owner', `--file=${plainFile}`],
      pgEnv(options.adminUrl),
    );
    await client.query('COMMIT'); // the snapshot only needs to live until pg_dump has finished
    // pg_dump creates the file with the process umask (typically world-readable). A backup of clinical
    // data is owner-only, whatever happens to the directory later (copied, synced, uploaded).
    chmodSync(plainFile, 0o600);

    const plaintextSha256 = await sha256File(plainFile);
    let dumpFile = plainFile;
    if (options.passphraseFile) {
      dumpFile = `${plainFile}.enc`;
      await opensslEncrypt(plainFile, dumpFile, options.passphraseFile);
      chmodSync(dumpFile, 0o600);
      rmSync(plainFile); // plaintext PHI must not linger next to its encrypted copy
    }

    manifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      ...facts,
      dump: {
        file: dumpFile.slice(dir.length + 1),
        bytes: statSync(dumpFile).size,
        sha256: await sha256File(dumpFile),
        plaintextSha256,
        encrypted: Boolean(options.passphraseFile),
      },
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  } catch (error) {
    // A half-written backup is worse than none: it may hold an UNENCRYPTED dump and no manifest to say so.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    await client.end();
  }

  // The local backup is complete and valid here; if the off-site copy fails, it stays (and the error is reported).
  if (options.upload) await uploadBackup(dir, manifest, options.upload);
  return { dir, manifest };
}

async function readFacts(client: Client) {
  const version = (await client.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]!.v;
  const database = (await client.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d;

  const migrationsTable = await client.query<{ present: boolean }>(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`);
  const migrations = migrationsTable.rows[0]!.present
    ? (await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)
    : [];

  const tableNames = (await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
  const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
  );
  const policies = await client.query<{ tablename: string; n: number }>(
    `SELECT tablename, count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename`,
  );

  const tables: Record<string, TableFacts> = {};
  for (const name of tableNames) {
    const rows = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoteIdent(name)}`)).rows[0]!.n);
    const flag = flags.rows.find((f) => f.relname === name);
    tables[name] = {
      rows,
      rlsEnabled: flag?.relrowsecurity ?? false,
      rlsForced: flag?.relforcerowsecurity ?? false,
      policies: policies.rows.find((p) => p.tablename === name)?.n ?? 0,
    };
  }

  const count = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]!.n);
  const schema = {
    constraints: await count(`SELECT count(*) AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace`),
    indexes: await count(`SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public'`),
    triggers: await count(
      `SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal`,
    ),
  };
  return { serverVersion: version, database, migrations, tables, schema };
}

/** Off-site copy. The manifest goes up LAST, so a backup is only "there" once it is complete. */
export async function uploadBackup(
  dir: string,
  manifest: BackupManifest,
  target: NonNullable<BackupOptions['upload']>,
) {
  const put = async (file: string) => {
    const path = join(dir, file);
    await target.client.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: `${target.prefix.replace(/\/$/, '')}/${dir.split('/').pop()}/${file}`,
        Body: createReadStream(path),
        ContentLength: statSync(path).size,
        ServerSideEncryption: 'aws:kms',
        ...(target.kmsKeyId ? { SSEKMSKeyId: target.kmsKeyId } : {}),
      }),
    );
  };
  await put(manifest.dump.file);
  await put('manifest.json');
}
