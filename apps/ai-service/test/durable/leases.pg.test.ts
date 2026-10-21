import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresSyntheticStore } from '../../durable/postgres';
import { SyntheticJobQueue } from '../../durable/queue';
import { runDurableSynthetic, type ScriptedActors } from '../../durable/kernel';
import { SYNTHETIC_JOB_TYPE, type DurableSyntheticStore, type Expected, type FixtureCaller, type Stamp } from '../../durable/contracts';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { backendPid, claimOptions, durableHarness, inputDigest, scriptedActors } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
let worker: Client;
let workerPid: number;
const h = durableHarness(() => fixture, () => owner);
const STALE = { kind: 'refused', code: 'STALE_CLAIM' };
const finishSql = 'SELECT public.agentic_synthetic_finish($1::jsonb,$2::jsonb,$3::jsonb) AS r';
const cancelSql = 'SELECT public.agentic_synthetic_cancel($1::uuid,$2::jsonb) AS r';
const runRow = (runId: string) => h.row(`SELECT r.state, r.fence::text AS fence, r.claim_id, j.state AS job_state,
  j.attempts, j.locked_by, (SELECT count(*)::int FROM public.agentic_synthetic_outcomes o WHERE o.run_id=r.run_id) AS outcomes,
  (SELECT o.outcome->>'terminalState' FROM public.agentic_synthetic_outcomes o WHERE o.run_id=r.run_id) AS terminal,
  (SELECT o.outcome->>'reasonCode' FROM public.agentic_synthetic_outcomes o WHERE o.run_id=r.run_id) AS reason
  FROM public.agentic_synthetic_runs r JOIN public.jobs j ON j.id=r.job_id WHERE r.run_id=$1`, [runId]);
const viewOf = (r: { kind: string; value?: unknown }): Expected => {
  if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
  const v = r.value as { state: Expected['state']; sequence: string };
  return { state: v.state, sequence: v.sequence };
};
const connect = async (url: string) => { const c = new Client({ connectionString: url }); await c.connect(); return c; };
/** An app connection holding an open transaction bound to the caller, so a test can order commits. */
async function appTransaction(caller: FixtureCaller) {
  const c = await connect(fixture.appUrl);
  const pid = await backendPid(c);
  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.current_tenant_id',$1,true)`, [caller.tenantId]);
  await c.query(`SELECT set_config('app.current_actor',$1,true)`, [caller.requesterRef]);
  return { c, pid };
}
/** Lets the kernel reach its final decision but withholds the commit, so the test owns that transaction. */
function withheldFinish(store: DurableSyntheticStore) {
  const captured: { args: unknown[] | null } = { args: null };
  const proxy = new Proxy(store, { get(target, key, receiver) {
    if (key === 'finish') return async (...args: unknown[]) => { captured.args = args; return { kind: 'refused', code: 'STORAGE_UNAVAILABLE' }; };
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { proxy, captured };
}
async function releasePending(caller: FixtureCaller, db: Client = worker) {
  const run = await h.admitAndClaim(db, caller);
  const { proxy, captured } = withheldFinish(run.store);
  await runDurableSynthetic(run.stamp, run.expected, proxy, scriptedActors(['accept']), new AbortController().signal);
  if (!captured.args) throw new Error('no final decision');
  return { ...run, finishParams: captured.args.map(a => JSON.stringify(a)) };
}
const legacyClaim = (db: Client, workerId: string) =>
  db.query('SELECT * FROM public.job_claim($1,$2::text[],1,1,15)', [workerId, [SYNTHETIC_JOB_TYPE]]);

describe('owned PostgreSQL synthetic leases, fencing and recovery races', () => {
  beforeAll(async () => {
    fixture = await ownedPostgresFixture();
    owner = await connect(fixture.adminUrl);
    worker = await connect(fixture.workerUrl);
    workerPid = await backendPid(worker);
    await owner.query(`INSERT INTO public.agentic_synthetic_capacity(singleton,tenant_day_units,fleet_month_units)
      VALUES (1,5000000,300000000)`);
  }, 180_000);
  afterAll(async () => { await worker?.end(); await owner?.end(); await fixture?.drop(); }, 60_000);
  afterEach(() => h.releaseAllPermits());

  test('P2-13 a legacy job_release + job_claim keeps worker, attempt, claim and fence but cannot revive the old stamp', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const running = viewOf(await run.store.advance(run.stamp, run.expected, 'running'));
    const before = await runRow(run.runId);
    expect((await worker.query('SELECT public.job_release($1,$2) AS r', [run.jobId, 'worker-a'])).rows[0].r).toBe(true);
    expect((await legacyClaim(worker, 'worker-a')).rows.map(r => r.id)).toEqual([run.jobId]);
    const after = await runRow(run.runId);
    // Everything the stamp names is identical; only the existing queue's claim instance changed.
    expect({ fence: after.fence, claim: after.claim_id, attempts: after.attempts, by: after.locked_by, job: after.job_state })
      .toEqual({ fence: before.fence, claim: before.claim_id, attempts: run.stamp.queueAttempt, by: 'worker-a', job: 'running' });
    expect(await run.store.load(run.stamp, running)).toEqual(STALE);
    expect(await run.store.advance(run.stamp, running, 'reviewing')).toEqual(STALE);
    expect(await run.queue.succeed(run.jobId, 'worker-a')).toBe(false);
    // The legacy claim's lease lapses; the job dies and the sweep holds the known-usage run once.
    await h.expireLease(run.jobId);
    await new SyntheticJobQueue(worker).claim('worker-b', claimOptions);
    expect(await runRow(run.runId)).toMatchObject({ state: 'held', job_state: 'dead', outcomes: 1, reason: 'QUEUE_DEAD' });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ settled: true, in_flight: false });
  });

  test('P2-13 a stamp from an uncommitted claim never loads; a waiting load sees the rollback', async () => {
    const { caller } = await h.seedTenant();
    const store = new PostgresSyntheticStore(worker, h.app);
    const admitted = await h.admit(store, caller);
    const claimer = await connect(fixture.workerUrl);
    try {
      await claimer.query('BEGIN');
      const rows = (await claimer.query('SELECT * FROM public.agentic_synthetic_claim($1,1)', ['worker-t'])).rows;
      expect(rows.map(r => r.id)).toEqual([admitted.jobId]);
      const c = rows[0];
      const stamp: Stamp = { jobId: c.id, runId: c.run_id, workerId: 'worker-t', queueAttempt: c.attempt, claimId: c.claim_id, fence: String(c.fence) };
      const loading = store.load(stamp, { state: c.state, sequence: String(c.sequence) });
      await h.lockWaiting(workerPid);
      await claimer.query('ROLLBACK');
      expect(await loading).toEqual(STALE);
    } finally { await claimer.end(); }
    expect(await runRow(admitted.runId)).toMatchObject({ fence: '0', claim_id: null, job_state: 'queued' });
    // Positive control: the committed claim's stamp loads and runs to one released outcome.
    const queue = new SyntheticJobQueue(worker);
    expect((await queue.claim('worker-t', claimOptions)).map(j => j.id)).toEqual([admitted.jobId]);
    const claim = queue.claimFor(admitted.jobId, 'worker-t')!;
    expect(await runDurableSynthetic(claim.stamp, claim.expected, store, scriptedActors(['accept']), new AbortController().signal))
      .toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    expect(await queue.succeed(admitted.jobId, 'worker-t')).toBe(true);
  });

  test('P2-14 after release and reclaim with the same worker and attempt, every old callback fails and nothing replays', async () => {
    const { tenant, caller } = await h.seedTenant();
    const a = await h.admitAndClaim(worker, caller);
    const sources = await a.store.sources(a.stamp, a.expected);
    if (sources.kind !== 'ok') throw new Error('sources');
    const running = viewOf(await a.store.advance(a.stamp, a.expected, 'running'));
    const d1 = { invocationId: randomUUID(), role: 'draft' as const, ordinal: 1 as const, inputDigest: inputDigest(a.runId, sources.value, 'draft', 1) };
    const begun = viewOf(await a.store.begin(a.stamp, running, d1));
    expect(await a.queue.release(a.jobId, 'worker-a')).toBe(true);
    const other = await connect(fixture.workerUrl);
    try {
      const queueB = new SyntheticJobQueue(other);
      expect((await queueB.claim('worker-a', claimOptions)).map(j => j.id)).toEqual([a.jobId]);
      const b = queueB.claimFor(a.jobId, 'worker-a')!;
      expect(b.stamp.queueAttempt).toBe(a.stamp.queueAttempt);
      const old = a.stamp;
      const draft = await scriptedActors(['accept']).draft(sources.value, '');
      expect(await a.store.load(old, begun)).toEqual(STALE);
      expect(await a.store.sources(old, begun)).toEqual(STALE);
      expect(await a.store.advance(old, begun, 'reviewing')).toEqual(STALE);
      expect(await a.store.begin(old, begun, { ...d1, invocationId: randomUUID(), role: 'director' })).toEqual(STALE);
      expect(await a.store.observe(old, begun, { invocationId: d1.invocationId, role: 'draft', inputDigest: d1.inputDigest,
        observation: draft.observation, artifact: draft.artifact as never })).toEqual(STALE);
      expect(await a.store.finish(old, begun, { terminalState: 'held', reasonCode: 'RECLAIM_HELD' })).toEqual(STALE);
      expect(await a.queue.heartbeat(a.jobId, 'worker-a', 15)).toBe(false);
      expect(await a.queue.succeed(a.jobId, 'worker-a')).toBe(false);
      expect(await a.queue.fail(a.jobId, 'worker-a', 'stale-worker', false)).toBeUndefined();
      expect(await a.queue.release(a.jobId, 'worker-a')).toBe(false);
      // The new claim sees the durable unknown marker and refuses without calling any actor.
      const trace: string[] = [];
      const store = new PostgresSyntheticStore(other, h.app);
      expect(await runDurableSynthetic(b.stamp, b.expected, store, scriptedActors(['accept'], trace), new AbortController().signal))
        .toEqual({ kind: 'refused', code: 'USAGE_UNKNOWN' });
      expect(trace).toEqual([]);
      // P2-35: a caller asking for a retry still gets the fixed nonretryable failure.
      expect(await queueB.fail(a.jobId, 'worker-a', 'synthetic-unknown', true)).toBe('dead');
      expect(await runRow(a.runId)).toMatchObject({ job_state: 'dead', outcomes: 0 });
      expect(await h.accounts(tenant, a.runId)).toMatchObject({ settled: false, in_flight: true, usage_state: 'unknown',
        tenant_reserved: '250000', unknown_slots: 1 });
    } finally { await other.end(); }
  });

  test('P2-15 a reply after lease loss lands nothing; an AbortSignal-ignoring actor is not retried', async () => {
    const late = await h.seedTenant();
    const a = await h.admitAndClaim(worker, late.caller);
    const trace: string[] = [];
    const lateActor: ScriptedActors = { ...scriptedActors(['accept'], trace), async draft(sources, attemptId) {
      await h.expireLease(a.jobId);
      expect(await a.queue.heartbeat(a.jobId, 'worker-a', 15)).toBe(false); // the heartbeat is lost
      return scriptedActors(['accept'], trace).draft(sources, attemptId);
    } };
    expect(await runDurableSynthetic(a.stamp, a.expected, a.store, lateActor, new AbortController().signal)).toEqual(STALE);
    expect(trace).toEqual([`${a.runId}:draft:1`]);
    expect(await h.accounts(late.tenant, a.runId)).toMatchObject({ unknown_slots: 1, usage_state: 'unknown', in_flight: true,
      tenant_reserved: '250000', outcomes: 0 });

    const ignoring = await h.seedTenant();
    const b = await h.admitAndClaim(worker, ignoring.caller, 'worker-c');
    const controller = new AbortController();
    const ignoringActor: ScriptedActors = { ...scriptedActors(['accept'], trace), async draft(sources, attemptId) {
      controller.abort(); // the Runner gives up; this actor ignores the signal and replies anyway
      return scriptedActors(['accept'], trace).draft(sources, attemptId);
    } };
    expect(await runDurableSynthetic(b.stamp, b.expected, b.store, ignoringActor, controller.signal)).toEqual({ kind: 'refused', code: 'ABORTED' });
    // Recovery: both leases lapse, both jobs die, the sweep holds both runs and neither actor runs again.
    await h.expireLease(b.jobId);
    await new SyntheticJobQueue(worker).claim('worker-d', claimOptions);
    expect(trace).toEqual([`${a.runId}:draft:1`, `${b.runId}:draft:1`]);
    for (const [tenant, runId] of [[late.tenant, a.runId], [ignoring.tenant, b.runId]] as const) {
      expect(await runRow(runId)).toMatchObject({ state: 'held', job_state: 'dead', outcomes: 1, reason: 'QUEUE_DEAD' });
      expect(await h.accounts(tenant, runId)).toMatchObject({ settled: false, in_flight: true, usage_state: 'unknown', tenant_reserved: '250000' });
    }
  });

  test('P2-19 finish holding its locks first: the waiting cancel finds the released outcome and adds nothing', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await releasePending(caller);
    const app = await appTransaction(caller);
    try {
      await worker.query('BEGIN');
      expect((await worker.query(finishSql, run.finishParams)).rows[0].r).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
      const cancelling = app.c.query(cancelSql, [run.runId, JSON.stringify(caller)]);
      await h.lockWaiting(app.pid);
      await worker.query('COMMIT');
      expect((await cancelling).rows[0].r).toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
      await app.c.query('COMMIT');
    } finally { await worker.query('ROLLBACK').catch(() => undefined); await app.c.end(); }
    expect(await runRow(run.runId)).toMatchObject({ outcomes: 1, terminal: 'released' });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ settled: true, in_flight: false, tenant_consumed: '250000' });
  });

  test('P2-19 cancel holding its locks first: the waiting finish is fenced out and the late result lands nowhere', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await releasePending(caller);
    const app = await appTransaction(caller);
    try {
      expect((await app.c.query(cancelSql, [run.runId, JSON.stringify(caller)])).rows[0].r)
        .toMatchObject({ kind: 'ok', value: { terminalState: 'cancelled', counters: { usageState: 'known' } } });
      const finishing = worker.query(finishSql, run.finishParams);
      await h.lockWaiting(workerPid);
      await app.c.query('COMMIT');
      expect((await finishing).rows[0].r).toEqual(STALE);
    } finally { await app.c.end(); }
    expect(await runRow(run.runId)).toMatchObject({ outcomes: 1, terminal: 'cancelled', claim_id: null });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ settled: true, in_flight: false, tenant_consumed: '250000' });
    expect(await run.queue.succeed(run.jobId, 'worker-a')).toBe(false);
  });

  test('P2-35 current and stale queue control race on separate connections: only the current stamp acknowledges', async () => {
    const { caller } = await h.seedTenant();
    const a = await h.admitAndClaim(worker, caller);
    expect(await a.queue.release(a.jobId, 'worker-a')).toBe(true);
    const other = await connect(fixture.workerUrl);
    try {
      const queueB = new SyntheticJobQueue(other);
      await queueB.claim('worker-a', claimOptions);
      const b = queueB.claimFor(a.jobId, 'worker-a')!;
      const done = await runDurableSynthetic(b.stamp, b.expected, new PostgresSyntheticStore(other, h.app), scriptedActors(['accept']),
        new AbortController().signal);
      expect(done).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
      const [stale, current] = await Promise.all([a.queue.succeed(a.jobId, 'worker-a'), queueB.succeed(a.jobId, 'worker-a')]);
      expect({ stale, current }).toEqual({ stale: false, current: true });
      // No unfenced fallback: a queue instance that holds no stamp for the job, or another worker ID, does nothing.
      expect(await new SyntheticJobQueue(worker).succeed(a.jobId, 'worker-a')).toBe(false);
      expect(queueB.claimFor(a.jobId, 'worker-z')).toBeNull();
    } finally { await other.end(); }
    expect(await runRow(a.runId)).toMatchObject({ job_state: 'succeeded', outcomes: 1, terminal: 'released' });
  });

  test('a legacy job_succeed under a live run cannot leak its permit: the next claim holds the run', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const running = viewOf(await run.store.advance(run.stamp, run.expected, 'running'));
    expect((await worker.query('SELECT public.job_succeed($1,$2) AS r', [run.jobId, 'worker-a'])).rows[0].r).toBe(true);
    expect(await run.store.advance(run.stamp, running, 'reviewing')).toEqual(STALE);
    await new SyntheticJobQueue(worker).claim('worker-b', claimOptions);
    expect(await runRow(run.runId)).toMatchObject({ state: 'held', job_state: 'succeeded', outcomes: 1, reason: 'QUEUE_DEAD' });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ settled: true, in_flight: false });
  });

  test('P2-28 lock order: concurrent finish, cancel and claim sweeps never deadlock or time out', async () => {
    const failures: string[] = [];
    const attempt = async (work: () => Promise<unknown>) => {
      try { return await work(); } catch (error) { failures.push((error as { code?: string }).code ?? 'unknown'); return null; }
    };
    for (let round = 0; round < 5; round++) {
      const seeds = [await h.seedTenant(), await h.seedTenant()]; // one owner connection: sequential
      const runs = [] as Awaited<ReturnType<typeof releasePending>>[];
      for (const s of seeds) runs.push(await releasePending(s.caller));
      const conns = await Promise.all([fixture.workerUrl, fixture.workerUrl, fixture.workerUrl].map(connect));
      const appCancel = async (i: number) => {
        const app = await appTransaction(seeds[i]!.caller);
        try { const r = (await app.c.query(cancelSql, [runs[i]!.runId, JSON.stringify(seeds[i]!.caller)])).rows[0].r; await app.c.query('COMMIT'); return r; }
        finally { await app.c.end(); }
      };
      try {
        // Opposite issue orders per round so each pair meets in both orders.
        const ops = [() => conns[0]!.query(finishSql, runs[0]!.finishParams), () => conns[1]!.query(finishSql, runs[1]!.finishParams),
          () => appCancel(0), () => appCancel(1), () => conns[2]!.query('SELECT * FROM public.agentic_synthetic_claim($1,1)', ['sweeper'])];
        await Promise.all((round % 2 ? ops.reverse() : ops).map(op => attempt(op)));
      } finally { await Promise.all(conns.map(c => c.end())); }
      for (const r of runs) {
        const row = await runRow(r.runId);
        expect({ outcomes: row.outcomes, terminal: ['released', 'cancelled'].includes(row.terminal) }).toEqual({ outcomes: 1, terminal: true });
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
