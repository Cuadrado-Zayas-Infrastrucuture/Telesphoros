import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { encryptFile, manifestMac, readKeyFile } from './backup-crypto';
import type { BackupManifest, BackupManifestV1, BackupManifestV2, TableFacts } from './backup-manifest';
import { type UploadResult, type UploadTarget, uploadBackup } from './offsite';
import { readPrivilegeFacts } from './privilege-facts';
import { pgEnv, quoteIdent, run } from './pg-process';
import { pgClientConfig } from './tls';

export type { BackupManifest, TableFacts };

export interface BackupOptions {
  /** A role that can read every row: a superuser or one with BYPASSRLS. NEVER the application role. */
  adminUrl: string;
  destDir: string;
  /**
   * If set, the dump is encrypted with authenticated encryption (AES-256-GCM, chunked) under the 32-byte key in this file,
   * and the manifest is signed (format 2). Without it the backup is NOT encrypted (format 1): development and tests only.
   */
  keyFile?: string;
  /** Off-site copy (needs `keyFile`: only encrypted, signed backups leave the machine). */
  upload?: UploadTarget;
  /** After a verified upload, delete the local copy so the backup host keeps nothing. */
  removeLocalAfterUpload?: boolean;
  /** Test seam: runs after the snapshot is taken and before the dump starts (to prove snapshot consistency). */
  afterSnapshot?: () => Promise<void>;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Format 1 only: kept so old backups can still be read. New backups never use it. */
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
export async function createBackup(options: BackupOptions): Promise<{ dir: string; manifest: BackupManifest; upload?: UploadResult; localRemoved?: boolean }> {
  // A bad key file is reported before anything is dumped.
  const masterKey = options.keyFile ? await readKeyFile(options.keyFile) : undefined;
  if (options.upload && !masterKey) throw new Error('An off-site upload needs --key-file: only encrypted, signed backups leave this machine. Nothing was backed up.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(options.destDir, `backup-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const client = new Client(pgClientConfig(options.adminUrl));
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
      // Owners are part of the backup: the ledger's SECURITY DEFINER functions run with their owner's rights. (pg_dump's own `--no-owner`
      // is ignored for archive formats; whether owners are applied is decided by `pg_restore`, see restore.ts.)
      ['--format=custom', `--snapshot=${snapshot}`, `--file=${plainFile}`],
      pgEnv(options.adminUrl),
    );
    await client.query('COMMIT'); // the snapshot only needs to live until pg_dump has finished
    // pg_dump creates the file with the process umask (typically world-readable). A backup of clinical
    // data is owner-only, whatever happens to the directory later (copied, synced, uploaded).
    chmodSync(plainFile, 0o600);

    const plaintextSha256 = await sha256File(plainFile);
    const createdAt = new Date().toISOString();
    if (masterKey) {
      const dumpFile = `${plainFile}.enc`;
      const encryption = await encryptFile(plainFile, dumpFile, masterKey);
      rmSync(plainFile); // plaintext PHI must not linger next to its encrypted copy
      const unsigned: Omit<BackupManifestV2, 'mac'> = {
        formatVersion: 2,
        createdAt,
        ...facts,
        dump: {
          file: dumpFile.slice(dir.length + 1),
          bytes: statSync(dumpFile).size,
          sha256: await sha256File(dumpFile),
          plaintextSha256,
          encrypted: true,
          encryption,
        },
      };
      manifest = { ...unsigned, mac: manifestMac(unsigned, masterKey, encryption.salt) };
    } else {
      const unencrypted: BackupManifestV1 = {
        formatVersion: 1,
        createdAt,
        ...facts,
        dump: { file: 'db.dump', bytes: statSync(plainFile).size, sha256: plaintextSha256, plaintextSha256, encrypted: false },
      };
      manifest = unencrypted;
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  } catch (error) {
    // A half-written backup is worse than none: it may hold an UNENCRYPTED dump and no manifest to say so.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    await client.end();
  }

  // The local backup is complete and valid here; if the off-site copy fails, it stays (and the error is reported).
  if (options.upload) {
    const upload = await uploadBackup(dir, manifest, options.upload, masterKey!);
    if (options.removeLocalAfterUpload) {
      rmSync(dir, { recursive: true, force: true }); // the provider verified the content (Content-MD5), so the local copy is no longer the only one
      return { dir, manifest, upload, localRemoved: true };
    }
    return { dir, manifest, upload };
  }
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
  const privileges = await readPrivilegeFacts(client);
  return { serverVersion: version, database, migrations, tables, schema, privileges };
}
