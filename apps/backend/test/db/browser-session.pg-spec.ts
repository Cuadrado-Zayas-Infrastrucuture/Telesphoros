import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { BrowserSessionCustody } from '../../src/auth/browser-session';
import { SessionCrypto } from '../../src/auth/session-crypto';
import { Database } from '../../src/db/database';
import { migrateDown } from '../../src/db/migrator';
import { PostgresBrowserSessionRepository } from '../../src/storage/postgres/browser-session.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registeringAdmin } from '../helpers/membership';

const A = 'tenant-session-a'; const B = 'tenant-session-b';
let pg: EphemeralDatabase;
let database: Database; let otherDatabase: Database;
let repository: PostgresBrowserSessionRepository; let other: PostgresBrowserSessionRepository;
let crypto: SessionCrypto; let custody: BrowserSessionCustody;
let master: Buffer;
const owner = <T>(work: (client: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable', applicationName: 'm51-reader' });
  otherDatabase = new Database({ url: pg.appUrl, ssl: 'disable', applicationName: 'm51-revoker' });
  repository = new PostgresBrowserSessionRepository(database); other = new PostgresBrowserSessionRepository(otherDatabase);
  master = randomBytes(32);
  crypto = new SessionCrypto('test', new Map([['test', master]])); custody = new BrowserSessionCustody(repository, crypto);
  await owner(async (client) => {
    for (const [tenantId, sub] of [[A, 'person-a'], [B, 'person-b']]) await registeringAdmin(client).grant({ tenantId: tenantId!, sub: sub!, roles: ['reader'], by: 'operator-test', reason: 'synthetic session fixture' });
  });
});
afterAll(async () => { await database?.onModuleDestroy(); await otherDatabase?.onModuleDestroy(); await pg?.drop(); });
const make = (tenantId = A) => custody.create({ identity: { tenantId, sub: tenantId === A ? 'person-a' : 'person-b', roles: [], issuedAt: Math.floor(Date.now() / 1000) - 1 }, accessToken: 'synthetic-session-token', tokenExpiresAt: new Date(Date.now() + 60_000) });
const hashOf = (cookie: string) => crypto.hashHandle(crypto.openLocator(cookie)!.handle);
async function appClient(tenant: string | null = A) {
  const client = new Client({ connectionString: pg.appUrl }); await client.connect(); await client.query('BEGIN');
  if (tenant !== null) await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
  return client;
}
const end = async (client: Client) => { await client.query('ROLLBACK').catch(() => undefined); await client.end(); };
async function expired(tenant: string, count: number) {
  for (let i = 0; i < count; i++) await owner((client) => client.query(`INSERT INTO browser_sessions
    (tenant_id,handle_hash,sub,issued_at,created_at,expires_at,credential)
    VALUES ($1,$2,$3,0,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',$4)`,
  [tenant, createHash('sha256').update(randomBytes(32)).digest('hex'), tenant === A ? 'person-a' : 'person-b', crypto.sealCredential('synthetic-expired-token', 'expiry-fixture')]));
}
async function waiting(application: string) {
  for (let i = 0; i < 100; i++) {
    const found = await owner(async (client) => (await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'", [pg.name, application])).rows[0].n as number);
    if (found > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

it('provides the durable browser-session custody table', async () => {
  expect(await owner(async (client) => (await client.query("SELECT to_regclass('public.browser_sessions')::text AS name")).rows[0].name)).toBe('browser_sessions');
});

it('persists opaque credentials across independent instances and checks tenant on every operation', async () => {
  const a = await make(); const b = await make(B); const hash = hashOf(a.cookie);
  const independentCrypto = new SessionCrypto('test', new Map([['test', Buffer.from(master)]]));
  expect(await new BrowserSessionCustody(other, independentCrypto).read(a.cookie)).toMatchObject({ sub: 'person-a', accessToken: 'synthetic-session-token' });
  expect(await other.findActive(B, hash)).toBeUndefined(); expect(await other.revoke(B, hash)).toBe(false);
  expect(await custody.read(a.cookie)).toBeDefined(); expect(await custody.read(b.cookie)).toBeDefined();
  const row = await owner(async (client) => (await client.query('SELECT * FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2', [A, hash])).rows[0]);
  expect(row.credential).not.toContain('synthetic-session-token'); expect(row.handle_hash).toBe(hash); expect(row).not.toHaveProperty('roles');
  expect(await other.revoke(A, hash)).toBe(true); expect(await custody.read(a.cookie)).toBeUndefined(); expect(await custody.read(b.cookie)).toBeDefined();
  expect(await other.revoke(A, hash)).toBe(false);
});

it('has forced RLS, exact policies and only column-scoped mutation privileges', async () => {
  await owner(async (client) => {
    expect((await client.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='browser_sessions'::regclass")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = (await client.query("SELECT cmd,roles::text,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='browser_sessions' ORDER BY cmd")).rows;
    expect(policies.map((row) => row.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    for (const row of policies) { expect(row.roles).toBe('{telesphoros_app}'); expect(row.qual ?? row.with_check).toContain('app.current_tenant_id'); }
    expect(policies[0].qual).toContain('expires_at'); expect(policies[0].qual).toContain('clock_timestamp');
    const columns = (await client.query("SELECT column_name FROM information_schema.column_privileges WHERE table_name='browser_sessions' AND grantee='telesphoros_app' AND privilege_type='UPDATE' ORDER BY column_name")).rows;
    expect(columns.map((row) => row.column_name)).toEqual(['revoked_at']);
    expect((await client.query("SELECT has_table_privilege('telesphoros_app','browser_sessions','TRUNCATE') AS truncate,has_table_privilege('telesphoros_app','browser_sessions','UPDATE') AS update")).rows[0]).toEqual({ truncate: false, update: false });
  });
});

it('refuses missing tenant context and mismatched inserts on the real application login', async () => {
  const a = await make(); const hash = hashOf(a.cookie);
  const missing = await appClient(null); const foreign = await appClient(B);
  try {
    expect((await missing.query('SELECT * FROM browser_sessions WHERE handle_hash=$1', [hash])).rows).toEqual([]);
    expect((await foreign.query('SELECT * FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2', [A, hash])).rows).toEqual([]);
    expect((await foreign.query('UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND handle_hash=$2', [A, hash])).rowCount).toBe(0);
    await expect(foreign.query(`INSERT INTO browser_sessions (tenant_id,handle_hash,sub,issued_at,created_at,expires_at,credential)
      VALUES ($1,$2,'person-a',0,clock_timestamp(),clock_timestamp()+interval '1 minute',$3)`, [A, 'a'.repeat(64), crypto.sealCredential('synthetic-token', 'foreign-fixture')])).rejects.toMatchObject({ code: '42501' });
  } finally { await end(missing); await end(foreign); }
});

it.each(['verifierUrl', 'workerUrl', 'auditorUrl', 'operatorUrl'] as const)('grants no session access to %s', async (url) => {
  await withAdmin(pg[url], async (client) => {
    await expect(client.query('SELECT * FROM browser_sessions WHERE tenant_id=$1', [A])).rejects.toMatchObject({ code: '42501' });
  });
});

it('does not permit editing credentials or lifetime, resurrecting a revocation, or deleting a live session', async () => {
  const made = await make(); const hash = hashOf(made.cookie);
  for (const statement of [
    "UPDATE browser_sessions SET credential='v1.test.changed.tag.data' WHERE tenant_id=$1 AND handle_hash=$2",
    "UPDATE browser_sessions SET expires_at=expires_at+interval '1 hour' WHERE tenant_id=$1 AND handle_hash=$2",
  ]) {
    const client = await appClient(); try { await expect(client.query(statement, [A, hash])).rejects.toMatchObject({ code: '42501' }); } finally { await end(client); }
  }
  const client = await appClient();
  try { expect((await client.query('DELETE FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2', [A, hash])).rowCount).toBe(0); } finally { await end(client); }
  await expect(owner((c) => c.query('UPDATE browser_sessions SET sub=$3 WHERE tenant_id=$1 AND handle_hash=$2', [A, hash, 'person-b']))).rejects.toMatchObject({ code: '23000' });
  await expect(owner((c) => c.query('DELETE FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2', [A, hash]))).rejects.toMatchObject({ code: '23000' });
  await expect(owner((c) => c.query('TRUNCATE browser_sessions'))).rejects.toMatchObject({ code: '23000' });
  expect(await repository.revoke(A, hash)).toBe(true);
  const revive = await appClient(); try { await expect(revive.query('UPDATE browser_sessions SET revoked_at=NULL WHERE tenant_id=$1 AND handle_hash=$2', [A, hash])).rejects.toMatchObject({ code: '23000' }); } finally { await end(revive); }
});

it('enforces lifetime, membership reference and sealed payload constraints in PostgreSQL', async () => {
  const valid = crypto.sealCredential('synthetic-token', 'schema-fixture');
  for (const [sub, lifetime, credential] of [['person-a', '16 minutes', valid], ['absent', '1 minute', valid], ['person-a', '1 minute', 'plaintext-token']]) {
    const client = await appClient();
    try { await expect(client.query(`INSERT INTO browser_sessions (tenant_id,handle_hash,sub,issued_at,created_at,expires_at,credential)
      VALUES ($1,$2,$3,0,clock_timestamp(),clock_timestamp()+$4::interval,$5)`, [A, 'b'.repeat(64), sub, lifetime, credential])).rejects.toMatchObject({ code: sub === 'absent' ? '23503' : '23514' }); }
    finally { await end(client); }
  }
});

it('cleans only expired own-tenant rows in bounded batches and preserves live/revoked custody until expiry', async () => {
  await repository.cleanupExpired(A, 100); await repository.cleanupExpired(B, 100);
  const a = await make(); await repository.revoke(A, hashOf(a.cookie)); await expired(A, 3); await expired(B, 1);
  expect(await repository.cleanupExpired(A, 2)).toBe(2); expect(await repository.cleanupExpired(A, 2)).toBe(1); expect(await repository.cleanupExpired(A, 2)).toBe(0);
  expect(await repository.cleanupExpired(B, 2)).toBe(1);
  expect(await owner(async (client) => (await client.query('SELECT count(*)::int AS n FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2', [A, hashOf(a.cookie)])).rows[0].n)).toBe(1);
  for (const limit of [0, -1, 101, 1.5]) await expect(repository.cleanupExpired(A, limit)).rejects.toMatchObject({ code: 'invalid' });
  for (const tenant of ['', 'bad tenant']) await expect(repository.cleanupExpired(tenant, 1)).rejects.toMatchObject({ code: 'invalid' });
  await expect(repository.findActive(A, 'not-a-digest')).rejects.toMatchObject({ code: 'invalid' });
});

it('refuses expired rows using the database clock even before cleanup runs', async () => {
  const live = await make(); await expired(A, 1);
  const hash = await owner(async (client) => (await client.query('SELECT handle_hash FROM browser_sessions WHERE tenant_id=$1 AND expires_at<=clock_timestamp() LIMIT 1', [A])).rows[0].handle_hash as string);
  expect(await repository.findActive(A, hash)).toBeUndefined();
  expect(await repository.findActive(A, hashOf(live.cookie))).toBeDefined();
});

it('does not block cleanup behind an expired row held by another cleaner', async () => {
  await repository.cleanupExpired(A, 100); await expired(A, 2); const client = await appClient();
  try {
    await client.query('SELECT handle_hash FROM browser_sessions WHERE tenant_id=$1 AND expires_at<=clock_timestamp() ORDER BY expires_at,handle_hash LIMIT 1 FOR UPDATE', [A]);
    expect(await repository.cleanupExpired(A, 2)).toBe(1);
  } finally { await end(client); }
  expect(await repository.cleanupExpired(A, 2)).toBe(1);
});

it('orders revocation after a locked custody snapshot and refuses subsequent reads', async () => {
  const made = await make(); const hash = hashOf(made.cookie); const client = await appClient(); let revocation: Promise<boolean> | undefined;
  try {
    await client.query('SELECT handle_hash FROM browser_sessions WHERE tenant_id=$1 AND handle_hash=$2 FOR SHARE', [A, hash]);
    revocation = other.revoke(A, hash); expect(await waiting('m51-revoker')).toBe(true);
    await client.query('COMMIT'); expect(await revocation).toBe(true); expect(await repository.findActive(A, hash)).toBeUndefined();
  } finally { await end(client); await revocation; }
});

it('a read waiting behind revocation observes the revoked row rather than a stale session', async () => {
  const made = await make(); const hash = hashOf(made.cookie); const client = await appClient(); let read: ReturnType<typeof repository.findActive> | undefined;
  try {
    await client.query('UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND handle_hash=$2', [A, hash]);
    read = repository.findActive(A, hash); expect(await waiting('m51-reader')).toBe(true);
    await client.query('COMMIT'); expect(await read).toBeUndefined();
  } finally { await end(client); await read; }
});

it('throws a sanitized failure when the authority store is unavailable', async () => {
  const unreachable = new Database({ url: 'postgres://synthetic:fixture-password@127.0.0.1:1/none', ssl: 'disable' });
  try {
    await expect(new PostgresBrowserSessionRepository(unreachable).findActive(A, 'c'.repeat(64))).rejects.toMatchObject({ code: 'unavailable', message: 'Browser session custody unavailable' });
  } finally { await unreachable.onModuleDestroy(); }
});

it('the new migration and rollback execute as a non-superuser owner with no BYPASSRLS', async () => {
  const isolated = await createEphemeralDatabase();
  try {
    await withAdmin(isolated.adminUrl, async (client) => {
      expect(await migrateDown(client)).toEqual(['0026']);
      await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='m51a_migration_owner') THEN CREATE ROLE m51a_migration_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
      await client.query('GRANT USAGE,CREATE ON SCHEMA public TO m51a_migration_owner');
      await client.query('GRANT REFERENCES ON tenant_memberships TO m51a_migration_owner');
      for (const direction of ['up', 'down', 'up']) {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL ROLE m51a_migration_owner');
          expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
          await client.query(readFileSync(resolve(__dirname, `../../migrations/0026_browser_sessions.${direction}.sql`), 'utf8'));
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      }
      expect((await client.query("SELECT pg_get_userbyid(relowner) AS owner,relforcerowsecurity FROM pg_class WHERE oid='browser_sessions'::regclass")).rows[0]).toEqual({ owner: 'm51a_migration_owner', relforcerowsecurity: true });
    });
  } finally { await isolated.drop(); }
});
