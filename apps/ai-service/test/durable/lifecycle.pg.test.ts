import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresSyntheticStore } from '../../durable/postgres';
import { SyntheticJobQueue } from '../../durable/queue';
import { runDurableSynthetic, type ScriptedActors } from '../../durable/kernel';
import { SYNTHETIC_JOB_TYPE, type FixtureCaller, type Stamp } from '../../durable/contracts';
import type { Candidate } from '../../src/contracts';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { claimOptions, digest, durableHarness, scriptedActors } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
let worker: Client;
const h = durableHarness(() => fixture, () => owner);
const { app, seedTenant, row, accounts } = h;
const actors = scriptedActors;
const admitAndClaim = (caller: FixtureCaller, workerId = 'worker-a') => h.admitAndClaim(worker, caller, workerId);

describe('owned PostgreSQL synthetic lifecycle: claim through settlement', () => {
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

  test('first-accept run releases once, settles the full reservation and acknowledges the queue', async () => {
    const { tenant, caller } = await seedTenant();
    const run = await admitAndClaim(caller);
    const trace: string[] = [];
    const result = await runDurableSynthetic(run.stamp, run.expected, run.store, actors(['accept'], trace), new AbortController().signal);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok' || !result.value) throw new Error('no outcome');
    expect(result.value).toMatchObject({ terminalState: 'released', reasonCode: 'SIMULATED_RELEASE',
      simulationReceiptRef: `simulation:${run.runId}`, tenantId: tenant,
      counters: { logicalSlots: 2, projectedTokens: 520, actualModelCalls: 0, usageState: 'known' } });
    expect(trace).toEqual([`${run.runId}:draft:1`, `${run.runId}:director:1`]);
    expect(await accounts(tenant, run.runId)).toMatchObject({ settled: true, in_flight: false, usage_state: 'known',
      observed: '520', tenant_reserved: '0', tenant_consumed: '250000', slots: 2, outcomes: 1 });
    expect(await run.queue.succeed(run.jobId, 'worker-a')).toBe(true);
    expect((await row('SELECT state FROM public.jobs WHERE id=$1', [run.jobId])).state).toBe('succeeded');
    // Audit is gap-free and append-only per run.
    const audit = await owner.query('SELECT event_sequence::int AS n, code FROM public.agentic_synthetic_audit WHERE run_id=$1 ORDER BY 1', [run.runId]);
    expect(audit.rows.map(r => r.n)).toEqual(audit.rows.map((_, i) => i + 1));
    expect(audit.rows.at(-1)?.code).toBe('FINISHED');
    const read = await run.store.read(run.runId, caller);
    expect(read).toEqual({ kind: 'ok', value: result.value });
  });

  test('one persisted valid repair permits exactly one second attempt; a second repair exhausts', async () => {
    const repaired = await seedTenant();
    const a = await admitAndClaim(repaired.caller);
    const trace: string[] = [];
    const released = await runDurableSynthetic(a.stamp, a.expected, a.store, actors(['repair', 'accept'], trace), new AbortController().signal);
    expect(released).toMatchObject({ kind: 'ok', value: { terminalState: 'released', counters: { logicalSlots: 4 } } });
    expect(trace).toEqual([1, 1, 2, 2].map((n, i) => `${a.runId}:${i % 2 ? 'director' : 'draft'}:${n}`));
    await a.queue.succeed(a.jobId, 'worker-a');

    const exhausted = await seedTenant();
    const b = await admitAndClaim(exhausted.caller);
    const held = await runDurableSynthetic(b.stamp, b.expected, b.store, actors(['repair', 'repair']), new AbortController().signal);
    expect(held).toMatchObject({ kind: 'ok', value: { terminalState: 'held', reasonCode: 'REPAIR_EXHAUSTED',
      simulatedArtifact: null, counters: { logicalSlots: 4, usageState: 'known' } } });
    expect(await accounts(exhausted.tenant, b.runId)).toMatchObject({ settled: true, in_flight: false });
    await b.queue.succeed(b.jobId, 'worker-a');
  });

  test('a hold or accept verdict never authorizes repair-pending or a second draft', async () => {
    const { caller } = await seedTenant();
    const run = await admitAndClaim(caller);
    const { store, stamp } = run;
    let expected = run.expected;
    const step = async <T extends { kind: string }>(p: Promise<T>) => {
      const r = await p; if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
      const v = (r as unknown as { value: { state: typeof expected.state; sequence: string } }).value;
      expected = { state: v.state, sequence: v.sequence }; return r;
    };
    const sources = await store.sources(stamp, expected);
    if (sources.kind !== 'ok') throw new Error('sources');
    await step(store.advance(stamp, expected, 'running'));
    const scripted = actors(['hold']);
    const input = (role: 'draft' | 'director', n: 1 | 2, cand?: Candidate) => {
      const evidence = digest(JSON.stringify(sources.value.map(s => [s.id, s.version, s.digest])));
      return role === 'draft'
        ? digest(JSON.stringify([`${run.runId}:draft:${n}`, evidence, sources.value.map(s => [s.id, s.version, s.digest])]))
        : digest(JSON.stringify([`${run.runId}:director:${n}`, cand!.digest, evidence]));
    };
    let v1 = { invocationId: randomUUID(), role: 'director' as 'draft' | 'director', ordinal: 1 as const, inputDigest: '' };
    const d1 = { invocationId: randomUUID(), role: 'draft' as 'draft' | 'director', ordinal: 1 as const, inputDigest: input('draft', 1) };
    await step(store.begin(stamp, expected, d1 as never));
    const draft = await scripted.draft(sources.value, '');
    const receipt = (inv: typeof d1 | typeof v1) => ({ invocationId: inv.invocationId, role: inv.role, inputDigest: inv.inputDigest });
    await step(store.observe(stamp, expected, { ...receipt(d1), observation: draft.observation, artifact: draft.artifact as Candidate }));
    await step(store.advance(stamp, expected, 'reviewing'));
    v1 = { invocationId: randomUUID(), role: 'director', ordinal: 1 as const, inputDigest: input('director', 1, draft.artifact as Candidate) };
    await step(store.begin(stamp, expected, v1 as never));
    const verdict = await scripted.director(draft.artifact as Candidate, digest(JSON.stringify(sources.value.map(s => [s.id, s.version, s.digest]))), '');
    await step(store.observe(stamp, expected, { ...receipt(v1), observation: verdict.observation, artifact: verdict.artifact as never } as never));
    // Forged state: the persisted first verdict is `hold`, so neither route to attempt two opens.
    expect(await store.advance(stamp, expected, 'repair-pending')).toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
    expect(await store.advance(stamp, expected, 'release-pending')).toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
    expect(await store.begin(stamp, expected, { invocationId: randomUUID(), role: 'draft', ordinal: 2, inputDigest: input('draft', 2) }))
      .toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
    const forged = { terminalState: 'released', reasonCode: 'SIMULATED_RELEASE', candidate: draft.artifact,
      verdict: verdict.artifact, evidenceDigest: digest(JSON.stringify(sources.value.map(s => [s.id, s.version, s.digest]))) };
    // The adapter refuses it first; the database refuses it independently when called directly.
    expect(await store.finish(stamp, expected, forged as never)).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    const direct = await worker.query('SELECT public.agentic_synthetic_finish($1::jsonb,$2::jsonb,$3::jsonb) AS r',
      [JSON.stringify(stamp), JSON.stringify(expected), JSON.stringify(forged)]);
    expect(direct.rows[0].r).toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
    const held = await store.finish(stamp, expected, { terminalState: 'held', reasonCode: 'DIRECTOR_HELD' });
    expect(held).toMatchObject({ kind: 'ok', value: { terminalState: 'held' } });
    // Exact repeat is idempotent; a changed terminal proposal never makes a second outcome.
    expect(await store.finish(stamp, expected, { terminalState: 'held', reasonCode: 'DIRECTOR_HELD' })).toEqual(held);
    expect(await store.finish(stamp, expected, { terminalState: 'failed', reasonCode: 'INVALID_EVIDENCE' }))
      .toEqual({ kind: 'refused', code: 'INVALID_TRANSITION' });
    await run.queue.succeed(run.jobId, 'worker-a');
  });

  test('stale or forged stamps cannot load, advance or settle the queue', async () => {
    const { caller } = await seedTenant();
    const run = await admitAndClaim(caller);
    const forged: Stamp[] = [{ ...run.stamp, fence: String(BigInt(run.stamp.fence) + 1n) },
      { ...run.stamp, claimId: randomUUID() }, { ...run.stamp, queueAttempt: 2 }, { ...run.stamp, workerId: 'worker-b' }];
    for (const stamp of forged) {
      expect(await run.store.load(stamp, run.expected)).toEqual({ kind: 'refused', code: 'STALE_CLAIM' });
      const control = await worker.query('SELECT public.agentic_synthetic_queue_control($1::jsonb,$2,$3) AS r',
        [JSON.stringify(stamp), 'succeed', null]);
      expect(control.rows[0].r).toEqual({ kind: 'refused', code: 'STALE_CLAIM' });
    }
    expect(await run.store.load(run.stamp, { ...run.expected, sequence: '99' })).toEqual({ kind: 'refused', code: 'STALE_SEQUENCE' });
    // Malformed SQL inputs are refusals, never errors that could leak or abort.
    for (const bad of [null, 'scalar', [], 1, { ...run.stamp, extra: 1 }, { ...run.stamp, queueAttempt: '1' }]) {
      const r = await worker.query('SELECT public.agentic_synthetic_load($1::jsonb,$2::jsonb) AS r',
        [JSON.stringify(bad), JSON.stringify(run.expected)]);
      expect(r.rows[0].r).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    }
    const done = await runDurableSynthetic(run.stamp, run.expected, run.store, actors(['accept']), new AbortController().signal);
    expect(done).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    await run.queue.succeed(run.jobId, 'worker-a');
  });

  test('release then reclaim raises the fence, invalidates the old stamp and holds without replay', async () => {
    const { tenant, caller } = await seedTenant();
    const first = await admitAndClaim(caller, 'worker-a');
    const { store } = first;
    const running = await store.advance(first.stamp, first.expected, 'running');
    if (running.kind !== 'ok') throw new Error('advance');
    // A clean shutdown gives the job back; the existing release does not count the attempt.
    expect(await first.queue.release(first.jobId, 'worker-a')).toBe(true);
    const queueB = new SyntheticJobQueue(worker);
    const jobs = await queueB.claim('worker-a', claimOptions); // same worker ID, same queue attempt number
    expect(jobs.map(j => j.id)).toEqual([first.jobId]);
    const second = queueB.claimFor(first.jobId, 'worker-a')!;
    expect(second.stamp.queueAttempt).toBe(first.stamp.queueAttempt);
    expect(BigInt(second.stamp.fence)).toBe(BigInt(first.stamp.fence) + 1n);
    expect(second.stamp.claimId).not.toBe(first.stamp.claimId);
    const old = await store.advance(first.stamp, { state: 'running', sequence: running.value.sequence }, 'reviewing');
    expect(old).toEqual({ kind: 'refused', code: 'STALE_CLAIM' });
    expect(await first.queue.heartbeat(first.jobId, 'worker-a', 15)).toBe(false);
    const trace: string[] = [];
    const result = await runDurableSynthetic(second.stamp, second.expected, store, actors(['accept'], trace), new AbortController().signal);
    expect(result).toMatchObject({ kind: 'ok', value: { terminalState: 'held', reasonCode: 'RECLAIM_HELD',
      counters: { logicalSlots: 0, usageState: 'known' } } });
    expect(trace).toEqual([]);
    expect(await accounts(tenant, first.runId)).toMatchObject({ settled: true, in_flight: false, slots: 0 });
    expect(await first.queue.succeed(first.jobId, 'worker-a')).toBe(false);
    expect(await queueB.succeed(first.jobId, 'worker-a')).toBe(true);
  });

  test('lease loss with maxAttempts 1 makes the job dead; the next claim holds the known-usage run', async () => {
    const { tenant, caller } = await seedTenant();
    const run = await admitAndClaim(caller, 'worker-a');
    await owner.query(`UPDATE public.jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id=$1`, [run.jobId]);
    expect(await new SyntheticJobQueue(worker).claim('worker-b', claimOptions)).toEqual([]);
    expect(await row('SELECT state FROM public.jobs WHERE id=$1', [run.jobId])).toEqual({ state: 'dead' });
    expect(await row('SELECT outcome->>$2 AS reason, state FROM public.agentic_synthetic_outcomes o JOIN public.agentic_synthetic_runs r USING (tenant_id, run_id) WHERE run_id=$1',
      [run.runId, 'reasonCode'])).toEqual({ reason: 'QUEUE_DEAD', state: 'held' });
    expect(await accounts(tenant, run.runId)).toMatchObject({ settled: true, in_flight: false });
    expect(await run.store.load(run.stamp, run.expected)).toEqual({ kind: 'refused', code: 'STALE_CLAIM' });
  });

  test('a first claim after the 15s queue-wait bound expires with no dispatch and frees the slot', async () => {
    const { tenant, caller } = await seedTenant();
    const store = new PostgresSyntheticStore(worker, app);
    const admitted = await store.admit({ schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1',
      locale: 'es', question: '¿Cómo redacto el SOP?', idempotencyKey: `late/${randomUUID()}` }, caller);
    if (admitted.kind !== 'ok') throw new Error('admit');
    await owner.query(`UPDATE public.agentic_synthetic_runs SET admitted_at = admitted_at - interval '20 seconds',
      deadline_at = deadline_at - interval '20 seconds', last_guarded_at = last_guarded_at - interval '20 seconds'
      WHERE run_id=$1`, [admitted.value.runId]);
    const queue = new SyntheticJobQueue(worker);
    await queue.claim('worker-a', claimOptions);
    const claim = queue.claimFor(admitted.value.jobId, 'worker-a')!;
    const trace: string[] = [];
    const result = await runDurableSynthetic(claim.stamp, claim.expected, store, actors(['accept'], trace), new AbortController().signal);
    expect(result).toMatchObject({ kind: 'ok', value: { terminalState: 'expired', reasonCode: 'QUEUE_WAIT_EXPIRED' } });
    expect(trace).toEqual([]);
    expect(await accounts(tenant, admitted.value.runId)).toMatchObject({ settled: true, in_flight: false, slots: 0 });
    await queue.succeed(admitted.value.jobId, 'worker-a');
  });

  test('revoked grant blocks readback of a stored outcome; current authority reads it', async () => {
    const { tenant, grantId, caller } = await seedTenant();
    const run = await admitAndClaim(caller);
    const done = await runDurableSynthetic(run.stamp, run.expected, run.store, actors(['accept']), new AbortController().signal);
    expect(done).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    await run.queue.succeed(run.jobId, 'worker-a');
    expect((await run.store.read(run.runId, caller)).kind).toBe('ok');
    expect(await run.store.read(run.runId, { ...caller, grantGeneration: '2' })).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    await owner.query('UPDATE public.agentic_synthetic_grants SET enabled=false WHERE tenant_id=$1 AND grant_id=$2', [tenant, grantId]);
    expect(await run.store.read(run.runId, caller)).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    expect(await row('SELECT count(*)::int AS n FROM public.agentic_synthetic_outcomes WHERE run_id=$1', [run.runId])).toEqual({ n: 1 });
  });

  test('a direct job_enqueue of the synthetic type is failed as an orphan and never dispatched', async () => {
    const { caller } = await seedTenant();
    const orphanRun = randomUUID();
    const job = await app.withTenant(caller.tenantId, db => db.query(
      `SELECT * FROM public.job_enqueue($1,$2::jsonb,$3,now(),1)`, [SYNTHETIC_JOB_TYPE, JSON.stringify({ runId: orphanRun }), `syn-${orphanRun}`]),
    { actor: caller.requesterRef });
    const queue = new SyntheticJobQueue(worker);
    expect(await queue.claim('worker-a', claimOptions)).toEqual([]);
    expect((await row('SELECT state, last_error_code FROM public.jobs WHERE id=$1', [job.rows[0].job_id])))
      .toEqual({ state: 'dead', last_error_code: 'synthetic-orphan' });
  });

  test('restricted logins hold only their specified entry points; helpers stay private', async () => {
    const { rows } = await owner.query(`SELECT p.proname,
        has_function_privilege('telesphoros_test_app', p.oid, 'EXECUTE') AS app,
        has_function_privilege('telesphoros_test_worker', p.oid, 'EXECUTE') AS worker,
        has_function_privilege('telesphoros_test_verifier', p.oid, 'EXECUTE') AS verifier,
        p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
        coalesce(array_to_string(p.proconfig, ','), '') AS config
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'agentic_synthetic_%'`);
    const appFns = ['agentic_synthetic_admit', 'agentic_synthetic_read', 'agentic_synthetic_cancel'];
    const workerFns = ['agentic_synthetic_claim', 'agentic_synthetic_load', 'agentic_synthetic_sources', 'agentic_synthetic_advance',
      'agentic_synthetic_begin', 'agentic_synthetic_observe', 'agentic_synthetic_finish', 'agentic_synthetic_queue_control'];
    expect(rows.length).toBeGreaterThan(30);
    for (const fn of rows) {
      expect.soft({ fn: fn.proname, app: fn.app }).toEqual({ fn: fn.proname, app: appFns.includes(fn.proname) });
      expect.soft({ fn: fn.proname, worker: fn.worker }).toEqual({ fn: fn.proname, worker: workerFns.includes(fn.proname) });
      expect.soft({ fn: fn.proname, verifier: fn.verifier }).toEqual({ fn: fn.proname, verifier: false });
      expect.soft({ fn: fn.proname, path: fn.config.includes('search_path=pg_catalog, pg_temp') })
        .toEqual({ fn: fn.proname, path: true });
      if (appFns.includes(fn.proname) || workerFns.includes(fn.proname)) expect.soft(fn.definer).toBe(true);
    }
    await expect(worker.query(`SELECT public.agentic_synthetic_authority('x', gen_random_uuid())`)).rejects.toThrow(/permission denied/);
  });

  // Last: an unknown dispatch holds its fleet capacity permanently in this inactive slice.
  test('cancel invalidates the fence; unknown usage keeps the full reservation and permit', async () => {
    const known = await seedTenant();
    const k = await admitAndClaim(known.caller);
    const cancelledKnown = await k.store.cancel(k.runId, known.caller);
    expect(cancelledKnown).toMatchObject({ kind: 'ok', value: { terminalState: 'cancelled', counters: { usageState: 'known' } } });
    expect(await k.store.cancel(k.runId, known.caller)).toEqual(cancelledKnown);
    expect(await k.store.load(k.stamp, k.expected)).toEqual({ kind: 'refused', code: 'STALE_CLAIM' });
    expect(await accounts(known.tenant, k.runId)).toMatchObject({ settled: true, in_flight: false });

    const unknown = await seedTenant();
    const u = await admitAndClaim(unknown.caller);
    let dispatched = 0;
    const blocking: ScriptedActors = { ...actors(['accept']), async draft(sources, attemptId) {
      dispatched++;
      const cancel = await u.store.cancel(u.runId, unknown.caller);
      expect(cancel).toMatchObject({ kind: 'ok', value: { terminalState: 'cancelled', counters: { usageState: 'unknown', logicalSlots: 1 } } });
      return actors(['accept']).draft(sources, attemptId);
    } };
    const result = await runDurableSynthetic(u.stamp, u.expected, u.store, blocking, new AbortController().signal);
    expect(result).toEqual({ kind: 'refused', code: 'STALE_CLAIM' });
    expect(dispatched).toBe(1);
    expect(await accounts(unknown.tenant, u.runId)).toMatchObject({ settled: false, in_flight: true, usage_state: 'unknown',
      tenant_reserved: '250000', tenant_consumed: '0', outcomes: 1 });
  });
});
