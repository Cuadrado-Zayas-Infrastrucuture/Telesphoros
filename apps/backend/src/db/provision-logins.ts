import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { type DatabaseTls, pgClientConfig } from './tls';

/**
 * Creates the three database logins the API needs and hands their connection strings to a secret store (FD-4).
 *
 * Why it exists: the migrations create the privilege ROLES (`NOLOGIN`) but no login, and RDS creates only its administrator. The repository's runbooks said
 * "an administrator must, from inside the VPC, create three logins and paste their connection strings into three secrets", and there was no tool to do it and no way in
 * (tasks have no shell, the database has no public address). This runs as a one-off task with the administrator's credentials, so no password is ever typed, displayed,
 * logged or put in Terraform state.
 *
 * Passwords: generated here (256 bits), written to the secret store, and sent to the database ONLY as a SCRAM-SHA-256 verifier. The server logs DDL statements
 * (`log_statement = ddl` in the RDS parameter group), and `CREATE ROLE ... PASSWORD '<plain>'` would write the plaintext into that log; a verifier is a salted,
 * iterated hash that cannot be used to sign in.
 *
 * The result is checked from the catalog, not assumed: each login is a member of exactly its one group (the verifier is never a member of the application role, or
 * it would inherit the right to append), and the group privileges that matter are read back with `has_function_privilege`.
 */

export const PRIVILEGE_GROUPS = ['telesphoros_app', 'telesphoros_ledger', 'telesphoros_redactor', 'telesphoros_ledger_verifier', 'telesphoros_ledger_operator', 'telesphoros_security_auditor', 'telesphoros_jobs', 'telesphoros_worker'] as const;

/** The attributes the migrations give every group role (0002, 0005, 0006). A static test keeps this and those statements in agreement. */
export const GROUP_ATTRIBUTES = 'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
const LOGIN_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';

export interface LoginNames {
  /** Member of `telesphoros_app` only. */
  app: string;
  /** Member of `telesphoros_ledger_verifier` only, never of `telesphoros_app`. */
  verifier: string;
  /** Owns the database and every object the migrations create; may act as the two definer roles. Used only by the migration task. */
  migrator: string;
}

export const DEFAULT_LOGINS: LoginNames = { app: 'telesphoros_api', verifier: 'telesphoros_ledger_watch', migrator: 'telesphoros_migrator' };

export type LoginKind = keyof LoginNames;

/** Where a connection string goes. The AWS implementation is in provision-secrets.ts; tests use an in-memory one. */
export interface SecretStore {
  /** The current value, or undefined when the secret exists but holds none yet. */
  get(id: string): Promise<string | undefined>;
  put(id: string, value: string): Promise<void>;
}

export interface ProvisionOptions {
  /** Administrator connection URL (no TLS parameters). */
  adminUrl: string;
  tls: DatabaseTls;
  /** Where the API reaches the database; the generated connection strings point here (they carry no TLS parameters). */
  target: { host: string; port: number };
  secrets: Record<LoginKind, string>;
  store: SecretStore;
  names?: LoginNames;
  /** Replace every password even when the current one works. */
  rotate?: boolean;
  /** Fail (instead of skipping) the checks that need the migrations to have run. */
  requireMigrated?: boolean;
}

export interface Check {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
}

export interface ProvisionReport {
  logins: Array<{ kind: LoginKind; name: string; action: 'created' | 'unchanged' | 'repaired' | 'rotated' }>;
  checks: Check[];
  ok: boolean;
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const PROVISION_LOCK = 7424;

/** A password: 256 random bits, URL-safe, so it needs no escaping in a connection string or a SQL literal. */
export function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

/** The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802 / 7677): `SCRAM-SHA-256$iterations:salt$StoredKey:ServerKey`. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The connection string stored in a secret: no TLS parameters (db/tls.ts refuses them); TLS comes from DATABASE_SSL in the task. */
export function loginUrl(name: string, password: string, target: { host: string; port: number }, database: string): string {
  const url = new URL('postgres://placeholder');
  url.username = name;
  url.password = password;
  url.hostname = target.host;
  url.port = String(target.port);
  url.pathname = `/${database}`;
  return url.toString();
}

/** The group each login may belong to, and nothing else. */
const EXPECTED_GROUPS: Record<LoginKind, string[]> = {
  app: ['telesphoros_app'],
  verifier: ['telesphoros_ledger_verifier'],
  migrator: ['telesphoros_jobs', 'telesphoros_ledger', 'telesphoros_redactor'],
};

/**
 * What each login may execute, by function name (every overload). `true` = at least one overload is executable, `false` = none is.
 * These are the guarantees the ledger rests on (docs/ops/ledger-roles.md): only the gate appends, only the verifier records checkpoints and incidents.
 */
const FUNCTION_RIGHTS: Record<'app' | 'verifier', Record<string, boolean>> = {
  app: {
    ledger_append: true,
    ledger_append_internal: false,
    ledger_record_checkpoint: false,
    ledger_record_incident: false,
    ledger_set_global_hold: false,
    ledger_clear_incident: false,
    redact_event_note: false,
  },
  verifier: {
    ledger_append: false,
    ledger_append_internal: false,
    ledger_record_checkpoint: true,
    ledger_record_incident: true,
    ledger_set_global_hold: false,
    ledger_clear_incident: false,
    redact_event_note: false,
  },
};

const LEDGER_TABLES = ['ledger_events', 'ledger_heads', 'ledger_checkpoints'];

export async function provisionLogins(options: ProvisionOptions): Promise<ProvisionReport> {
  const names = options.names ?? DEFAULT_LOGINS;
  for (const name of Object.values(names)) if (!IDENTIFIER.test(name)) throw new Error('A login name must be lowercase letters, digits and underscores.');
  if (new Set(Object.values(names)).size !== 3) throw new Error('The three login names must differ.');

  const admin = new Client(pgClientConfig(options.adminUrl, options.tls));
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [PROVISION_LOCK]);
    const database = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    const q = (identifier: string) => admin.escapeIdentifier(identifier);
    const report: ProvisionReport = { logins: [], checks: [], ok: true };

    await ensureGroups(admin);

    const ensureLogin = async (kind: LoginKind): Promise<void> => {
      const name = names[kind];
      const secretId = options.secrets[kind];
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount === 1;
      const current = await options.store.get(secretId);
      const works = !options.rotate && exists && current !== undefined && (await loginWorks(current, name, options.tls));
      if (works) {
        report.logins.push({ kind, name, action: 'unchanged' });
        return;
      }
      // The secret is written FIRST. If the database step fails afterwards the secret holds a password nothing accepts, which the next run repairs;
      // the other order could leave a role whose password nobody knows.
      const password = generatePassword();
      await options.store.put(secretId, loginUrl(name, password, options.target, database));
      const verifier = scramVerifier(password);
      if (exists) await admin.query(`ALTER ROLE ${q(name)} PASSWORD ${admin.escapeLiteral(verifier)}`);
      else await admin.query(`CREATE ROLE ${q(name)} ${LOGIN_ATTRIBUTES} PASSWORD ${admin.escapeLiteral(verifier)}`);
      report.logins.push({ kind, name, action: !exists ? 'created' : options.rotate ? 'rotated' : 'repaired' });
    };

    // The migrator first: it owns the database, so the others' grants (made by the migrations) are made by an owner.
    await ensureLogin('migrator');
    await makeOwner(admin, names.migrator, database);
    for (const group of ['telesphoros_ledger', 'telesphoros_redactor', 'telesphoros_jobs']) {
      const has = (await admin.query('SELECT pg_has_role($1, $2, \'SET\') AS ok', [names.migrator, group])).rows[0].ok as boolean;
      if (!has) await admin.query(`GRANT ${q(group)} TO ${q(names.migrator)} WITH SET TRUE, INHERIT FALSE`);
    }
    for (const kind of ['app', 'verifier'] as const) {
      await ensureLogin(kind);
      const group = EXPECTED_GROUPS[kind][0]!;
      const member = (await admin.query('SELECT pg_has_role($1, $2, \'MEMBER\') AS ok', [names[kind], group])).rows[0].ok as boolean;
      if (!member) await admin.query(`GRANT ${q(group)} TO ${q(names[kind])}`);
    }

    report.checks.push(...(await verifyLogins(admin, names, options)));
    report.ok = report.checks.every((c) => c.ok);
    return report;
  } finally {
    try {
      await admin.query('SELECT pg_advisory_unlock($1)', [PROVISION_LOCK]);
    } catch {
      // intentional: the connection is closing anyway, which releases the lock
    }
    await admin.end();
  }
}

/** Creates the privilege groups the migrations expect, with exactly their attributes. A group that exists with other attributes is left alone and fails the checks. */
async function ensureGroups(admin: Client): Promise<void> {
  for (const group of PRIVILEGE_GROUPS) {
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [group])).rowCount === 1;
    if (exists) continue;
    try {
      await admin.query(`CREATE ROLE ${admin.escapeIdentifier(group)} ${GROUP_ATTRIBUTES}`);
    } catch (error) {
      // intentional: another session created the same group between the check and the statement (42710); what matters is that it exists
      if ((error as { code?: string }).code !== '42710') throw error;
    }
  }
}

/** Makes the migrator the owner of the database (so it owns the `public` schema and may grant on it), as the migration tests assume. No-op when it already is. */
async function makeOwner(admin: Client, migrator: string, database: string): Promise<void> {
  const owner = (await admin.query<{ owner: string }>('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [database])).rows[0]!.owner;
  if (owner === migrator) return;
  const q = (identifier: string) => admin.escapeIdentifier(identifier);
  // ALTER DATABASE ... OWNER needs the current owner to be able to SET ROLE to the new one; the temporary membership is removed straight afterwards.
  const already = (await admin.query('SELECT pg_has_role(current_user, $1, \'SET\') AS ok', [migrator])).rows[0].ok as boolean;
  if (!already) await admin.query(`GRANT ${q(migrator)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
  try {
    await admin.query(`ALTER DATABASE ${q(database)} OWNER TO ${q(migrator)}`);
  } finally {
    if (!already) await admin.query(`REVOKE ${q(migrator)} FROM CURRENT_USER`);
  }
}

/** True when the stored connection string signs in as `name`. A string that does not parse, names someone else, or is refused counts as "does not work". */
async function loginWorks(stored: string, name: string, tls: DatabaseTls): Promise<boolean> {
  try {
    if (decodeURIComponent(new URL(stored).username) !== name) return false;
    const client = new Client(pgClientConfig(stored, tls));
    client.on('error', () => undefined); // intentional: a refused login is the answer, not a crash
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/** The privilege groups exist and carry no login, superuser or other attribute the migrations did not give them. `groups` is a parameter only so a test can judge a group of its own. */
export async function checkGroups(admin: Client, groups: readonly string[] = PRIVILEGE_GROUPS): Promise<Check> {
  const rows = (await admin.query<{ rolname: string; ok: boolean }>(`SELECT rolname, NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication) AS ok FROM pg_roles WHERE rolname = ANY($1)`, [[...groups]])).rows;
  const bad = rows.filter((g) => !g.ok).map((g) => g.rolname);
  const ok = rows.length === groups.length && bad.length === 0;
  return { name: 'privilege groups', ok, detail: bad.length ? `these groups have attributes the migrations did not give them: ${bad.join(', ')}` : ok ? 'all exist with no login and no extra attributes' : 'a privilege group is missing' };
}

async function verifyLogins(admin: Client, names: LoginNames, options: ProvisionOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, skipped = false) => checks.push({ name, ok, detail, ...(skipped ? { skipped } : {}) });

  for (const kind of ['app', 'verifier', 'migrator'] as const) {
    const name = names[kind];
    const row = (await admin.query('SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication FROM pg_roles WHERE rolname = $1', [name])).rows[0];
    const plain = row && row.rolcanlogin && !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole && !row.rolbypassrls && !row.rolreplication;
    add(`${kind} login attributes`, Boolean(plain), plain ? 'login only: not a superuser, no CREATEDB, CREATEROLE, BYPASSRLS or REPLICATION' : 'the login is missing or has extra attributes');

    const memberships = (
      await admin.query<{ role: string }>(
        `WITH RECURSIVE m(roleid) AS (
           SELECT roleid FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)
           UNION
           SELECT a.roleid FROM pg_auth_members a JOIN m ON a.member = m.roleid)
         SELECT pg_get_userbyid(roleid) AS role FROM m ORDER BY 1`,
        [name],
      )
    ).rows.map((r) => r.role);
    const wanted = [...EXPECTED_GROUPS[kind]].sort();
    add(`${kind} login memberships`, JSON.stringify(memberships) === JSON.stringify(wanted), `member of ${memberships.join(', ') || 'nothing'} (expected exactly ${wanted.join(', ')})`);
  }

  checks.push(await checkGroups(admin));

  const migrated = (await admin.query("SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ledger_append' AND pronamespace = 'public'::regnamespace) AS ok")).rows[0].ok as boolean;
  if (!migrated) {
    const detail = 'the migrations have not been applied yet; run this command again after `migrate up`';
    add('group privileges', !options.requireMigrated, detail, !options.requireMigrated);
    return checks;
  }
  for (const kind of ['app', 'verifier'] as const) {
    const wrong: string[] = [];
    for (const [fn, allowed] of Object.entries(FUNCTION_RIGHTS[kind])) {
      const rows = (await admin.query<{ ok: boolean }>(`SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS ok FROM pg_proc p WHERE p.proname = $2 AND p.pronamespace = 'public'::regnamespace`, [names[kind], fn])).rows;
      if (rows.length === 0) wrong.push(`${fn} (missing)`);
      else if (rows.some((r) => r.ok) !== allowed) wrong.push(`${fn} (${allowed ? 'cannot' : 'CAN'} execute)`);
    }
    for (const table of LEDGER_TABLES) {
      const writable = (await admin.query<{ ok: boolean }>(`SELECT (has_table_privilege($1, $2, 'INSERT') OR has_table_privilege($1, $2, 'UPDATE') OR has_table_privilege($1, $2, 'DELETE') OR has_table_privilege($1, $2, 'TRUNCATE')) AS ok`, [names[kind], `public.${table}`])).rows[0].ok as boolean;
      if (writable) wrong.push(`${table} (CAN write)`);
    }
    add(`${kind} login privileges`, wrong.length === 0, wrong.length ? wrong.join('; ') : 'only the functions it needs, and it writes no ledger table');
  }
  return checks;
}
