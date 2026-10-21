import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { PRODUCTION_JOBS } from '@telesphoros/jobs';
import { Runner } from '../../../worker/src/runner';
import { jsonLogger } from '../../../worker/src/log';
import { PostgresSyntheticStore } from '../../durable/postgres';
import { SyntheticJobQueue } from '../../durable/queue';
import { syntheticTestJob } from '../../durable/job';
import { runDurableSynthetic, type ScriptedActors } from '../../durable/kernel';
import { SYNTHETIC_JOB_TYPE, type DurableSyntheticStore } from '../../durable/contracts';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { claimOptions, durableHarness, scriptedActors, sopBody } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
let worker: Client;
const h = durableHarness(() => fixture, () => owner);
const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 25))) if (await check()) return;
  throw new Error('UNTIL_TIMEOUT');
};
const jobState = async (id: string) => (await h.row('SELECT state FROM public.jobs WHERE id=$1', [id])).state as string;
/** Test-only teardown after evidence: an unknown dispatch holds its fleet permit forever by design. */
const releaseHeldPermit = (runId: string) =>
  owner.query('UPDATE public.agentic_synthetic_reservations SET in_flight=false WHERE run_id=$1 AND NOT settled', [runId]);

function crashChild(mode: 'before-begin' | 'after-begin' | 'after-finish') {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'fixtures/crash-child.mjs'), mode],
    { env: { P2_CHILD_WORKER_URL: fixture.workerUrl, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { out += b; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => child.once('exit', (code, signal) => r({ code, signal })));
  return {
    async killAtReady() {
      await until(async () => out.includes('READY') || child.exitCode !== null, 20_000);
      if (!out.includes('READY')) throw new Error(`CHILD_FAILED ${out.slice(0, 200)}`);
      child.kill('SIGKILL');
      return exited;
    },
  };
}

/** Lets the kernel run to its final decision but withholds the commit, so the test owns that transaction. */
function withheldFinish(store: DurableSyntheticStore) {
  const captured: { args: Parameters<DurableSyntheticStore['finish']> | null } = { args: null };
  const proxy = new Proxy(store, { get(target, key, receiver) {
    if (key === 'finish') return async (...args: Parameters<DurableSyntheticStore['finish']>) => {
      captured.args = args; return { kind: 'refused', code: 'STORAGE_UNAVAILABLE' } as const; };
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { proxy, captured };
}
const finishSql = 'SELECT public.agentic_synthetic_finish($1::jsonb,$2::jsonb,$3::jsonb) AS r';
const finishParams = (args: Parameters<DurableSyntheticStore['finish']>) => args.map(a => JSON.stringify(a));

describe('owned PostgreSQL synthetic recovery: Runner, crashes, rollback and ambiguous commit', () => {
  beforeAll(async () => {
    fixture = await ownedPostgresFixture();
    owner = new Client({ connectionString: fixture.adminUrl });
    worker = new Client({ connectionString: fixture.workerUrl });
    await owner.connect();
    await worker.connect();
    await owner.query(`INSERT INTO public.agentic_synthetic_capacity(singleton,tenant_day_units,fleet_month_units)
      VALUES (1,5000000,300000000)`);
  }, 180_000);
  afterAll(async () => { await worker?.end(); await owner?.end(); await fixture?.drop(); }, 60_000);

  test('P2-12: the existing Runner claims, heartbeats, runs and acknowledges through the fenced wrapper', async () => {
    expect(PRODUCTION_JOBS.map(j => j.type)).not.toContain(SYNTHETIC_JOB_TYPE);
    const { tenant, caller } = await h.seedTenant();
    const store = new PostgresSyntheticStore(worker, h.app);
    const queue = new SyntheticJobQueue(worker);
    const trace: string[] = [];
    const lines: string[] = [];
    const runner = new Runner({ workerId: 'runner-p2', queue, jobs: [syntheticTestJob(queue, store, scriptedActors(['accept'], trace))],
      concurrency: 1, tenantCap: 1, pollMs: 50, drainSeconds: 2, log: jsonLogger(line => lines.push(line)) });
    const admitted = await h.admit(store, caller);
    runner.start();
    try { await until(async () => (await jobState(admitted.jobId)) === 'succeeded'); }
    finally { await runner.stop(); }
    expect(trace).toEqual([`${admitted.runId}:draft:1`, `${admitted.runId}:director:1`]);
    expect(await h.accounts(tenant, admitted.runId)).toMatchObject({ run_state: 'released', settled: true, in_flight: false, outcomes: 1 });
    const job = await h.row(`SELECT requested_by, (SELECT array_agg(outcome || ':' || worker_id ORDER BY seq)
      FROM public.job_attempts a WHERE a.job_id=j.id) AS attempts FROM public.jobs j WHERE j.id=$1`, [admitted.jobId]);
    // The requester stays the person; the Runner's system actor never becomes the requester.
    expect(job).toEqual({ requested_by: caller.requesterRef, attempts: ['succeeded:runner-p2'] });
    const logged = lines.join('\n');
    for (const secret of [caller.requesterRef, sopBody.slice(0, 20), 'hand-washing']) expect(logged).not.toContain(secret);
  });

  test('P2-12/P2-17: shutdown mid-dispatch releases; the reclaim never replays and the unknown slot stays reserved', async () => {
    const { tenant, caller } = await h.seedTenant();
    const store = new PostgresSyntheticStore(worker, h.app);
    let drafts = 0;
    let entered!: () => void;
    let unblock!: () => void;
    const inDraft = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { unblock = r; });
    const base = scriptedActors(['accept']);
    const blocking: ScriptedActors = { ...base, async draft(sources, attemptId) {
      drafts++; entered(); await gate; return base.draft(sources, attemptId); } };
    const q1 = new SyntheticJobQueue(worker);
    const r1 = new Runner({ workerId: 'runner-a', queue: q1, jobs: [syntheticTestJob(q1, store, blocking)],
      concurrency: 1, tenantCap: 1, pollMs: 50, drainSeconds: 0.1, log: jsonLogger(() => undefined) });
    const admitted = await h.admit(store, caller);
    r1.start();
    await inDraft;
    await r1.stop(); // releases the job while the draft actor is still running
    unblock();
    expect(await jobState(admitted.jobId)).toBe('queued');
    const q2 = new SyntheticJobQueue(worker);
    const r2 = new Runner({ workerId: 'runner-b', queue: q2, jobs: [syntheticTestJob(q2, store, blocking)],
      concurrency: 1, tenantCap: 1, pollMs: 50, drainSeconds: 2, log: jsonLogger(() => undefined) });
    r2.start();
    try { await until(async () => (await h.accounts(tenant, admitted.runId)).outcomes === 1); }
    finally { await r2.stop(); }
    expect(drafts).toBe(1);
    expect(await jobState(admitted.jobId)).toBe('dead');
    expect(await h.accounts(tenant, admitted.runId)).toMatchObject({ run_state: 'held', slots: 1, unknown_slots: 1,
      settled: false, in_flight: true, usage_state: 'unknown', tenant_reserved: '250000', tenant_consumed: '0' });
    const outcome = await h.row('SELECT outcome FROM public.agentic_synthetic_outcomes WHERE run_id=$1', [admitted.runId]);
    expect(outcome.outcome).toMatchObject({ reasonCode: 'QUEUE_DEAD', counters: { usageState: 'unknown', logicalSlots: 1 } });
    await releaseHeldPermit(admitted.runId);
  });

  test('P2-17: a killed worker child after begin leaves the durable unknown marker; recovery holds the full reservation', async () => {
    const { tenant, caller } = await h.seedTenant();
    const store = new PostgresSyntheticStore(worker, h.app);
    const admitted = await h.admit(store, caller);
    expect(await crashChild('after-begin').killAtReady()).toEqual({ code: null, signal: 'SIGKILL' });
    // Committed before the crash marker; nothing observed.
    expect(await h.accounts(tenant, admitted.runId)).toMatchObject({ run_state: 'running', slots: 1, unknown_slots: 1, outcomes: 0 });
    await h.expireLease(admitted.jobId);
    expect(await new SyntheticJobQueue(worker).claim('recoverer', claimOptions)).toEqual([]);
    expect(await jobState(admitted.jobId)).toBe('dead');
    expect(await h.accounts(tenant, admitted.runId)).toMatchObject({ run_state: 'held', slots: 1, unknown_slots: 1,
      settled: false, in_flight: true, usage_state: 'unknown', tenant_reserved: '250000' });
    await releaseHeldPermit(admitted.runId);
  });

  test('P2-17: a killed worker child before any begin is held with known-zero usage and settles once', async () => {
    const { tenant, caller } = await h.seedTenant();
    const store = new PostgresSyntheticStore(worker, h.app);
    const admitted = await h.admit(store, caller);
    expect(await crashChild('before-begin').killAtReady()).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await h.accounts(tenant, admitted.runId)).toMatchObject({ run_state: 'running', slots: 0, outcomes: 0 });
    await h.expireLease(admitted.jobId);
    expect(await new SyntheticJobQueue(worker).claim('recoverer', claimOptions)).toEqual([]);
    expect(await h.accounts(tenant, admitted.runId)).toMatchObject({ run_state: 'held', slots: 0, settled: true,
      in_flight: false, tenant_reserved: '0', tenant_consumed: '250000', outcomes: 1 });
  });

  test('P2-18: a crash after the committed outcome but before queue ack keeps one readable outcome and no replay', async () => {
    const { tenant, caller } = await h.seedTenant();
    const store = new PostgresSyntheticStore(worker, h.app);
    const admitted = await h.admit(store, caller);
    expect(await crashChild('after-finish').killAtReady()).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await jobState(admitted.jobId)).toBe('running'); // never acknowledged
    const before = await store.read(admitted.runId, caller);
    expect(before).toMatchObject({ kind: 'ok', value: { terminalState: 'released', counters: { logicalSlots: 2 } } });
    const digestBefore = (await h.row('SELECT outcome_digest FROM public.agentic_synthetic_outcomes WHERE run_id=$1', [admitted.runId])).outcome_digest;
    await h.expireLease(admitted.jobId);
    expect(await new SyntheticJobQueue(worker).claim('recoverer', claimOptions)).toEqual([]);
    expect(await jobState(admitted.jobId)).toBe('dead'); // queue dead is not proof of a missing business outcome
    expect(await store.read(admitted.runId, caller)).toEqual(before);
    expect(await h.accounts(tenant, admitted.runId)).toMatchObject({ outcomes: 1, slots: 2, settled: true, tenant_consumed: '250000' });
    expect((await h.row('SELECT outcome_digest FROM public.agentic_synthetic_outcomes WHERE run_id=$1', [admitted.runId])).outcome_digest)
      .toBe(digestBefore);
  });

  test('P2-24: a checked error or dropped connection before COMMIT leaves no partial outcome, audit or settlement', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const { proxy, captured } = withheldFinish(run.store);
    expect(await runDurableSynthetic(run.stamp, run.expected, proxy, scriptedActors(['accept']), new AbortController().signal))
      .toEqual({ kind: 'refused', code: 'STORAGE_UNAVAILABLE' });
    const args = captured.args!;
    const auditBefore = await h.row('SELECT max(event_sequence)::int AS n FROM public.agentic_synthetic_audit WHERE run_id=$1', [run.runId]);
    const snapshot = async () => ({ ...(await h.accounts(tenant, run.runId)),
      ...(await h.row('SELECT max(event_sequence)::int AS n FROM public.agentic_synthetic_audit WHERE run_id=$1', [run.runId])) });
    const clean = { run_state: 'release-pending', outcomes: 0, settled: false, in_flight: true, tenant_reserved: '250000', n: auditBefore.n };

    const tx = new Client({ connectionString: fixture.workerUrl });
    await tx.connect();
    await tx.query('BEGIN');
    expect((await tx.query(finishSql, finishParams(args))).rows[0].r).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    await expect(tx.query('SELECT 1/0')).rejects.toThrow(/division by zero/);
    await tx.query('ROLLBACK');
    await tx.end();
    expect(await snapshot()).toMatchObject(clean);

    const dropped = new Client({ connectionString: fixture.workerUrl });
    await dropped.connect();
    dropped.on('error', () => undefined);
    await dropped.query('BEGIN');
    expect((await dropped.query(finishSql, finishParams(args))).rows[0].r).toMatchObject({ kind: 'ok' });
    const pid = (await dropped.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    (dropped as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
    await until(async () => !(await h.row('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1', [pid])).n);
    expect(await snapshot()).toMatchObject(clean);
    // The rolled-back decision is still available exactly once to the current claim.
    expect(await run.store.finish(...args)).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ outcomes: 1, settled: true });
    await run.queue.succeed(run.jobId, 'worker-a');
  });

  test('P2-25: when the caller loses the COMMIT response, exact readback reconciles and a retry cannot duplicate', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const { proxy, captured } = withheldFinish(run.store);
    let actorCalls = 0;
    const counted = scriptedActors(['accept']);
    const actorsCounted: ScriptedActors = { draft: (...a) => { actorCalls++; return counted.draft(...a); },
      director: (...a) => { actorCalls++; return counted.director(...a); } };
    await runDurableSynthetic(run.stamp, run.expected, proxy, actorsCounted, new AbortController().signal);
    const args = captured.args!;
    const tx = new Client({ connectionString: fixture.workerUrl });
    await tx.connect();
    tx.on('error', () => undefined);
    await tx.query('BEGIN');
    await tx.query(finishSql, finishParams(args));
    const commit = tx.query('COMMIT');
    (tx as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
    const seen = await commit.then(() => 'response', () => 'lost');
    expect(seen).toBe('lost'); // the caller cannot tell whether COMMIT happened
    await until(async () => !(await h.row(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE usename='telesphoros_test_worker' AND state <> 'idle' AND query LIKE '%agentic_synthetic_finish%'`, [])).n);
    const readback = await run.store.read(run.runId, caller);
    expect(readback.kind).toBe('ok');
    const retried = await run.store.finish(...args); // reconcile: same decision, same claim
    expect(retried).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    // On this owned cluster the COMMIT reached the server: readback already holds the outcome.
    expect(readback).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    expect(retried).toEqual(readback);
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ outcomes: 1, settled: true, tenant_consumed: '250000', slots: 2 });
    expect(actorCalls).toBe(2);
    await run.queue.succeed(run.jobId, 'worker-a');
  });
});
