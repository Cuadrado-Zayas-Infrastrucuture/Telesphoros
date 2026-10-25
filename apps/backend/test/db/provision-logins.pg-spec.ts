import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { checkGroups, LOGIN_LIMITS, PRIVILEGE_GROUPS, type LoginKind, type LoginNames, type ProvisionOptions, type ProvisionReport, provisionLogins, type SecretStore, scramVerifier } from '../../src/db/provision-logins';
import { pgClientConfig } from '../../src/db/tls';
import { adminUrl, withAdmin } from '../helpers/database';
import { revertThrough } from '../helpers/migration-history';

/**
 * `db provision-logins` against a REAL PostgreSQL (FD-4). Roles are cluster-wide and other Jest workers share them, so every test uses its own login names
 * and its own database; the five privilege groups are created once under the same lock the other suites use. The admin here is the cluster superuser; the
 * run as a NON-superuser administrator (what RDS gives) happens on a fresh cluster in the CI rehearsal, where no group exists yet.
 */
jest.setTimeout(120_000);

const ROLE_LOCK = 4242;
const GROUPS = ['telesphoros_app', 'telesphoros_ledger', 'telesphoros_redactor', 'telesphoros_ledger_verifier', 'telesphoros_ledger_operator'];

class MemoryStore implements SecretStore {
  values = new Map<string, string>();
  puts: string[] = [];
  async get(id: string) {
    return this.values.get(id);
  }
  async put(id: string, value: string) {
    this.puts.push(id);
    this.values.set(id, value);
  }
}

interface Fixture {
  database: string;
  names: LoginNames;
  store: MemoryStore;
  options: ProvisionOptions;
  url: (user: string, password: string) => string;
}

const databases: string[] = [];
const logins: string[] = [];
const base = new URL(adminUrl());

/**
 * Does this cluster check passwords over TCP? The local development cluster (scripts/dev-postgres.sh) uses `trust`, where any password signs in, so a test that
 * expects a wrong or replaced password to be REFUSED cannot mean anything there. CI's PostgreSQL service checks passwords, and CI must never skip these tests.
 */
let passwordsChecked = false;
const whenPasswordsAreChecked = (name: string, work: () => Promise<void>) => it(name, async () => {
  if (!passwordsChecked) {
    process.stderr.write(`[jest] SKIPPED on a trust-authentication cluster (passwords are not checked): ${name}\n`);
    return;
  }
  await work();
});

beforeAll(async () => {
  const probe = `prov_probe_${randomBytes(3).toString('hex')}`;
  logins.push(probe);
  await withAdmin(adminUrl(), async (c) => {
    await c.query(`CREATE ROLE ${probe} LOGIN PASSWORD 'right-password'`);
  });
  const wrong = new URL(base);
  wrong.username = probe;
  wrong.password = 'wrong-password';
  const outcome = await asLogin(wrong.toString(), (c) => c.query('SELECT 1')).then(() => 'connected', (e: { code?: string }) => e.code);
  passwordsChecked = outcome === '28P01';
  if (process.env.CI && !passwordsChecked) throw new Error('CI must run this suite on a cluster that checks passwords (got: ' + String(outcome) + ')');
  await withAdmin(adminUrl(), async (c) => {
    await c.query('SELECT pg_advisory_lock($1)', [ROLE_LOCK]);
    for (const role of GROUPS) {
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$`);
    }
    await c.query('SELECT pg_advisory_unlock($1)', [ROLE_LOCK]);
  });
});

afterAll(async () => {
  await withAdmin(adminUrl(), async (c) => {
    for (const name of databases) await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    for (const name of logins) await c.query(`DROP ROLE IF EXISTS ${name}`);
  });
});

async function fixture(): Promise<Fixture> {
  const tag = randomBytes(4).toString('hex');
  const database = `test_prov_${tag}`;
  const names: LoginNames = { app: `prov_app_${tag}`, verifier: `prov_ver_${tag}`, migrator: `prov_mig_${tag}`, worker: `prov_wrk_${tag}`, issuer: `prov_iss_${tag}` };
  databases.push(database);
  logins.push(...Object.values(names));
  await withAdmin(adminUrl(), (c) => c.query(`CREATE DATABASE ${database}`));
  const url = (user: string, password: string) => {
    const u = new URL(base);
    u.pathname = `/${database}`;
    u.username = user;
    u.password = password;
    return u.toString();
  };
  const admin = new URL(base);
  admin.pathname = `/${database}`;
  const store = new MemoryStore();
  const options: ProvisionOptions = {
    adminUrl: admin.toString(),
    tls: 'disable',
    target: { host: base.hostname, port: Number(base.port) },
    secrets: { app: 'secret-app', verifier: 'secret-verifier', migrator: 'secret-migrator', worker: 'secret-worker' },
    store,
    names,
  };
  return { database, names, store, options, url };
}

const passwordIn = (value: string) => decodeURIComponent(new URL(value).password);

async function asLogin<T>(value: string, work: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client(pgClientConfig(value, 'disable'));
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const failing = (report: ProvisionReport) => report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

describe('provisioning on a database nothing has been applied to', () => {
  it('creates the four logins, stores working connection strings, and makes the migrator the owner so the migrations run as it', async () => {
    const f = await fixture();
    const report = await provisionLogins(f.options);
    expect(failing(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.logins.map((l) => [l.kind, l.action])).toEqual([['migrator', 'created'], ['app', 'created'], ['verifier', 'created'], ['worker', 'created']]);
    expect(report.checks.find((c) => c.name === 'group privileges')).toMatchObject({ skipped: true, ok: true }); // nothing to read back before the migrations

    // Every stored string signs in as the login it names (a real connection, not a string check).
    for (const [kind, user] of [['app', f.names.app], ['verifier', f.names.verifier], ['migrator', f.names.migrator], ['worker', f.names.worker]] as const) {
      const value = f.store.values.get(f.options.secrets[kind])!;
      expect(await asLogin(value, async (c) => (await c.query('SELECT current_user AS u')).rows[0].u)).toBe(user);
    }

    // The real flow: the migrator, a login that is not a superuser and not CREATEROLE, applies every migration.
    const owner = await withAdmin(f.options.adminUrl, async (c) => (await c.query('SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = current_database()')).rows[0].o);
    expect(owner).toBe(f.names.migrator);
    await asLogin(f.store.values.get('secret-migrator')!, async (c) => {
      expect((await c.query('SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0]).toEqual({ rolsuper: false, rolcreaterole: false });
      expect((await migrateUp(c)).length).toBeGreaterThan(0);
    });

    // After the migrations the group privileges can be read back, and they hold.
    const after = await provisionLogins({ ...f.options, requireMigrated: true });
    expect(failing(after)).toEqual([]);
    const privileges = after.checks.filter((c) => /login privileges$/.test(c.name));
    expect(privileges.map((c) => [c.name, c.ok, c.skipped ?? false])).toEqual([['app login privileges', true, false], ['verifier login privileges', true, false], ['worker login privileges', true, false]]);
    expect(after.logins.every((l) => l.action === 'unchanged')).toBe(true);
  });

  it('puts the server-side limits on every login, and a later run repairs a login that lost them (assessment item 3)', async () => {
    const f = await fixture();
    const first = await provisionLogins(f.options);
    expect(failing(first)).toEqual([]);
    const kinds = ['migrator', 'app', 'verifier', 'worker'] as const satisfies readonly LoginKind[];
    const read = (kind: LoginKind) => withAdmin(f.options.adminUrl, async (c) => (await c.query('SELECT rolconfig, rolconnlimit FROM pg_roles WHERE rolname = $1', [f.names[kind]])).rows[0]);
    for (const kind of kinds) {
      const row = await read(kind);
      expect(row.rolconnlimit).toBe(LOGIN_LIMITS[kind].connectionLimit);
      expect([...row.rolconfig].sort()).toEqual(Object.entries(LOGIN_LIMITS[kind].settings).map(([k, v]) => `${k}=${v}`).sort());
    }
    // A live session of the application login really carries the timeouts (not only the catalog row).
    await asLogin(f.store.values.get('secret-app')!, async (c) => {
      expect((await c.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('10s');
      expect((await c.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('15s');
    });
    // PUBLIC no longer holds TEMPORARY on the database, so a login cannot create a temporary table.
    expect(await withAdmin(f.options.adminUrl, async (c) => (await c.query("SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS ok")).rows[0].ok)).toBe(false);
    await asLogin(f.store.values.get('secret-app')!, async (c) => {
      await expect(c.query('CREATE TEMPORARY TABLE zz_probe (a int)')).rejects.toMatchObject({ code: '42501' });
    });

    // Tamper, then run again: the limits come back, and nothing else (no secret is written).
    await withAdmin(f.options.adminUrl, async (c) => {
      await c.query(`ALTER ROLE ${f.names.app} RESET ALL`);
      await c.query(`ALTER ROLE ${f.names.app} CONNECTION LIMIT -1`);
      await c.query(`GRANT TEMPORARY ON DATABASE ${f.database} TO PUBLIC`);
    });
    const putsBefore = f.store.puts.length;
    const again = await provisionLogins(f.options);
    expect(failing(again)).toEqual([]);
    expect(f.store.puts.length).toBe(putsBefore);
    expect((await read('app')).rolconnlimit).toBe(LOGIN_LIMITS.app.connectionLimit);
  });

  whenPasswordsAreChecked('revokes TEMPORARY from PUBLIC when the administrator is NOT a superuser and does not own the database (the RDS and CI rehearsal shape), and repairs it again', async () => {
    const f = await fixture();
    const admin = `prov_adm_${f.database.slice(-8)}`;
    logins.push(admin);
    await withAdmin(adminUrl(), async (c) => {
      await c.query(`CREATE ROLE ${admin} LOGIN NOSUPERUSER CREATEDB CREATEROLE PASSWORD 'adm-test-only'`);
      await c.query(`ALTER DATABASE ${f.database} OWNER TO ${admin}`);
      // The groups are cluster-wide and were made by the superuser here; on a fresh cluster the administrator creates them and so holds ADMIN on each.
      for (const group of PRIVILEGE_GROUPS) await c.query(`GRANT ${group} TO ${admin} WITH ADMIN OPTION`);
    });
    const url = new URL(f.options.adminUrl);
    url.username = admin;
    url.password = 'adm-test-only';
    const options = { ...f.options, adminUrl: url.toString() };
    const temporary = () => withAdmin(f.options.adminUrl, async (c) => (await c.query("SELECT has_database_privilege('public', current_database(), 'TEMPORARY') AS ok")).rows[0].ok as boolean);
    expect(failing(await provisionLogins(options))).toEqual([]);
    expect(await temporary()).toBe(false);
    // Tampered by the owner (the migrator now), then repaired by a run that is not the owner and not a superuser.
    await withAdmin(f.options.adminUrl, (c) => c.query(`GRANT TEMPORARY ON DATABASE ${f.database} TO PUBLIC`));
    expect(await temporary()).toBe(true);
    expect(failing(await provisionLogins(options))).toEqual([]);
    expect(await temporary()).toBe(false);
  });

  it('the logins cannot do what the ledger forbids them (live attempts, not catalog reads)', async () => {
    const f = await fixture();
    await provisionLogins(f.options);
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    for (const kind of ['app', 'verifier'] as const) {
      await asLogin(f.store.values.get(f.options.secrets[kind])!, async (c) => {
        await expect(c.query("INSERT INTO ledger_events (id) VALUES ('00000000-0000-0000-0000-000000000000')")).rejects.toMatchObject({ code: '42501' });
      });
    }
    await asLogin(f.store.values.get('secret-app')!, async (c) => {
      await expect(c.query("SELECT ledger_set_global_hold('no')")).rejects.toMatchObject({ code: '42501' });
    });
    await asLogin(f.store.values.get('secret-verifier')!, async (c) => {
      await expect(c.query('SELECT * FROM ledger_incident_clearances')).resolves.toBeDefined(); // the verifier may read the incident tables (0011)
    });
    await asLogin(f.store.values.get('secret-app')!, async (c) => {
      await expect(c.query('SELECT * FROM ledger_incident_clearances')).rejects.toMatchObject({ code: '42501' }); // the application may not
    });
  });

  it('the provisioned worker login can run the queue\'s functions and nothing else (live attempts)', async () => {
    const f = await fixture();
    await provisionLogins(f.options);
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    await asLogin(f.store.values.get('secret-worker')!, async (c) => {
      await expect(c.query('SELECT * FROM job_stats()')).resolves.toBeDefined();
      await expect(c.query('SELECT outbox_relay(1)')).resolves.toBeDefined();
      await expect(c.query('SELECT * FROM outbox_stats()')).resolves.toBeDefined();
      await expect(c.query('SELECT job_schedule_tick()')).resolves.toBeDefined();
      for (const sql of ["INSERT INTO jobs (tenant_id, type, idempotency_key, requested_by) VALUES ('t', 'x.y', 'k', 'u')", 'SELECT * FROM patients', 'SELECT * FROM reports', 'SELECT * FROM ledger_events', 'SELECT * FROM tenants',
        "SELECT ledger_append('00000000-0000-0000-0000-000000000000', 'x', 'y', gen_random_uuid(), 'z', 1::smallint)", "SELECT outbox_append('report.file-committed', gen_random_uuid())", 'SELECT * FROM uploads_sweep(\'t\', 0, true)', 'SET ROLE telesphoros_jobs']) {
        await expect(c.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    });
  });
});

describe('running it again', () => {
  it('changes nothing: no secret is written, no password changes, every login still works', async () => {
    const f = await fixture();
    await provisionLogins(f.options);
    const before = new Map(f.store.values);
    const putsBefore = f.store.puts.length;
    const again = await provisionLogins(f.options);
    expect(again.ok).toBe(true);
    expect(again.logins.map((l) => l.action)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(f.store.puts.length).toBe(putsBefore);
    expect(f.store.values).toEqual(before);
    for (const value of before.values()) await asLogin(value, (c) => c.query('SELECT 1'));
  });

  whenPasswordsAreChecked('--rotate replaces every password: the new strings work and the old ones no longer do', async () => {
    const f = await fixture();
    await provisionLogins(f.options);
    const old = new Map(f.store.values);
    const rotated = await provisionLogins({ ...f.options, rotate: true });
    expect(rotated.ok).toBe(true);
    expect(rotated.logins.map((l) => l.action)).toEqual(['rotated', 'rotated', 'rotated', 'rotated']);
    for (const [id, value] of f.store.values) {
      expect(value).not.toBe(old.get(id));
      await asLogin(value, (c) => c.query('SELECT 1')); // control: the new string works
      await expect(asLogin(old.get(id)!, (c) => c.query('SELECT 1'))).rejects.toMatchObject({ code: '28P01' });
    }
  });

  whenPasswordsAreChecked('repairs a secret that is empty, and a password changed behind its back, and says so', async () => {
    const f = await fixture();
    await provisionLogins(f.options);
    f.store.values.delete('secret-verifier'); // a container with no value
    await withAdmin(f.options.adminUrl, (c) => c.query(`ALTER ROLE ${f.names.app} PASSWORD 'changed-by-someone'`));
    const report = await provisionLogins(f.options);
    expect(report.ok).toBe(true);
    expect(Object.fromEntries(report.logins.map((l) => [l.kind, l.action]))).toEqual({ migrator: 'unchanged', app: 'repaired', verifier: 'repaired', worker: 'unchanged' });
    for (const value of f.store.values.values()) await asLogin(value, (c) => c.query('SELECT 1'));
  });

  it('two runs at the same moment do not corrupt each other', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([provisionLogins(f.options), provisionLogins(f.options)]);
    expect(a.ok && b.ok).toBe(true);
    for (const value of f.store.values.values()) await asLogin(value, (c) => c.query('SELECT 1')); // the stored strings are the ones the database accepts
  });
});

describe('what it refuses to call ready', () => {
  it('a verifier that has been made a member of the application role fails the check (it would inherit the right to append), and passes again once removed', async () => {
    const f = await fixture();
    await provisionLogins(f.options);
    await withAdmin(f.options.adminUrl, (c) => c.query(`GRANT telesphoros_app TO ${f.names.verifier}`));
    const bad = await provisionLogins(f.options);
    expect(bad.ok).toBe(false);
    expect(failing(bad).join('\n')).toMatch(/verifier login memberships/);
    await withAdmin(f.options.adminUrl, (c) => c.query(`REVOKE telesphoros_app FROM ${f.names.verifier}`));
    expect((await provisionLogins(f.options)).ok).toBe(true); // control: the same run is ready once the extra membership is gone
  });

  it.each([['CREATEDB', 'NOCREATEDB'], ['CREATEROLE', 'NOCREATEROLE'], ['BYPASSRLS', 'NOBYPASSRLS'], ['REPLICATION', 'NOREPLICATION']])('a login given %s fails the check, and passes again once it is taken away', async (grant, revoke) => {
    const f = await fixture();
    await provisionLogins(f.options);
    await withAdmin(f.options.adminUrl, (c) => c.query(`ALTER ROLE ${f.names.app} ${grant}`));
    const report = await provisionLogins(f.options);
    expect(report.ok).toBe(false);
    expect(failing(report).join('\n')).toMatch(/app login attributes/);
    await withAdmin(f.options.adminUrl, (c) => c.query(`ALTER ROLE ${f.names.app} ${revoke}`));
    expect((await provisionLogins(f.options)).ok).toBe(true); // control
  });

  it('after the migrations, a verifier that can append fails, and --require-migrated turns "not migrated yet" into a failure', async () => {
    const f = await fixture();
    expect((await provisionLogins({ ...f.options, requireMigrated: true })).ok).toBe(false); // nothing migrated yet
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    expect((await provisionLogins({ ...f.options, requireMigrated: true })).ok).toBe(true); // control
    // The administrator (or a mistake) gives the verifier the right to append: the gate function itself.
    await withAdmin(f.options.adminUrl, async (c) => {
      const gate = (await c.query("SELECT oid::regprocedure AS sig FROM pg_proc WHERE proname = 'ledger_append' AND pronamespace = 'public'::regnamespace")).rows[0].sig;
      await c.query(`GRANT EXECUTE ON FUNCTION ${gate} TO ${f.names.verifier}`);
    });
    const bad = await provisionLogins({ ...f.options, requireMigrated: true });
    expect(bad.ok).toBe(false);
    expect(failing(bad).join('\n')).toMatch(/verifier login privileges: .*ledger_append \(CAN execute\)/);
  });

  it('a verifier that is also a writer of the ledger tables fails the check', async () => {
    const f = await fixture();
    await provisionLogins(f.options);
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    expect((await provisionLogins({ ...f.options, requireMigrated: true })).ok).toBe(true); // control
    await withAdmin(f.options.adminUrl, (c) => c.query(`GRANT INSERT ON ledger_events TO ${f.names.app}`));
    const bad = await provisionLogins({ ...f.options, requireMigrated: true });
    expect(bad.ok).toBe(false);
    expect(failing(bad).join('\n')).toMatch(/app login privileges: .*ledger_events \(CAN write\)/);
  });

  it('a worker that can read a clinical table, write a queue table or run an application function fails the check', async () => {
    const f = await fixture();
    await provisionLogins(f.options);
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    expect((await provisionLogins({ ...f.options, requireMigrated: true })).ok).toBe(true); // control
    for (const [grant, revoke, expected] of [
      [`GRANT SELECT ON patients TO ${f.names.worker}`, `REVOKE SELECT ON patients FROM ${f.names.worker}`, /worker login privileges: .*patients \(CAN read\)/],
      [`GRANT INSERT ON jobs TO ${f.names.worker}`, `REVOKE INSERT ON jobs FROM ${f.names.worker}`, /worker login privileges: .*jobs \(CAN write\)/],
      [`GRANT EXECUTE ON FUNCTION job_enqueue(text, jsonb, text, timestamptz, integer) TO ${f.names.worker}`, `REVOKE EXECUTE ON FUNCTION job_enqueue(text, jsonb, text, timestamptz, integer) FROM ${f.names.worker}`, /worker login privileges: .*job_enqueue/],
    ] as const) {
      await withAdmin(f.options.adminUrl, (c) => c.query(grant));
      const bad = await provisionLogins({ ...f.options, requireMigrated: true });
      expect(bad.ok).toBe(false);
      expect(failing(bad).join('\n')).toMatch(expected);
      await withAdmin(f.options.adminUrl, (c) => c.query(revoke));
      expect((await provisionLogins({ ...f.options, requireMigrated: true })).ok).toBe(true); // and it recovers
    }
  });

  it('a secret that cannot be written stops the run before any role is created', async () => {
    const f = await fixture();
    const broken: SecretStore = { get: async () => undefined, put: async () => { throw new Error('the secret store is down'); } };
    await expect(provisionLogins({ ...f.options, store: broken })).rejects.toThrow(/secret store is down/);
    const roles = await withAdmin(f.options.adminUrl, async (c) => (await c.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [Object.values(f.names)])).rows);
    expect(roles).toEqual([]); // nothing was created whose password nobody holds
  });

  it('refuses names that are not plain identifiers, or that repeat', async () => {
    const f = await fixture();
    await expect(provisionLogins({ ...f.options, names: { ...f.names, app: 'Bad Name; DROP' } })).rejects.toThrow(/login name/);
    await expect(provisionLogins({ ...f.options, names: { ...f.names, verifier: f.names.app } })).rejects.toThrow(/differ/);
  });
});

describe('the session issuer login (DATA-01 slice 1, migration 0028)', () => {
  const withIssuer = (f: Fixture): ProvisionOptions => ({ ...f.options, secrets: { ...f.options.secrets, issuer: 'secret-issuer' } });

  it('is not created without its secret, and the report says the check was skipped', async () => {
    const f = await fixture();
    const report = await provisionLogins(f.options);
    expect(report.ok).toBe(true);
    expect(report.logins.map((l) => l.kind)).not.toContain('issuer');
    expect(report.checks.find((c) => c.name === 'issuer login')).toMatchObject({ ok: true, skipped: true });
    expect(await withAdmin(f.options.adminUrl, async (c) => (await c.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', [f.names.issuer])).rows[0].n)).toBe(0);
  });

  it('with its secret, is a member of exactly telesphoros_issuer, and after the migrations can mint and read nothing (live attempts)', async () => {
    const f = await fixture();
    const first = await provisionLogins(withIssuer(f));
    expect(failing(first)).toEqual([]);
    expect(first.logins.find((l) => l.kind === 'issuer')).toMatchObject({ name: f.names.issuer, action: 'created' });
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    const after = await provisionLogins({ ...withIssuer(f), requireMigrated: true });
    expect(failing(after)).toEqual([]);
    expect(after.checks.find((c) => c.name === 'issuer login privileges')).toMatchObject({ ok: true });
    await asLogin(f.store.values.get('secret-issuer')!, async (c) => {
      expect((await c.query(`SELECT has_function_privilege(current_user, 'tenant_capability_issue(text,text,bigint,text,bytea,text)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(true);
      expect((await c.query(`SELECT has_function_privilege(current_user, 'tenant_capability_issue_current(text,text,text,bytea,text)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(true);
      expect((await c.query(`SELECT has_function_privilege(current_user, 'app_capability_version()', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false); // the issuer binds nothing
      for (const sql of ['SELECT * FROM patients', 'SELECT * FROM tenant_capabilities', 'SELECT * FROM tenant_memberships', 'SELECT ledger_append(NULL, NULL, NULL, NULL, NULL, NULL)']) {
        expect([sql, await c.query(sql).then(() => 'ok', (e: { code?: string }) => e.code)]).toEqual([sql, '42501']);
      }
    });
    // The application, verifier and worker logins cannot mint (live attempt, not only the catalog), with either function.
    for (const kind of ['app', 'verifier', 'worker'] as const) {
      for (const sql of [`SELECT * FROM tenant_capability_issue('t', 's', 1, 'request', sha256('x'), NULL)`, `SELECT * FROM tenant_capability_issue_current('t', 's', 'request', sha256('x'), NULL)`]) {
        const outcome = await asLogin(f.store.values.get(f.options.secrets[kind])!, (c) => c.query(sql).then(() => 'ok', (e: { code?: string }) => e.code));
        expect([kind, sql, outcome]).toEqual([kind, sql, '42501']);
      }
    }
    // The accessor goes to the roles that bind (app, worker) and not to the verifier or the issuer (positive and negative in the same run).
    for (const [kind, expected] of [['app', 'ok'], ['worker', 'ok'], ['verifier', '42501']] as const) {
      const outcome = await asLogin(f.store.values.get(f.options.secrets[kind])!, (c) => c.query('SELECT app_capability_version()').then(() => 'ok', (e: { code?: string }) => e.code));
      expect([kind, outcome]).toEqual([kind, expected]);
    }
  });

  it('an issuer that is also a member of the application role fails the check, and passes again once removed', async () => {
    const f = await fixture();
    await provisionLogins(withIssuer(f));
    await withAdmin(f.options.adminUrl, (c) => c.query(`GRANT telesphoros_app TO ${f.names.issuer}`));
    const bad = await provisionLogins(withIssuer(f));
    expect(bad.ok).toBe(false);
    expect(failing(bad).join('\n')).toMatch(/issuer login memberships/);
    await withAdmin(f.options.adminUrl, (c) => c.query(`REVOKE telesphoros_app FROM ${f.names.issuer}`));
    expect((await provisionLogins(withIssuer(f))).ok).toBe(true); // control
  });

  it('an application login that can mint, or an issuer that can read the capability table, fails the check', async () => {
    const f = await fixture();
    await provisionLogins(withIssuer(f));
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    expect((await provisionLogins({ ...withIssuer(f), requireMigrated: true })).ok).toBe(true); // control
    for (const [grant, revoke, expected] of [
      [`GRANT EXECUTE ON FUNCTION tenant_capability_issue(text,text,bigint,text,bytea,text) TO ${f.names.app}`, `REVOKE EXECUTE ON FUNCTION tenant_capability_issue(text,text,bigint,text,bytea,text) FROM ${f.names.app}`, /app login privileges: .*tenant_capability_issue \(CAN execute\)/],
      [`GRANT SELECT ON tenant_capabilities TO ${f.names.issuer}`, `REVOKE SELECT ON tenant_capabilities FROM ${f.names.issuer}`, /issuer login privileges: .*tenant_capabilities \(CAN read\)/],
      [`GRANT EXECUTE ON FUNCTION tenant_capability_issue_current(text,text,text,bytea,text) TO ${f.names.app}`, `REVOKE EXECUTE ON FUNCTION tenant_capability_issue_current(text,text,text,bytea,text) FROM ${f.names.app}`, /app login privileges: .*tenant_capability_issue_current \(CAN execute\)/],
      [`GRANT EXECUTE ON FUNCTION tenant_capability_issue_current(text,text,text,bytea,text) TO ${f.names.worker}`, `REVOKE EXECUTE ON FUNCTION tenant_capability_issue_current(text,text,text,bytea,text) FROM ${f.names.worker}`, /worker login privileges: .*tenant_capability_issue_current \(CAN execute\)/],
      // (the app login holds app_capability_version through its group, so this one is revoked from the group)
      [`REVOKE EXECUTE ON FUNCTION app_capability_version() FROM telesphoros_app`, `GRANT EXECUTE ON FUNCTION app_capability_version() TO telesphoros_app`, /app login privileges: .*app_capability_version \(cannot execute\)/],
      [`GRANT EXECUTE ON FUNCTION app_capability_version() TO ${f.names.verifier}`, `REVOKE EXECUTE ON FUNCTION app_capability_version() FROM ${f.names.verifier}`, /verifier login privileges: .*app_capability_version \(CAN execute\)/],
      [`GRANT EXECUTE ON FUNCTION app_capability_version() TO ${f.names.issuer}`, `REVOKE EXECUTE ON FUNCTION app_capability_version() FROM ${f.names.issuer}`, /issuer login privileges: .*app_capability_version \(CAN execute\)/],
    ] as const) {
      await withAdmin(f.options.adminUrl, (c) => c.query(grant));
      const bad = await provisionLogins({ ...withIssuer(f), requireMigrated: true });
      expect(bad.ok).toBe(false);
      expect(failing(bad).join('\n')).toMatch(expected);
      await withAdmin(f.options.adminUrl, (c) => c.query(revoke));
      expect((await provisionLogins({ ...withIssuer(f), requireMigrated: true })).ok).toBe(true); // and it recovers
    }
  });
});

describe('a database that has the capability but not yet migration 0031', () => {
  it('passes the privilege checks (the 0031 entries are checked only once its functions exist), and is checked for them once they do', async () => {
    const f = await fixture();
    const withIssuer: ProvisionOptions = { ...f.options, secrets: { ...f.options.secrets, issuer: 'secret-issuer' }, requireMigrated: true };
    await provisionLogins({ ...withIssuer, requireMigrated: false });
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    const through = revertThrough('tenant_capability_issue_current'); // 0031 and everything above it (0032 to 0034: functions, policies and triggers only); 0028 stays
    expect(await withAdmin(f.options.adminUrl, (c) => migrateDown(c, through.steps))).toEqual(through.reverted);
    expect(await withAdmin(f.options.adminUrl, async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('tenant_capability_issue_current', 'app_capability_version')`)).rows[0].n)).toBe(0);
    expect(failing(await provisionLogins(withIssuer))).toEqual([]); // no "missing" complaint about functions that do not exist yet
    await asLogin(f.store.values.get('secret-migrator')!, (c) => migrateUp(c));
    expect(failing(await provisionLogins(withIssuer))).toEqual([]);
    await withAdmin(f.options.adminUrl, (c) => c.query(`GRANT EXECUTE ON FUNCTION app_capability_version() TO ${f.names.verifier}`));
    expect(failing(await provisionLogins(withIssuer)).join('\n')).toMatch(/verifier login privileges: .*app_capability_version \(CAN execute\)/); // and once they exist they are checked
  });
});

describe('the password never leaves the process except as a hash', () => {
  it('no statement sent to the database contains a plaintext password, and nothing in the report does (creating, and replacing, a password)', async () => {
    const f = await fixture();
    const sent: string[] = [];
    const original = Client.prototype.query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Client.prototype as any).query = function (...args: unknown[]) {
      const first = args[0];
      sent.push(typeof first === 'string' ? first : String((first as { text?: string })?.text ?? ''));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any).apply(this, args);
    };
    const reports: ProvisionReport[] = [];
    const passwords: string[] = [];
    try {
      reports.push(await provisionLogins(f.options)); // CREATE ROLE
      passwords.push(...[...f.store.values.values()].map(passwordIn));
      reports.push(await provisionLogins({ ...f.options, rotate: true })); // ALTER ROLE
      passwords.push(...[...f.store.values.values()].map(passwordIn));
    } finally {
      Client.prototype.query = original;
    }
    expect(new Set(passwords).size).toBe(8); // four created, four replaced: all different
    const everything = sent.join('\n');
    expect(everything).toContain('SCRAM-SHA-256$'); // control: the statements that set passwords were captured, and they carry the verifier
    expect(sent.filter((s) => /^CREATE ROLE .*PASSWORD/.test(s)).length).toBeGreaterThanOrEqual(4);
    expect(sent.filter((s) => /^ALTER ROLE .*PASSWORD/.test(s)).length).toBeGreaterThanOrEqual(4);
    for (const password of passwords) {
      expect(everything).not.toContain(password);
      expect(JSON.stringify(reports)).not.toContain(password);
    }
  });

  it('a group that can log in, or carries any other attribute the migrations did not give it, fails the group check', async () => {
    const f = await fixture();
    const good = `prov_grp_ok_${randomBytes(3).toString('hex')}`;
    const bad = `prov_grp_bad_${randomBytes(3).toString('hex')}`;
    logins.push(good, bad);
    await withAdmin(f.options.adminUrl, async (c) => {
      await c.query(`CREATE ROLE ${good} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      await c.query(`CREATE ROLE ${bad} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      expect(await checkGroups(c, [good])).toMatchObject({ ok: true }); // control
      expect(await checkGroups(c, [bad])).toMatchObject({ ok: false });
      expect(await checkGroups(c, [good, `prov_grp_missing_${randomBytes(3).toString('hex')}`])).toMatchObject({ ok: false }); // a missing group
    });
  });

  it('the verifier we send is the one PostgreSQL itself would store for the same password and salt', async () => {
    const f = await fixture();
    const name = `prov_scram_${randomBytes(3).toString('hex')}`;
    logins.push(name);
    await withAdmin(f.options.adminUrl, async (c) => {
      await c.query("SET password_encryption = 'scram-sha-256'");
      await c.query(`CREATE ROLE ${name} LOGIN PASSWORD 'plain-text-for-comparison'`);
      const stored: string = (await c.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [name])).rows[0].rolpassword;
      const [, iterations, salt] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(stored)!;
      expect(scramVerifier('plain-text-for-comparison', Buffer.from(salt!, 'base64'), Number(iterations))).toBe(stored);
      expect(scramVerifier('a different password', Buffer.from(salt!, 'base64'), Number(iterations))).not.toBe(stored); // control
    });
  });
});
