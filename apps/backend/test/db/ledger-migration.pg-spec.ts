import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { adminUrl, withAdmin } from '../helpers/database';

/**
 * D6: migrations must work for a migrator that is NOT a superuser. Production migrators are ordinary roles with CREATEROLE; the
 * ledger's objects are created under SET ROLE to their least-privilege owners, which needs a one-time membership in those roles.
 * (Not verified here: a migrator that must CREATE the roles itself. Roles are cluster-wide and other test workers share them, so the
 * roles are created up front, as a database administrator would; see docs/ops/ledger-roles.md.)
 */
const PASSWORD = 'test-only-password';
// Logins are cluster-wide. A different suite used the old fixed name with a different password;
// trust authentication hid that collision. Each run owns and removes only its randomly named logins.
const loginTag = randomBytes(5).toString('hex');
const WITH_MEMBERSHIP = `test_ledger_migrator_${loginTag}`;
const WITHOUT_MEMBERSHIP = `test_ledger_migrator_bare_${loginTag}`;
const ROLE_LOCK = 4242;
const DEFINER_ROLES = ['telesphoros_ledger', 'telesphoros_redactor'];

const urlFor = (user: string, database: string) => {
  const u = new URL(adminUrl());
  u.pathname = `/${database}`;
  u.username = user;
  u.password = PASSWORD;
  return u.toString();
};
const databases: string[] = [];

beforeAll(async () => {
  await withAdmin(adminUrl(), async (c) => {
    await c.query('SELECT pg_advisory_lock($1)', [ROLE_LOCK]);
    for (const role of ['telesphoros_app', ...DEFINER_ROLES, 'telesphoros_ledger_verifier', 'telesphoros_ledger_operator']) {
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$`);
    }
    for (const login of [WITH_MEMBERSHIP, WITHOUT_MEMBERSHIP]) {
      await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${login}') THEN CREATE ROLE ${login} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB CREATEROLE NOBYPASSRLS; END IF; END $$`);
    }
    // The administrator's one-time step: let the migrator act as the definer roles (SET only; it inherits nothing from them).
    await c.query(`DO $$ BEGIN IF NOT pg_has_role('${WITH_MEMBERSHIP}', 'telesphoros_ledger', 'SET') THEN GRANT telesphoros_ledger TO ${WITH_MEMBERSHIP} WITH SET TRUE, INHERIT FALSE; END IF; END $$`);
    await c.query(`DO $$ BEGIN IF NOT pg_has_role('${WITH_MEMBERSHIP}', 'telesphoros_redactor', 'SET') THEN GRANT telesphoros_redactor TO ${WITH_MEMBERSHIP} WITH SET TRUE, INHERIT FALSE; END IF; END $$`);
    await c.query('SELECT pg_advisory_unlock($1)', [ROLE_LOCK]);
  });
});
afterAll(async () => {
  for (const name of databases) await withAdmin(adminUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  for (const login of [WITH_MEMBERSHIP, WITHOUT_MEMBERSHIP]) await withAdmin(adminUrl(), (c) => c.query(`DROP ROLE IF EXISTS ${login}`));
});

async function databaseOwnedBy(owner: string): Promise<string> {
  const name = `test_mig_${randomBytes(5).toString('hex')}`;
  databases.push(name);
  await withAdmin(adminUrl(), (c) => c.query(`CREATE DATABASE ${name} OWNER ${owner}`));
  return name;
}
const asMigrator = async <T>(user: string, database: string, work: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: urlFor(user, database) });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
};

describe('migrations run for a migrator that is not a superuser', () => {
  it('applies every migration, with ledger objects owned by their least-privilege roles and nothing owned by the migrator that should not be', async () => {
    const db = await databaseOwnedBy(WITH_MEMBERSHIP);
    await asMigrator(WITH_MEMBERSHIP, db, async (c) => {
      expect((await c.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0].rolsuper).toBe(false); // control
      await migrateUp(c);
      const owners = (await c.query(`SELECT proname, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('ledger_append', 'ledger_append_internal', 'ledger_record_checkpoint', 'redact_event_note', 'refuse_mutation')`)).rows;
      expect(Object.fromEntries(owners.map((r) => [r.proname, r.owner]))).toEqual({
        ledger_append: 'telesphoros_ledger', ledger_append_internal: 'telesphoros_ledger', ledger_record_checkpoint: 'telesphoros_ledger',
        redact_event_note: 'telesphoros_redactor', refuse_mutation: WITH_MEMBERSHIP,
      });
      const tables = (await c.query(`SELECT relname, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ledger_events', 'ledger_heads', 'ledger_checkpoints', 'report_captures', 'event_notes')`)).rows;
      expect(Object.fromEntries(tables.map((r) => [r.relname, r.owner]))).toEqual({
        ledger_events: 'telesphoros_ledger', ledger_heads: 'telesphoros_ledger', ledger_checkpoints: 'telesphoros_ledger', report_captures: WITH_MEMBERSHIP, event_notes: WITH_MEMBERSHIP,
      });
      // CREATE on the schema was only granted to the owners while a migration ran.
      const create = (await c.query(`SELECT has_schema_privilege('telesphoros_ledger', 'public', 'CREATE') AS ledger, has_schema_privilege('telesphoros_redactor', 'public', 'CREATE') AS redactor, has_schema_privilege('telesphoros_app', 'public', 'CREATE') AS app`)).rows[0];
      expect(create).toEqual({ ledger: false, redactor: false, app: false });
    });
  });

  it('reverts and re-applies (the audit-drop guard still applies to this migrator)', async () => {
    const db = await databaseOwnedBy(WITH_MEMBERSHIP);
    await asMigrator(WITH_MEMBERSHIP, db, async (c) => {
      await migrateUp(c);
      expect(await migrateDown(c, 4)).toEqual(['0015', '0014', '0013', '0012']);
      await expect(migrateDown(c, 1)).rejects.toThrow(/Refusing to drop ledger incidents/); // 0011 removes audit data, so it is guarded too
      await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
      await migrateDown(c, 1); // 0011, as a migrator that is not a superuser (it replaces ledger_append, which needs CREATE on the schema for a moment)
      expect((await c.query(`SELECT has_schema_privilege('telesphoros_ledger', 'public', 'CREATE') AS ledger`)).rows[0].ledger).toBe(false);
      await c.query(`RESET telesphoros.allow_audit_drop`);
      await migrateDown(c, 1); // 0010 holds no evidence in an empty database, so it reverts freely (its own guard is tested in report-evidence)
      await expect(migrateDown(c, 1)).rejects.toThrow(/allow_audit_drop|Refusing/);
      await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
      for (let i = 0; i < 6; i++) await migrateDown(c, 1); // 0009 .. 0004
      expect((await c.query(`SELECT to_regclass('public.ledger_events') AS t`)).rows[0].t).toBeNull();
      await migrateUp(c);
      expect((await c.query(`SELECT to_regclass('public.ledger_events') AS t`)).rows[0].t).not.toBeNull();
    });
  });

  it('a migrator without the one-time membership fails cleanly, and leaves nothing half-applied', async () => {
    const db = await databaseOwnedBy(WITHOUT_MEMBERSHIP);
    await asMigrator(WITHOUT_MEMBERSHIP, db, async (c) => {
      await expect(migrateUp(c)).rejects.toThrow(/telesphoros_ledger/);
      expect((await c.query(`SELECT to_regclass('public.ledger_events') AS t`)).rows[0].t).toBeNull();
      // Earlier migrations stay applied (each migration is its own transaction); the failing one left no objects behind.
      expect((await c.query(`SELECT to_regclass('public.report_captures') AS t`)).rows[0].t).toBeNull();
    });
  });
});
