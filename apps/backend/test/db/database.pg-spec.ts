import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { Client, type Pool } from 'pg';
import {
  asOrganizationWork, authorityContextMiddleware, bindRequestAuthority, bindRequestCapability, duringAdmission, noteCapabilityAbsent,
} from '../../src/auth/authority-context';
import { Database } from '../../src/db/database';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

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

/**
 * DATA-01 T015 (FR-011): `withTenant` sets the request's capability, transaction-locally, beside the tenant and the actor. The login is the real
 * application login (a non-superuser member of telesphoros_app). A missing capability is counted and the request goes on, because the binding mode is
 * `guc`: slice 5 is what turns the count into a refusal.
 */
describe('Database.withTenant and the request capability', () => {
  const TENANT = 'cap-org';
  const SUB = 'cap-person';
  const asyncRequest = <T>(work: () => Promise<T>): Promise<T> => {
    let result!: Promise<T>;
    authorityContextMiddleware({ id: 'req-db-capability' } as unknown as Request, {} as Response, () => {
      result = work();
    });
    return result;
  };
  const settingOf = (c: { query: (sql: string) => Promise<{ rows: Array<{ v: string | null }> }> }) =>
    c.query(`SELECT current_setting('app.capability', true) AS v`).then((r) => r.rows[0]!.v);
  const noCapability = (value: string | null) => expect([null, '']).toContain(value);
  const rawCapability = (db: Database) => rawPool(db).query<{ v: string | null }>(`SELECT current_setting('app.capability', true) AS v`).then((r) => r.rows[0]!.v);

  /** A real capability, minted through the issuer login as the real issuer does: committed, before the API opens its transaction. */
  async function mint(): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const c = new Client({ connectionString: ephemeral.issuerUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ expires_at: Date; refusal: string | null }>('SELECT * FROM tenant_capability_issue($1, $2, 1, $3, $4, $5)', [
        TENANT, SUB, 'request', createHash('sha256').update(token, 'utf8').digest(), 'req-db-capability',
      ]);
      expect(rows[0]!.refusal).toBeNull();
      return { token, expiresAt: rows[0]!.expires_at };
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    await withAdmin(ephemeral.adminUrl, async (c) => {
      await registerTenantRow(c, TENANT);
      await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['clinician'], 'test')`, [TENANT, SUB]);
    });
  });

  it('the login under test is the application, not a superuser (so the setting below is the real thing)', async () => {
    const db = singleConnection();
    const row = await db.withTenant(TENANT, async (c) => (await c.query(`SELECT rolsuper, rolbypassrls, pg_has_role(current_user, 'telesphoros_app', 'MEMBER') AS app FROM pg_roles WHERE rolname = current_user`)).rows[0]);
    expect(row).toEqual({ rolsuper: false, rolbypassrls: false, app: true });
  });

  it('sets app.capability for the work inside, and the database accepts it (a mismatching tenant setting then resolves to nobody)', async () => {
    const db = singleConnection();
    const cap = await mint();
    const seen = await asyncRequest(async () => {
      bindRequestCapability(cap);
      return db.withTenant(TENANT, async (c) => {
        const inside = await settingOf(c);
        const tenant = (await c.query<{ t: string | null }>('SELECT app_tenant() AS t')).rows[0]!.t;
        await c.query(`SELECT set_config('app.current_tenant_id', 'someone-else', true)`);
        const mismatch = (await c.query<{ t: string | null }>('SELECT app_tenant() AS t')).rows[0]!.t;
        return { inside, tenant, mismatch };
      });
    });
    expect(seen).toEqual({ inside: cap.token, tenant: TENANT, mismatch: null });
  });

  it('is transaction-local: the next transaction on the SAME pooled connection does not see it, after a commit or a rollback', async () => {
    const db = singleConnection();
    const cap = await mint();
    await asyncRequest(async () => {
      bindRequestCapability(cap);
      await db.withTenant(TENANT, (c) => settingOf(c)); // committed
      noCapability(await rawCapability(db));
      await expect(db.withTenant(TENANT, async (c) => { expect(await settingOf(c)).toBe(cap.token); throw new Error('boom'); })).rejects.toThrow('boom'); // rolled back
      noCapability(await rawCapability(db));
    });
    // the next REQUEST, on the same connection, has none of it
    const next = await asyncRequest(() => db.withTenant(TENANT, (c) => settingOf(c)));
    noCapability(next);
  });

  it('every withTenant call in one request sets the same capability, including organization work', async () => {
    const db = singleConnection();
    const cap = await mint();
    const seen = await asyncRequest(async () => {
      bindRequestAuthority({ sub: SUB, version: 1 });
      bindRequestCapability(cap);
      const first = await db.withTenant(TENANT, (c) => settingOf(c));
      const second = await db.withTenant(TENANT, (c) => settingOf(c), { actor: SUB });
      const organization = await asOrganizationWork(() => db.withTenant(TENANT, (c) => settingOf(c)));
      return [first, second, organization];
    });
    expect(seen).toEqual([cap.token, cap.token, cap.token]);
  });

  it('the tenant and the actor are still set beside it', async () => {
    const db = singleConnection();
    const cap = await mint();
    const seen = await asyncRequest(async () => {
      bindRequestCapability(cap);
      return db.withTenant(TENANT, async (c) => (await c.query(`SELECT current_setting('app.current_tenant_id', true) AS t, current_setting('app.current_actor', true) AS a`)).rows[0], { actor: SUB });
    });
    expect(seen).toEqual({ t: TENANT, a: SUB });
  });

  describe('a missing capability in guc mode', () => {
    it('is counted, and the request proceeds as it does today', async () => {
      const db = singleConnection();
      const label = `SYN-CAPLESS-${Date.now()}`;
      const before = db.capabilityStats();
      await asyncRequest(() => db.withTenant('alice', (c) => c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('alice', 'alice', $1)`, [label])));
      const seen = await db.withTenant('alice', (c) => c.query('SELECT count(*)::int AS n FROM patients WHERE label = $1', [label]));
      expect(seen.rows[0].n).toBe(1); // the work ran and committed
      const after = db.capabilityStats();
      expect(after.missing - before.missing).toBe(2);
      expect(after.bound - before.bound).toBe(0);
      expect(after.byReason['absent']! - (before.byReason['absent'] ?? 0)).toBe(2);
    });

    it('control: with a capability the bound count moves and the missing count does not', async () => {
      const db = singleConnection();
      const cap = await mint();
      const before = db.capabilityStats();
      await asyncRequest(async () => {
        bindRequestCapability(cap);
        await db.withTenant(TENANT, (c) => c.query('SELECT 1'));
        await db.withTenant(TENANT, (c) => c.query('SELECT 1'));
      });
      const after = db.capabilityStats();
      expect(after.bound - before.bound).toBe(2);
      expect(after.missing - before.missing).toBe(0);
    });

    it('carries the reason the guard recorded for the request', async () => {
      const db = singleConnection();
      const before = db.capabilityStats().byReason['not-configured'] ?? 0;
      await asyncRequest(async () => {
        noteCapabilityAbsent('not-configured');
        await db.withTenant(TENANT, (c) => c.query('SELECT 1'));
      });
      expect(db.capabilityStats().byReason['not-configured']! - before).toBe(1);
    });

    it('does not count the guard\'s own membership lookup, which runs before any capability can exist', async () => {
      const db = singleConnection();
      const before = db.capabilityStats();
      await asyncRequest(async () => {
        await duringAdmission(() => db.withTenant(TENANT, (c) => c.query('SELECT 1')));
        await db.withTenant(TENANT, (c) => c.query('SELECT 1')); // control: the same call outside admission is counted
      });
      const after = db.capabilityStats();
      expect(after.missing - before.missing).toBe(1);
    });

    it('an expired capability is still set (the database decides, and fails closed once slice 3 reads it) but counted as missing', async () => {
      const db = singleConnection();
      const cap = await mint();
      const before = db.capabilityStats();
      const seen = await asyncRequest(async () => {
        bindRequestCapability({ token: cap.token, expiresAt: new Date(Date.now() - 1000) });
        return db.withTenant(TENANT, (c) => settingOf(c));
      });
      expect(seen).toBe(cap.token);
      const after = db.capabilityStats();
      expect(after.missing - before.missing).toBe(1);
      expect((after.byReason['expired'] ?? 0) - (before.byReason['expired'] ?? 0)).toBe(1);
      expect(after.bound - before.bound).toBe(0);
    });
  });
});
