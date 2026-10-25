import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { disposeFixtures, onceFixtureCleanup } from './fixture-cleanup';
import { trackedBuild, trackLive } from './fixture-registry';
import { migrateUp } from '../../src/db/migrator';

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

/**
 * A fresh, fully migrated database on the real test cluster. Roles are cluster-wide, so they are
 * created once under an advisory lock (parallel Jest workers would otherwise race to create them).
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
      await admin.query(`CREATE DATABASE ${name}`);
      created = true;
    });
    options.signal?.throwIfAborted();
    const url = withDatabase(base, name);
    if (options.migrate !== false) {
      await withAdmin(url, async (migrator) => {
        options.signal?.throwIfAborted();
        await migrateUp(migrator);
        options.signal?.throwIfAborted();
      });
    }

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
