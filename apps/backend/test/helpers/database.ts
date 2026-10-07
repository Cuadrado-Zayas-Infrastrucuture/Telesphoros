import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { migrateUp } from '../../src/db/migrator';

/** Admin (superuser) URL of a disposable PostgreSQL. Start one with scripts/dev-postgres.sh. */
export function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set. Run scripts/dev-postgres.sh start, then export its url.');
  return url;
}

const APP_LOGIN = 'telesphoros_test_app';
const APP_LOGIN_PASSWORD = 'test-only-password';
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

export interface EphemeralDatabase {
  name: string;
  /** Superuser/owner connection (what a migrator or backup job would use). */
  adminUrl: string;
  /** The restricted application role: NOT a superuser, does not own the tables, bound by RLS. */
  appUrl: string;
  drop(): Promise<void>;
}

/**
 * A fresh, fully migrated database on the real test cluster. Roles are cluster-wide, so they are
 * created once under an advisory lock (parallel Jest workers would otherwise race to create them).
 */
export async function createEphemeralDatabase(options: { migrate?: boolean } = {}): Promise<EphemeralDatabase> {
  const base = adminUrl();
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [ROLE_LOCK]);
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_app') THEN
        CREATE ROLE telesphoros_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_LOGIN}') THEN
        CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_LOGIN_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_app;
      END IF;
    END $$`);
    await admin.query('SELECT pg_advisory_unlock($1)', [ROLE_LOCK]);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = withDatabase(base, name);
  if (options.migrate !== false) {
    const migrator = new Client({ connectionString: url });
    await migrator.connect();
    try {
      await migrateUp(migrator);
    } finally {
      await migrator.end();
    }
  }

  return {
    name,
    adminUrl: url,
    appUrl: withDatabase(base, name, { user: APP_LOGIN, password: APP_LOGIN_PASSWORD }),
    async drop() {
      const dropper = new Client({ connectionString: base });
      await dropper.connect();
      try {
        // WITH (FORCE) disconnects stragglers: pool.end() can resolve before the server has dropped the backend.
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** Runs `work` on a short-lived admin connection to the given database. */
export async function withAdmin<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
