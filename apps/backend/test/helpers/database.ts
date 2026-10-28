import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { disposeFixtures, onceFixtureCleanup } from './fixture-cleanup';
import { trackedBuild, trackLive } from './fixture-registry';
import { loadMigrations, type Migration, migrateUp } from '../../src/db/migrator';

/** Admin (superuser) URL of a disposable PostgreSQL. Start one with scripts/dev-postgres.sh. */
export function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set. Run scripts/dev-postgres.sh start, then export its url.');
  return url;
}

const APP_LOGIN = 'telesphoros_test_app';
const APP_LOGIN_PASSWORD = 'test-only-password';
// Logins that stand in for credentials provisioned outside the repository: the ledger verifier and the redaction operator.
// Each is a member of exactly ONE NOLOGIN privilege role (created by migrations 0005 and 0006, pre-created here under the
// role lock so parallel workers cannot race) and of nothing else: the verifier is deliberately NOT a member of the application role.
const VERIFIER_LOGIN = 'telesphoros_test_verifier';
const OPERATOR_LOGIN = 'telesphoros_test_operator';
const AUDITOR_LOGIN = 'telesphoros_test_auditor';
const WORKER_LOGIN = 'telesphoros_test_worker';
// The session issuer (migration 0028): mints tenant capabilities and nothing else.
const ISSUER_LOGIN = 'telesphoros_test_issuer';
const PRIVILEGE_ROLES = [
  'telesphoros_ledger',
  'telesphoros_redactor',
  'telesphoros_ledger_verifier',
  'telesphoros_ledger_operator',
  'telesphoros_security_auditor',
  'telesphoros_jobs',
  'telesphoros_worker',
  'telesphoros_capability',
  'telesphoros_issuer',
];
const ROLE_LOCK = 4242;

function withDatabase(url: string, database: string, credentials?: { user: string; password: string }): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (credentials) {
    parsed.username = credentials.user;
    parsed.password = credentials.password;
  }
  return parsed.toString();
}

/** The verifier login's URL for the database an application URL points at (tests that are handed only `appUrl`). */
export function verifierUrlFor(appUrl: string): string {
  const parsed = new URL(appUrl);
  parsed.username = VERIFIER_LOGIN;
  parsed.password = APP_LOGIN_PASSWORD;
  return parsed.toString();
}

/** The owner (superuser) URL for the database an application URL points at: what the operator command's login would use. */
export function ownerUrlFor(appUrl: string): string {
  return withDatabase(adminUrl(), new URL(appUrl).pathname.slice(1));
}

export interface EphemeralDatabase {
  name: string;
  /** Superuser/owner connection (what a migrator or backup job would use). */
  adminUrl: string;
  /** The restricted application role: NOT a superuser, does not own the tables, bound by RLS. */
  appUrl: string;
  /** The ledger verifier's login: a member of `telesphoros_ledger_verifier` only. */
  verifierUrl: string;
  /** The redaction operator's login: a member of `telesphoros_ledger_operator` only. */
  operatorUrl: string;
  /** The security auditor's login: a member of `telesphoros_security_auditor` only (it can read the security events and nothing else). */
  auditorUrl: string;
  /** The job worker's login: a member of `telesphoros_worker` only (it can claim jobs and nothing else; it is not a member of the application role). */
  workerUrl: string;
  /** The session issuer's login: a member of `telesphoros_issuer` only (it can mint a tenant capability and nothing else). */
  issuerUrl: string;
  drop(): Promise<void>;
}

/** Creates the cluster-wide roles every fixture needs, once, under the role lock. */
async function ensureRoles(admin: Client): Promise<void> {
  await admin.query('SELECT pg_advisory_lock($1)', [ROLE_LOCK]);
  await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_app') THEN
        CREATE ROLE telesphoros_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_LOGIN}') THEN
        CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_LOGIN_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_app;
      END IF;
    END $$`);
  for (const role of PRIVILEGE_ROLES) {
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$`,
    );
  }
  for (const [login, group] of [
    [VERIFIER_LOGIN, 'telesphoros_ledger_verifier'],
    [OPERATOR_LOGIN, 'telesphoros_ledger_operator'],
    [AUDITOR_LOGIN, 'telesphoros_security_auditor'],
    [WORKER_LOGIN, 'telesphoros_worker'],
    [ISSUER_LOGIN, 'telesphoros_issuer'],
  ] as const) {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${login}') THEN
        CREATE ROLE ${login} LOGIN PASSWORD '${APP_LOGIN_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE ${group}; END IF; END $$`);
  }
  await admin.query('SELECT pg_advisory_unlock($1)', [ROLE_LOCK]);
}

const TEMPLATE_LOCK = 4243;
/** Not `test_`: the fixture-construction control counts `test_` databases as leaked fixtures. */
const TEMPLATE_PREFIX = 'tpl_migrated_';
const TEMPLATE_BUILD_PREFIX = 'tplbuild_';

/** The template's name: a hash of every migration's version and checksum, so adding, editing or removing a migration names a new template. */
export function migratedTemplateName(migrations: ReadonlyArray<Pick<Migration, 'version' | 'checksum'>> = loadMigrations()): string {
  const hash = createHash('sha256');
  for (const migration of migrations) hash.update(`${migration.version}:${migration.checksum}\n`);
  return `${TEMPLATE_PREFIX}${hash.digest('hex').slice(0, 16)}`;
}

/**
 * A database with every migration applied, kept as a template that accepts no connections; fixtures are copies of it. Running every
 * migration for each fixture took 4 of a test's 5 seconds on a loaded CI runner (#107); a copy costs about a third of a migration locally.
 * Built once per migration set, under its own lock, under a temporary name that is renamed only when complete, so no copy is ever taken
 * from a half-built template. Building one drops the templates of other migration sets and any build a crash left behind.
 */
export async function ensureMigratedTemplate(base: string = adminUrl(), signal?: AbortSignal): Promise<string> {
  const template = migratedTemplateName();
  await withAdmin(base, async (admin) => {
    signal?.throwIfAborted();
    await admin.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK]); // closing the session releases the lock
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate', [template])).rows.length > 0) return;
    await ensureRoles(admin);
    const stale = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE starts_with(datname, $1) OR starts_with(datname, $2)', [
      TEMPLATE_PREFIX,
      TEMPLATE_BUILD_PREFIX,
    ]);
    for (const { datname } of stale.rows) {
      await admin.query(`ALTER DATABASE ${datname} IS_TEMPLATE false`);
      await admin.query(`DROP DATABASE ${datname} WITH (FORCE)`);
    }
    const build = `${TEMPLATE_BUILD_PREFIX}${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${build}`);
    await withAdmin(withDatabase(base, build), async (migrator) => {
      signal?.throwIfAborted();
      await migrateUp(migrator);
    });
    signal?.throwIfAborted();
    await admin.query(`ALTER DATABASE ${build} RENAME TO ${template}`);
    await admin.query(`ALTER DATABASE ${template} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  });
  return template;
}

/**
 * A fresh database on the real test cluster: a copy of the migrated template (see ensureMigratedTemplate), or with `migrate: false` an
 * empty one. Roles are cluster-wide, so they are created once under an advisory lock (parallel Jest workers would otherwise race to create them).
 */
/**
 * The database, or the failure that unwound it. Registered like createTestApp's application: a caller whose hook timed out never receives
 * it, and the end of the test file cancels the build and drops what it created (see fixture-registry.ts).
 */
export async function createEphemeralDatabase(options: { migrate?: boolean; signal?: AbortSignal } = {}): Promise<EphemeralDatabase> {
  let forget = () => {};
  const database = await trackedBuild((signal) => buildEphemeralDatabase({ ...options, signal }, () => forget()), options.signal);
  forget = trackLive(() => database.drop());
  return database;
}

async function buildEphemeralDatabase(options: { migrate?: boolean; signal?: AbortSignal }, onDropped: () => void): Promise<EphemeralDatabase> {
  const base = adminUrl();
  const name = `test_${randomBytes(6).toString('hex')}`;
  let created = false;
  const drop = onceFixtureCleanup(async () => {
    try {
      if (created)
        await withAdmin(base, async (client) => {
          await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        });
    } finally {
      onDropped();
    }
  });
  try {
    options.signal?.throwIfAborted();
    await withAdmin(base, async (admin) => {
      options.signal?.throwIfAborted();
      await ensureRoles(admin);
      if (options.migrate === false) await admin.query(`CREATE DATABASE ${name}`);
      else {
        const template = await ensureMigratedTemplate(base, options.signal);
        options.signal?.throwIfAborted();
        // WAL_LOG is PostgreSQL 16's default, named so it cannot drift: FILE_COPY forces a checkpoint, and one forced checkpoint on a CI
        // runner has taken 4.9 s (docs/verification/backup-restore-fixture-lifetime.md).
        await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template} STRATEGY wal_log`);
      }
      created = true;
    });
    options.signal?.throwIfAborted();
    const url = withDatabase(base, name);

    return {
      name,
      adminUrl: url,
      appUrl: withDatabase(base, name, { user: APP_LOGIN, password: APP_LOGIN_PASSWORD }),
      verifierUrl: withDatabase(base, name, { user: VERIFIER_LOGIN, password: APP_LOGIN_PASSWORD }),
      operatorUrl: withDatabase(base, name, { user: OPERATOR_LOGIN, password: APP_LOGIN_PASSWORD }),
      auditorUrl: withDatabase(base, name, { user: AUDITOR_LOGIN, password: APP_LOGIN_PASSWORD }),
      workerUrl: withDatabase(base, name, { user: WORKER_LOGIN, password: APP_LOGIN_PASSWORD }),
      issuerUrl: withDatabase(base, name, { user: ISSUER_LOGIN, password: APP_LOGIN_PASSWORD }),
      drop,
    };
  } catch (error) {
    await disposeFixtures([drop], [error]);
    throw error;
  }
}

/** Runs `work` on a short-lived admin connection to the given database. */
export async function withAdmin<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  const errors: unknown[] = [];
  try {
    await client.connect();
    return await work(client);
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    await disposeFixtures([() => client.end()], errors);
  }
}

const RESTORE_SUITES_LOCK = 7878;

/**
 * Suites that run `restoreAndVerify` count the cluster's throwaway databases and the machine's restore temp dirs before and after, to
 * prove nothing is left behind. Those counts are shared state: a second suite restoring at the same moment makes them wrong. Call this
 * at the top of every such suite: they then run one after another (a Postgres advisory lock, held for the suite), while all other suites
 * still run in parallel.
 */
export function serializeRestoreSuites(): void {
  let held: Client | undefined;
  beforeAll(async () => {
    held = new Client({ connectionString: adminUrl() });
    await held.connect();
    await held.query('SELECT pg_advisory_lock($1)', [RESTORE_SUITES_LOCK]);
  }, 180_000);
  afterAll(async () => {
    await held?.end(); // closing the session releases the lock
  });
}
