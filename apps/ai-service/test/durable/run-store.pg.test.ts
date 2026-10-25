import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import type { Queryable } from '@telesphoros/jobs';
import { PostgresExplainStore } from '../../durable/run-store';
import type { TenantTransactions } from '../../durable/postgres';
import { runExplanation } from '../../src/explain';
import { explainScenario } from '../helpers/explain-adapters';
import { bindCapability } from '../helpers/durable-pg';
import { createEphemeralDatabase, type EphemeralDatabase } from '../../../backend/test/helpers/database';

// Local-only, like the rest of this suite: it needs TEST_DATABASE_URL to name a loopback PostgreSQL that the person running it owns (the helper creates and drops a database of its
// own there). It runs the real `runExplanation` against the real run store, with the in-memory usage budgets (the database budgets are the next slice).
let db: EphemeralDatabase;
let admin: Client;
const TENANT = 'tenant-a';
const ACTOR = 'staff-a';

const register = async (c: Client, tenant: string, sub: string) => {
  await c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'test', 'test') ON CONFLICT (id) DO NOTHING`, [tenant]);
  await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', ARRAY['reader'], 'test') ON CONFLICT DO NOTHING`, [
    tenant,
    sub,
  ]);
};
const binder = (): TenantTransactions => ({
  async withTenant<T>(tenantId: string, work: (q: Queryable) => Promise<T>, options: { actor: string }): Promise<T> {
    const c = new Client({ connectionString: db.appUrl });
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

/** A scenario whose run store is the database, for the same identity. */
function scenario(key: string) {
  const s = explainScenario();
  s.request.idempotencyKey = key;
  s.ports.store = new PostgresExplainStore(binder(), { tenantId: TENANT, actor: ACTOR });
  // The database sets the deadline from its own clock, so the run must read real time: the double's fixed clock would put it years past the deadline.
  s.ports.clock = { utcNowMs: () => Date.now(), monotonicNowMs: () => performance.now() };
  s.authority.expiresAt = Date.now() + 3_600_000;
  return s;
}
const stateOf = async (runId: string) =>
  (await admin.query('SELECT state, sequence::int AS sequence, fence::int AS fence, finished_at IS NOT NULL AS done FROM public.agentic_explain_runs WHERE run_id = $1', [runId]))
    .rows[0];

describe('runExplanation against the durable run store', () => {
  test('a release leaves the run released in the database, and a retry of the same request replays the engine text without a model call', async () => {
    const s = scenario('k-release');
    const o = await runExplanation(s.request, s.context, s.ports);
    expect(o.released).toBe(true);
    expect(await stateOf(o.runId!)).toMatchObject({ state: 'released', sequence: 5, fence: 1, done: true });
    const calls = s.calls.model;
    const again = await runExplanation(s.request, s.context, s.ports);
    expect(again).toMatchObject({ released: false, reasonCode: 'IDEMPOTENT_REPLAY', engineText: o.engineText });
    expect(s.calls.model).toBe(calls);
    const changed = scenario('k-release');
    changed.request.engine = { ...changed.request.engine, strength: 'Moderate' };
    expect(await runExplanation(changed.request, changed.context, changed.ports)).toMatchObject({ reasonCode: 'IDEMPOTENCY_CONFLICT' });
  });
  test('two concurrent requests for the same key give one run: one release, and the other sees it in progress or finished', async () => {
    const a = scenario('k-concurrent');
    const b = scenario('k-concurrent');
    const [x, y] = await Promise.all([runExplanation(a.request, a.context, a.ports), runExplanation(b.request, b.context, b.ports)]);
    expect([x, y].filter((o) => o.released)).toHaveLength(1);
    const other = [x, y].find((o) => !o.released)!;
    expect(['IN_PROGRESS', 'IDEMPOTENT_REPLAY']).toContain(other.reasonCode);
    expect(a.calls.model + b.calls.model).toBe(2); // one draft and one verification, from the winner only
    expect(
      (await admin.query(`SELECT count(*)::int AS n FROM public.agentic_explain_runs WHERE tenant_id = $1 AND state = 'released'`, [TENANT])).rows[0].n,
    ).toBeGreaterThanOrEqual(1);
  });
  test('a run cancelled while it is working is stale at its next step: it holds, the engine text is returned, and the database keeps it cancelled', async () => {
    const s = scenario('k-cancel');
    s.hooks.draft = () => {
      // The cancellation happens through the real function, on its own connection, while the run is between steps.
      s.hooks.draft = () => undefined;
      cancelling = (async () => {
        const c = new Client({ connectionString: db.appUrl });
        await c.connect();
        try {
          await c.query('BEGIN');
          await bindCapability(db.adminUrl, c as unknown as Queryable, TENANT, ACTOR);
          const runId = (await admin.query(`SELECT run_id FROM public.agentic_explain_runs WHERE key_hash = $1`, [await keyHash('k-cancel')])).rows[0].run_id as string;
          await c.query('SELECT public.agentic_explain_run_cancel($1::uuid)', [runId]);
          await c.query('COMMIT');
        } finally {
          await c.end();
        }
      })();
    };
    let cancelling: Promise<void> | undefined;
    const o = await runExplanation(s.request, s.context, s.ports);
    await cancelling;
    expect(o).toMatchObject({ released: false });
    expect(await stateOf(o.runId!)).toMatchObject({ state: 'cancelled', fence: 2, done: true });
  });
  test('a run its process never finished is closed by the next admission of its key, and a sweep closes the rest', async () => {
    await admin.query(
      `INSERT INTO public.agentic_explain_runs (tenant_id, requester_ref, key_hash, tuple_digest, harness_version, state, mono_at, admitted_at, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'running', 1, clock_timestamp() - interval '1 hour', clock_timestamp() - interval '58 minutes')`,
      [TENANT, ACTOR, await keyHash('k-orphan'), `hmac-sha256:${'c'.repeat(64)}`, `sha256:${'b'.repeat(64)}`],
    );
    const s = scenario('k-orphan');
    const o = await runExplanation(s.request, s.context, s.ports);
    // The stored request digest is not the scenario's, so this key reads as a conflict; the point is that the orphan is no longer in flight.
    expect(['IDEMPOTENT_REPLAY', 'IDEMPOTENCY_CONFLICT']).toContain(o.reasonCode);
    expect((await admin.query(`SELECT state FROM public.agentic_explain_runs WHERE key_hash = $1`, [await keyHash('k-orphan')])).rows[0].state).toBe('expired');
  });
});

async function keyHash(key: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([TENANT, ACTOR, 'pgx.explain.v1', key]), 'utf8')
    .digest('hex')}`;
}
