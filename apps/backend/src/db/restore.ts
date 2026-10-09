import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { opensslEncrypt, sha256File } from './backup';
import { BackupCryptoError, decryptFile, keyIdHex, readEncryptionHeader, readKeyFile, verifyManifestMac } from './backup-crypto';
import { type BackupManifest, ManifestError, parseManifest } from './backup-manifest';
import { LedgerVerifier } from '../ledger/verifier';
import { makeTempDir, sweepStaleTempDirs } from './cleanup';
import { pgEnv, quoteIdent, run } from './pg-process';
import { diffPrivilegeFacts, legacyRequiredRoles, missingRoles, readPrivilegeFacts } from './privilege-facts';
import { pgClientConfig } from './tls';

export interface RestoreOptions {
  /** A superuser on the TARGET server. The database named in the URL is not touched. */
  adminUrl: string;
  backupDir: string;
  /** Format 2 (authenticated) backups: the 32-byte key file. When given, ONLY a format 2 backup is accepted (no downgrade). */
  keyFile?: string;
  /** Format 1 backups only (the old passphrase scheme). */
  passphraseFile?: string;
  /** Keep the restored database afterwards (a real recovery). Default: a throwaway that is dropped. */
  keep?: boolean;
  /** Restore into this named database instead of a random throwaway one. Implies keep. */
  targetDatabase?: string;
  /** Lowers how many events of one tenant's ledger the `ledger chain` check will walk (default 50 million); a larger chain is "not ok". Tests use it. */
  ledgerChainMaxEvents?: number;
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
 * migrations, schema shape, and that row-level security still isolates tenants.
 * Never touches an existing database. Exits "not ok" rather than guessing.
 */
export async function restoreAndVerify(options: RestoreOptions): Promise<RestoreReport> {
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const database = options.targetDatabase ?? `restore_check_${randomBytes(5).toString('hex')}`;
  const keep = Boolean(options.keep || options.targetDatabase);
  const failed = (): RestoreReport => ({ ok: false, database, kept: false, checks });

  if (!SAFE_DB_NAME.test(database)) throw new Error('Target database name must be lowercase letters, digits and underscores');

  // 0. The manifest is read as untrusted input: validated, and for format 2 authenticated before anything in it is used.
  let manifest: BackupManifest;
  try {
    manifest = parseManifest(readFileSync(join(options.backupDir, 'manifest.json'), 'utf8'));
    record('manifest valid', true, `format ${manifest.formatVersion}`);
  } catch (error) {
    record('manifest valid', false, error instanceof ManifestError ? error.message : 'manifest.json could not be read');
    return failed();
  }

  let masterKey: Buffer | undefined;
  if (options.keyFile) {
    if (manifest.formatVersion !== 2) {
      record('manifest signature', false, 'a key file was given but this backup is not format 2 (authenticated); refusing a downgrade');
      return failed();
    }
    try {
      masterKey = await readKeyFile(options.keyFile);
    } catch (error) {
      record('manifest signature', false, error instanceof BackupCryptoError ? error.message : 'the key file could not be read');
      return failed();
    }
  }
  if (manifest.formatVersion === 2) {
    if (!masterKey) {
      record('manifest signature', false, 'this backup is encrypted and signed (format 2) but no key file was given');
      return failed();
    }
    const { encryption } = manifest.dump;
    if (keyIdHex(masterKey) !== encryption.keyId) {
      record('manifest signature', false, 'this backup was made with a different key');
      return failed();
    }
    const authentic = verifyManifestMac(manifest, masterKey, encryption.salt);
    record('manifest signature', authentic, authentic ? 'authentic (signed with this key)' : 'DOES NOT verify: the manifest was altered or the backup is not from this key');
    if (!authentic) return failed();
  }

  const dumpPath = join(options.backupDir, manifest.dump.file);

  // 1. The backup file is exactly what was written.
  if (!existsSync(dumpPath)) {
    record('backup file present', false, manifest.dump.file);
    return failed();
  }
  const actualSha = await sha256File(dumpPath);
  record('backup file checksum', actualSha === manifest.dump.sha256, actualSha === manifest.dump.sha256 ? 'matches manifest' : 'DOES NOT match manifest (file corrupted or altered)');
  if (actualSha !== manifest.dump.sha256) return failed();

  // 2. Decrypt into a private temp dir (removed no matter what).
  sweepStaleTempDirs(); // leftovers from an earlier run that was killed outright
  const work = makeTempDir('restore-'); // removed on return, error, uncaught exception, SIGINT/SIGTERM/SIGHUP
  const workDir = work.path;
  try {
    let restoreFrom = dumpPath;
    if (manifest.formatVersion === 2) {
      restoreFrom = join(workDir, 'db.dump');
      try {
        // The file's own header must agree with the signed manifest, then every chunk is authenticated as it is read.
        const header = await readEncryptionHeader(dumpPath);
        const { encryption } = manifest.dump;
        if (header.salt !== encryption.salt || header.keyId !== encryption.keyId || header.chunkSize !== encryption.chunkSize) {
          throw new BackupCryptoError('tampered');
        }
        await decryptFile(dumpPath, restoreFrom, masterKey!);
      } catch (error) {
        record('decrypt', false, error instanceof BackupCryptoError ? error.message : 'could not decrypt the backup');
        return failed();
      }
      record('decrypt', true, 'every chunk authenticated');
      const plain = await sha256File(restoreFrom);
      record('decrypted checksum', plain === manifest.dump.plaintextSha256, plain === manifest.dump.plaintextSha256 ? 'matches manifest' : 'DOES NOT match manifest');
      if (plain !== manifest.dump.plaintextSha256) return failed();
    } else if (manifest.dump.encrypted) {
      if (!options.passphraseFile) {
        record('decrypt', false, 'backup is encrypted (format 1) but no passphrase file was given');
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

    // 3. Restore into a brand-new database. First the roles the backup names must exist on this server (roles are per server, not per
    // database, so a dump cannot carry them): ownership is part of the backup, and a missing owner would fail half way through.
    const required = manifest.privileges ? manifest.privileges.roles : legacyRequiredRoles(manifest.migrations);
    const admin = new Client(pgClientConfig(options.adminUrl));
    await admin.connect();
    try {
      const absent = await missingRoles(admin, required);
      if (absent.length > 0) {
        record('required roles', false, `these roles do not exist on this server: ${absent.join(', ')}. Create them first (docs/ops/ledger-roles.md); nothing was restored.`);
        return failed();
      }
      record('required roles', true, required.length === 0 ? 'none required' : `${required.length} present`);
      await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
    } finally {
      await admin.end();
    }
    const restoredUrl = withDatabase(options.adminUrl, database);

    try {
      // A backup that recorded its privilege facts is restored WITH its owners (the ledger's definer functions depend on them).
      // An older backup, which did not, keeps the previous behaviour: it has no definer functions to protect.
      const ownerFlags = manifest.privileges ? [] : ['--no-owner'];
      await run('pg_restore', ['--exit-on-error', ...ownerFlags, `--dbname=${database}`, restoreFrom], pgEnv(options.adminUrl, database));
      record('pg_restore', true, 'completed without errors');
      await verify(restoredUrl, manifest, record, options.ledgerChainMaxEvents ?? RESTORE_CHAIN_MAX_EVENTS);
    } catch (error) {
      record('pg_restore', false, (error as Error).message.slice(0, 300));
    } finally {
      if (!keep) await dropDatabase(options.adminUrl, database);
    }
  } finally {
    work.dispose();
  }

  return { ok: checks.every((c) => c.ok), database, kept: keep && checks.every((c) => c.ok), checks };
}

async function dropDatabase(adminUrl: string, database: string) {
  const admin = new Client(pgClientConfig(adminUrl));
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function verify(url: string, manifest: BackupManifest, record: (n: string, ok: boolean, d: string) => void, chainMaxEvents: number) {
  const db = new Client(pgClientConfig(url));
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

    // Row-level security survived, and still isolates tenants.
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

    if (manifest.privileges) {
      const problems = diffPrivilegeFacts(manifest.privileges, await readPrivilegeFacts(db));
      record('ownership and privileges', problems.length === 0,
        problems.length === 0 ? `${manifest.privileges.ownership.length} owners and ${manifest.privileges.grants.length} privileges identical to the backup`
          : `${problems.length} differences, e.g. ${problems.slice(0, 3).join('; ')}`);
    } else {
      record('ownership and privileges', true, 'not recorded in this (older) backup; restored without owners, as before');
    }

    // Isolation is checked as the application role, so only tables the application role has a policy on can be judged this way. The incident
    // tables (migration 0011) have row-level security but give the application role nothing: it must not read them at all.
    const appPolicies = await db.query<{ tablename: string }>(`SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public' AND 'telesphoros_app' = ANY (roles::text[])`);
    const appTables = new Set(appPolicies.rows.map((r) => r.tablename));
    await verifyIsolation(db, expectedNames.filter((name) => manifest.tables[name]!.rlsEnabled && appTables.has(name)), record);
    await verifyLedgerChain(url, db, names, record, chainMaxEvents);
  } finally {
    await db.end();
  }
}

/** Acts as the application role: with no tenant it must see nothing; with one tenant, exactly that tenant's rows. */
async function verifyIsolation(db: Client, tables: string[], record: (n: string, ok: boolean, d: string) => void) {
  const role = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = 'telesphoros_app'`);
  if (role.rowCount === 0) {
    record('row-level security isolation', false, `role telesphoros_app does not exist on this server; create it (migration 0002) before relying on this restore`);
    return;
  }
  const problems: string[] = [];
  for (const table of tables) {
    const tenant = (await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${quoteIdent(table)} LIMIT 1`)).rows[0]?.tenant_id;
    if (tenant === undefined) continue; // an empty table proves nothing and breaks nothing
    const expected = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoteIdent(table)} WHERE tenant_id = $1`, [tenant])).rows[0]!.n);
    for (const scenario of ['with tenant', 'without tenant'] as const) {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE telesphoros_app');
        if (scenario === 'with tenant') await db.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant]);
        const seen = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoteIdent(table)}`)).rows[0]!.n);
        const want = scenario === 'with tenant' ? expected : 0;
        if (seen !== want) problems.push(`${table} ${scenario}: saw ${seen}, expected ${want}`);
      } finally {
        await db.query('ROLLBACK');
      }
    }
  }
  record('row-level security isolation', problems.length === 0, problems.length === 0 ? `tenants isolated on ${tables.length} tables` : problems.join('; '));
}

/** One tenant's whole chain may take this long to walk in a restore check (an operator is waiting on a real recovery, not a request). */
const RESTORE_CHAIN_BUDGET_MS = 15 * 60_000;
const RESTORE_CHAIN_MAX_EVENTS = 50_000_000;

/**
 * The restored record log is walked in full, tenant by tenant, acting as `telesphoros_ledger_verifier`: the restore's own (superuser)
 * connection details are used with `role` set, so no extra credential is needed and the verifier's real policies and grants are exercised.
 * Writes nothing (no checkpoint): a throwaway restore stays a throwaway. A backup from before the ledger has nothing to walk and says so;
 * a restored ledger that fails, or cannot finish, makes the restore "not ok".
 */
async function verifyLedgerChain(url: string, db: Client, tables: string[], record: (n: string, ok: boolean, d: string) => void, maxEvents: number) {
  const name = 'ledger chain';
  if (!tables.includes('ledger_events')) {
    record(name, true, 'not applicable: this backup predates the ledger');
    return;
  }
  const role = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = 'telesphoros_ledger_verifier'`);
  if (role.rowCount === 0) {
    record(name, false, 'role telesphoros_ledger_verifier does not exist on this server; create it (docs/ops/ledger-roles.md) before relying on this restore');
    return;
  }
  const pool = new Pool({ ...pgClientConfig(url), max: 1, connectionTimeoutMillis: 10_000, options: '-c role=telesphoros_ledger_verifier' });
  pool.on('error', () => undefined); // intentional: an idle connection can die; the check reports what it could not do
  try {
    // The point of using this role is to exercise ITS policies and grants: prove the connection really has it, not just that it was asked for.
    const who = await pool.query<{ u: string }>(`SELECT current_user AS u`);
    if (who.rows[0]!.u !== 'telesphoros_ledger_verifier') {
      record(name, false, 'the check did not run as telesphoros_ledger_verifier, so it proves nothing about what the verifier may read');
      return;
    }
    const verifier = new LedgerVerifier(pool);
    const tenants = await verifier.tenants();
    let events = 0;
    const problems: string[] = [];
    for (const [index, tenantId] of tenants.entries()) {
      const result = await verifier.verify(tenantId, { mode: 'full', budgetMs: RESTORE_CHAIN_BUDGET_MS, maxEvents, recordCheckpoint: false });
      events += result.eventsChecked;
      // Kinds and sequence numbers only: no tenant id and no value from a record reaches the report.
      if (result.status === 'failed') problems.push(`ledger ${index + 1} of ${tenants.length} FAILED: ${[...new Set(result.failures.slice(0, 5).map((f) => `${f.kind}${f.seq === null ? '' : ` at ${f.seq}`}`))].join(', ')}`);
      else if (result.status === 'incomplete') problems.push(`ledger ${index + 1} of ${tenants.length} could not be walked to the end (${result.eventsChecked} events checked)`);
    }
    record(name, problems.length === 0,
      problems.length === 0
        ? tenants.length === 0 ? 'no ledger events in this backup' : `${tenants.length} tenant ledger(s), ${events} events: chain, records and notes verified in full`
        : problems.join('; '));
  } catch (error) {
    record(name, false, `the ledger could not be checked: ${error instanceof Error ? error.name : 'error'}${typeof (error as { code?: unknown }).code === 'string' ? ` ${(error as { code: string }).code}` : ''}`);
  } finally {
    await pool.end();
  }
}
