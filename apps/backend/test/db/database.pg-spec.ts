import type { Pool } from 'pg';
import { Database } from '../../src/db/database';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

let ephemeral: EphemeralDatabase;
const open: Database[] = [];
beforeAll(async () => {
  ephemeral = await createEphemeralDatabase();
});
afterAll(async () => {
  await Promise.all(open.map((db) => db.onModuleDestroy()));
  await ephemeral.drop();
});

/** One connection only, so "the next request" is guaranteed to reuse the SAME physical connection. */
const singleConnection = () => {
  const db = new Database({ url: ephemeral.appUrl, ssl: 'disable', max: 1 });
  open.push(db);
  return db;
};
const rawPool = (db: Database) => (db as unknown as { pool: Pool }).pool;
const ownerSetting = (db: Database) =>
  rawPool(db).query<{ v: string | null }>(`SELECT current_setting('app.current_tenant_id', true) AS v`).then((r) => r.rows[0]!.v);

describe('Database.withTenant (the production code path)', () => {
  it('sets the tenant for the work inside, and the tenant setting does NOT leak to the next use of the connection', async () => {
    const db = singleConnection();
    const inside = await db.withTenant('alice', async (c) => (await c.query(`SELECT current_setting('app.current_tenant_id', true) AS v`)).rows[0].v);
    expect(inside).toBe('alice');
    expect([null, '']).toContain(await ownerSetting(db)); // same physical connection, tenant gone
  });

  it('rolls back everything on error, leaks nothing, and the connection stays usable', async () => {
    const db = singleConnection();
    const label = `SYN-RB-${Date.now()}`;
    await expect(
      db.withTenant('alice', async (c) => {
        await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('alice', 'alice', $1)`, [label]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect([null, '']).toContain(await ownerSetting(db));
    const seen = await db.withTenant('alice', (c) => c.query('SELECT count(*)::int AS n FROM patients WHERE label = $1', [label]));
    expect(seen.rows[0].n).toBe(0); // the insert did not survive
  });

  it('commits when the work succeeds', async () => {
    const db = singleConnection();
    const label = `SYN-OK-${Date.now()}`;
    await db.withTenant('alice', (c) => c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('alice', 'alice', $1)`, [label]));
    const seen = await db.withTenant('alice', (c) => c.query('SELECT count(*)::int AS n FROM patients WHERE label = $1', [label]));
    expect(seen.rows[0].n).toBe(1);
  });

  it('refuses an empty or oversize tenant id before touching the database', async () => {
    const db = singleConnection();
    await expect(db.withTenant('', async () => 1)).rejects.toThrow('Invalid tenant id');
    await expect(db.withTenant('x'.repeat(129), async () => 1)).rejects.toThrow('Invalid tenant id');
  });

  it('treats a tenant id as DATA: a hostile value cannot change what the policy sees', async () => {
    const db = singleConnection();
    const hostile = `alice' OR '1'='1`;
    const seen = await db.withTenant(hostile, (c) => c.query('SELECT count(*)::int AS n FROM patients'));
    expect(seen.rows[0].n).toBe(0);
  });

  it('bounds every query: nothing runs unbounded (statement_timeout)', async () => {
    const db = singleConnection();
    const started = Date.now();
    const error = await db.withTenant('alice', (c) => c.query('SELECT pg_sleep(8)')).then(
      () => undefined,
      (e: { code?: string }) => e,
    );
    expect(error?.code).toBe('57014'); // query_canceled
    expect(Date.now() - started).toBeLessThan(7000);
  }, 20000);

  it('survives a pooled connection dying while idle (failover, restart): no crash, the next call works', async () => {
    const db = new Database({ url: ephemeral.appUrl, ssl: 'disable', max: 2 });
    open.push(db);
    await db.withTenant('alice', (c) => c.query('SELECT 1')); // leaves an idle connection in the pool
    await withAdmin(ephemeral.adminUrl, (c) =>
      c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = 'telesphoros_test_app'`, [ephemeral.name]),
    );
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the pool see the idle client die
    const result = await db.withTenant('alice', (c) => c.query('SELECT 42 AS answer'));
    expect(result.rows[0].answer).toBe(42);
  });
});
