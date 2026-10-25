import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import type { Queryable } from '@telesphoros/jobs';
import { PostgresReceiptStore } from '../../durable/receipt-store';
import type { TenantTransactions } from '../../durable/postgres';
import { runExplanation } from '../../src/explain';
import { explainScenario, GOOD, modelOf, BAD_GLOSS } from '../helpers/explain-adapters';
import { bindCapability } from '../helpers/durable-pg';
import { createEphemeralDatabase, type EphemeralDatabase } from '../../../backend/test/helpers/database';

// Local-only, like the rest of this suite. It does not use the owned-runtime manifest: it needs TEST_DATABASE_URL to name a loopback PostgreSQL that the person running it owns
// (the helper creates and drops a database of its own there), and refuses anything else.
let db: EphemeralDatabase;
let admin: Client;
/** The organization row the issuer needs before it can mint a capability (what the backend's registerTenantRow does), and one active member. */
const register = async (c: Client, tenant: string, sub: string) => {
  await c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'test', 'test') ON CONFLICT (id) DO NOTHING`, [tenant]);
  await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['reader'], 'test') ON CONFLICT DO NOTHING`, [
    tenant,
    sub,
  ]);
};
const TENANT = 'tenant-a';
const ACTOR = 'staff-a';

/** The binder the API provides: one transaction, the organization and actor bound, a capability presented. */
const binder = (url: () => string): TenantTransactions => ({
  async withTenant<T>(tenantId: string, work: (q: Queryable) => Promise<T>, options: { actor: string }): Promise<T> {
    const c = new Client({ connectionString: url() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await bindCapability(db.adminUrl, c as unknown as Queryable, tenantId, options.actor);
      const out = await work(c as unknown as Queryable);
      await c.query('COMMIT');
      return out;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await c.end();
    }
  },
});

beforeAll(async () => {
  const host = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://invalid').hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('LOOPBACK_TEST_DATABASE_REQUIRED');
  db = await createEphemeralDatabase();
  admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  await register(admin, TENANT, ACTOR);
});
afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

const store = () => new PostgresReceiptStore(binder(() => db.appUrl));
const tweak = (patch: (s: ReturnType<typeof explainScenario>) => void, key: string) => {
  const s = explainScenario();
  s.request.idempotencyKey = key;
  patch(s);
  return s;
};

describe('a receipt produced by runExplanation is stored and read back exactly', () => {
  test('a release', async () => {
    const s = tweak(() => undefined, 'k-release');
    const o = await runExplanation(s.request, s.context, s.ports);
    expect(o.released).toBe(true);
    expect(await store().append(o.receipt)).toMatchObject({ kind: 'ok' });
    expect(await store().read(TENANT, ACTOR, o.receipt!.runId)).toEqual({ kind: 'ok', value: o.receipt });
    expect(await store().append(o.receipt)).toEqual({ kind: 'refused', code: 'DUPLICATE' });
  });
  test('every kind of ending the harness can produce is accepted by the database (the TypeScript shape and the SQL checks agree)', async () => {
    const endings: Array<[string, ReturnType<typeof explainScenario>]> = [
      ['sensor hold', explainScenario({ replies: { draft: BAD_GLOSS, repair: BAD_GLOSS } })],
      ['verifier hold', explainScenario({ replies: { verify: { decision: 'hold', statements: [] } } })],
      ['usage unknown', explainScenario({ model: modelOf(async () => ({ artifact: GOOD, observation: null })) })],
      [
        'model error',
        explainScenario({
          model: modelOf(async () => {
            throw new Error('x');
          }),
        }),
      ],
      ['refused', explainScenario({ replies: { draft: { refused: true } } })],
      ['invalid structure', explainScenario({ replies: { draft: { statements: [] }, repair: { statements: [] } } })],
      ['deadline', tweak((x) => (x.hooks['draft-complete'] = () => x.tick(121000)), 'k-deadline')],
      ['not eligible', tweak((x) => (x.request.engine = { outcome: 'held', reasonCode: 'cell-disputed', strength: null, explainable: null }), 'k-elig')],
      ['no agreement', tweak((x) => (x.request.dataMarker = 'real'), 'k-baa')],
    ];
    let n = 0;
    for (const [name, s] of endings) {
      s.request.idempotencyKey = `k-end-${n}`;
      s.store.next = 100 + n++; // each scenario has a store of its own that numbers its runs from 1; a real store never repeats a run id
      const o = await runExplanation(s.request, s.context, s.ports);
      expect(o.receipt, name).not.toBeNull();
      expect(await store().append(o.receipt), name).toMatchObject({ kind: 'ok' });
      if (o.receipt!.runId !== 'unadmitted') expect(await store().read(TENANT, ACTOR, o.receipt!.runId), name).toEqual({ kind: 'ok', value: o.receipt });
    }
  });
  test('another organization reads nothing', async () => {
    await register(admin, 'tenant-z', 'staff-z');
    expect(await store().read('tenant-z', 'staff-z', 'tenant-a-x1')).toEqual({ kind: 'ok', value: null });
  });
});
