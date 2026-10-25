import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { SyntheticJobQueue } from '../../durable/queue';
import { runDurableSynthetic, type ScriptedActors } from '../../durable/kernel';
import type { Decision, DurableSyntheticStore, Expected } from '../../durable/contracts';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { backendPid, claimOptions, durableHarness, inputDigest, scriptedActors, sleep } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
let worker: Client;
let workerPid: number;
const h = durableHarness(
  () => fixture,
  () => owner,
);
type Run = Awaited<ReturnType<typeof h.admitAndClaim>>;
const next = (r: Decision<{ state: Expected['state']; sequence: string }>): Expected => {
  if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
  return { state: r.value.state, sequence: r.value.sequence };
};
/** Move the original admission instant so the 120s deadline lands `msLeft` from now (keeps the CHECK exact). */
const deadlineIn = (runId: string, msLeft: number) =>
  owner.query(
    `UPDATE public.agentic_synthetic_runs
  SET (admitted_at, deadline_at, last_guarded_at) = (SELECT t, t + interval '120 seconds', t
    FROM (SELECT clock_timestamp() - interval '120 seconds' + $2 * interval '1 millisecond' AS t) z)
  WHERE run_id=$1`,
    [runId, msLeft],
  );
const runRow = (runId: string) =>
  h.row(
    `SELECT state, sequence::text AS sequence, admitted_at, deadline_at, last_guarded_at,
  (SELECT count(*)::int FROM public.agentic_synthetic_invocations i WHERE i.run_id=$1) AS slots,
  (SELECT count(*)::int FROM public.agentic_synthetic_outcomes o WHERE o.run_id=$1) AS outcomes
  FROM public.agentic_synthetic_runs WHERE run_id=$1`,
    [runId],
  );

/** Calls `before(method)` ahead of each store call, so a test can change time or authority at an exact boundary. */
function interposed(store: DurableSyntheticStore, before: (method: string, n: number) => Promise<void>) {
  let n = 0;
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await before(String(key), n++);
        return value.apply(target, args);
      };
    },
  });
}

describe('owned PostgreSQL synthetic time, lock waits and actor transactions', () => {
  beforeAll(async () => {
    fixture = await ownedPostgresFixture();
    owner = new Client({ connectionString: fixture.adminUrl });
    worker = new Client({ connectionString: fixture.workerUrl });
    await owner.connect();
    await worker.connect();
    workerPid = await backendPid(worker);
    await owner.query(`INSERT INTO public.agentic_synthetic_capacity(singleton,tenant_day_units,fleet_month_units)
      VALUES (1,5000000,300000000)`);
  }, 180_000);
  afterAll(async () => {
    await worker?.end();
    await owner?.end();
    await fixture?.drop();
  }, 60_000);
  afterEach(() => h.releaseAllPermits());

  // P2-27: each lock is held by another transaction until something expires; the waiting step must
  // decide with clock_timestamp() taken after its last lock, never the transaction start.
  const lockWaits: {
    name: string;
    lock: (run: Run, tenant: string, actor: string) => [string, unknown[]];
    expire: (run: Run, tenant: string, grantId: string) => Promise<unknown>;
    prepare: (run: Run) => Promise<() => Promise<Decision<unknown>>>;
    code: string;
  }[] = [
    {
      name: 'grant row until the grant expires',
      code: 'NOT_AUTHORIZED',
      lock: (_r, tenant) => ['SELECT 1 FROM public.agentic_synthetic_grants WHERE tenant_id=$1 FOR UPDATE', [tenant]],
      expire: (_r, tenant, grantId) =>
        owner.query(
          `UPDATE public.agentic_synthetic_grants
        SET expires_at = clock_timestamp() + interval '600 milliseconds' WHERE tenant_id=$1 AND grant_id=$2`,
          [tenant, grantId],
        ),
      prepare: async (run) => () => run.store.advance(run.stamp, run.expected, 'running'),
    },
    {
      name: 'membership row until the grant expires',
      code: 'NOT_AUTHORIZED',
      lock: (_r, tenant, actor) => ['SELECT 1 FROM public.tenant_memberships WHERE tenant_id=$1 AND sub=$2 FOR UPDATE', [tenant, actor]],
      expire: (_r, tenant, grantId) =>
        owner.query(
          `UPDATE public.agentic_synthetic_grants
        SET expires_at = clock_timestamp() + interval '600 milliseconds' WHERE tenant_id=$1 AND grant_id=$2`,
          [tenant, grantId],
        ),
      prepare: async (run) => () => run.store.advance(run.stamp, run.expected, 'running'),
    },
    {
      name: 'source row until the original deadline passes',
      code: 'DEADLINE_EXPIRED',
      lock: (_r, tenant) => ['SELECT 1 FROM public.agentic_synthetic_sources WHERE tenant_id=$1 FOR UPDATE', [tenant]],
      expire: (run) => deadlineIn(run.runId, 600),
      prepare: async (run) => {
        const sources = await run.store.sources(run.stamp, run.expected);
        if (sources.kind !== 'ok') throw new Error('sources');
        const expected = next(await run.store.advance(run.stamp, run.expected, 'running'));
        return () =>
          run.store.begin(run.stamp, expected, { invocationId: randomUUID(), role: 'draft', ordinal: 1, inputDigest: inputDigest(run.runId, sources.value, 'draft', 1) });
      },
    },
    {
      name: 'queue row until the lease expires',
      code: 'STALE_CLAIM',
      lock: (run) => ['SELECT 1 FROM public.jobs WHERE id=$1 FOR UPDATE', [run.jobId]],
      expire: (run) => owner.query(`UPDATE public.jobs SET lease_until = clock_timestamp() + interval '600 milliseconds' WHERE id=$1`, [run.jobId]),
      prepare: async (run) => () => run.store.load(run.stamp, run.expected),
    },
  ];
  for (const c of lockWaits) {
    test(`P2-27 waiting on the ${c.name} refuses after the wait`, async () => {
      const { tenant, grantId, caller } = await h.seedTenant();
      const run = await h.admitAndClaim(worker, caller);
      const call = await c.prepare(run);
      const before = await runRow(run.runId);
      await c.expire(run, tenant, grantId); // set first: the owner update would queue behind the held lock
      const lock = await h.holdLock(...c.lock(run, tenant, caller.requesterRef));
      let pending: Promise<Decision<unknown>> | undefined;
      try {
        pending = call();
        await h.lockWaiting(workerPid);
        await sleep(800); // past the expiry while still blocked
      } finally {
        await lock.release();
      }
      expect(await pending).toEqual({ kind: 'refused', code: c.code });
      const after = await runRow(run.runId);
      expect({ state: after.state, sequence: after.sequence, slots: after.slots, outcomes: after.outcomes }).toEqual({
        state: before.state,
        sequence: before.sequence,
        slots: before.slots,
        outcomes: 0,
      });
    });
  }

  // P2-28: no durable function transaction is open while an actor runs, and the app can cancel promptly.
  test('P2-28 a paused actor holds no transaction or lock; cancel is bounded; the detector can go red', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const role = (await worker.query('SELECT current_user AS u')).rows[0].u as string;
    const openTransactions = async () =>
      (
        await owner.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE usename = ANY($1::text[]) AND xact_start IS NOT NULL`,
          [[role, 'telesphoros_test_app']],
        )
      ).rows[0].n as number;
    const heldLocks = async (pid: number) => (await owner.query('SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1', [pid])).rows[0].n as number;
    let resume!: () => void;
    let started!: () => void;
    const actorStarted = new Promise<void>((r) => {
      started = r;
    });
    const paused: ScriptedActors = {
      ...scriptedActors(['accept']),
      async draft(sources, attemptId) {
        started();
        await new Promise<void>((r) => {
          resume = r;
        });
        return scriptedActors(['accept']).draft(sources, attemptId);
      },
    };
    const result = runDurableSynthetic(run.stamp, run.expected, run.store, paused, new AbortController().signal);
    await actorStarted;
    expect(await openTransactions()).toBe(0);
    expect(await heldLocks(workerPid)).toBe(0);
    const t0 = Date.now();
    const cancelled = await run.store.cancel(run.runId, caller);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(cancelled).toMatchObject({ kind: 'ok', value: { terminalState: 'cancelled', counters: { usageState: 'unknown' } } });
    resume();
    expect(await result).toEqual({ kind: 'refused', code: 'STALE_CLAIM' });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ settled: false, in_flight: true, usage_state: 'unknown', outcomes: 1 });
    // Positive control: an open worker transaction is visible to the same probes.
    const open = new Client({ connectionString: fixture.workerUrl });
    await open.connect();
    try {
      await open.query('BEGIN');
      await open.query('SELECT 1');
      expect(await openTransactions()).toBe(1);
      expect(await heldLocks(await backendPid(open))).toBeGreaterThan(0);
      await open.query('ROLLBACK');
    } finally {
      await open.end();
    }
  });

  // P2-16: the original DB deadline is never reset and cannot be extended by the process.
  test('P2-16 release, reconnect and reclaim keep the original deadline; past 120s nothing dispatches', async () => {
    const { caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const original = await runRow(run.runId);
    expect(await run.queue.release(run.jobId, 'worker-a')).toBe(true);
    const reconnected = new Client({ connectionString: fixture.workerUrl });
    await reconnected.connect();
    try {
      const queue = new SyntheticJobQueue(reconnected);
      expect((await queue.claim('worker-b', claimOptions)).map((j) => j.id)).toEqual([run.jobId]);
      const claim = queue.claimFor(run.jobId, 'worker-b')!;
      const reclaimed = await runRow(run.runId);
      expect({ admitted: reclaimed.admitted_at, deadline: reclaimed.deadline_at }).toEqual({ admitted: original.admitted_at, deadline: original.deadline_at });
      await deadlineIn(run.runId, -1000);
      const trace: string[] = [];
      const late = await runDurableSynthetic(claim.stamp, claim.expected, run.store, scriptedActors(['accept'], trace), new AbortController().signal);
      expect(late).toEqual({ kind: 'refused', code: 'DEADLINE_EXPIRED' });
      expect(trace).toEqual([]);
      expect(await runRow(run.runId)).toMatchObject({ state: 'queued', slots: 0, outcomes: 0 });
    } finally {
      await reconnected.end();
    }
  });

  test('P2-16 a deadline that passes mid-run stops the next dispatch even with a live process signal', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const trace: string[] = [];
    const store = interposed(run.store, async (method, n) => {
      if (method === 'begin' && n > 3) await deadlineIn(run.runId, -1); // before the director dispatch
    });
    const result = await runDurableSynthetic(run.stamp, run.expected, store, scriptedActors(['accept'], trace), new AbortController().signal);
    expect(result).toEqual({ kind: 'refused', code: 'DEADLINE_EXPIRED' });
    expect(trace).toEqual([`${run.runId}:draft:1`]);
    expect(await runRow(run.runId)).toMatchObject({ state: 'reviewing', slots: 1, outcomes: 0 });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ settled: false, in_flight: true, usage_state: 'known' });
  });

  test('P2-16 a backward clock fails closed and a reclaim never moves the guard back', async () => {
    const { caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    expect(await run.queue.release(run.jobId, 'worker-a')).toBe(true);
    // The last guarded decision is later than the database clock now reads: a clock anomaly.
    await owner.query(
      `UPDATE public.agentic_synthetic_runs SET last_guarded_at = clock_timestamp() + interval '1 hour'
      WHERE run_id=$1`,
      [run.runId],
    );
    const guard = (await runRow(run.runId)).last_guarded_at as Date;
    const queue = new SyntheticJobQueue(worker);
    expect((await queue.claim('worker-b', claimOptions)).map((j) => j.id)).toEqual([run.jobId]);
    const claim = queue.claimFor(run.jobId, 'worker-b')!;
    expect(((await runRow(run.runId)).last_guarded_at as Date).getTime()).toBe(guard.getTime());
    const trace: string[] = [];
    expect(await runDurableSynthetic(claim.stamp, claim.expected, run.store, scriptedActors(['accept'], trace), new AbortController().signal)).toEqual({
      kind: 'refused',
      code: 'DEADLINE_EXPIRED',
    });
    expect(trace).toEqual([]);
    expect(await queue.release(run.jobId, 'worker-b')).toBe(false); // the fenced queue path fails closed too
    expect(await runRow(run.runId)).toMatchObject({ state: 'queued', slots: 0, outcomes: 0 });
  });
});
