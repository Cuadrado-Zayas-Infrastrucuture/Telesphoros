import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { runDurableSynthetic } from '../../durable/kernel';
import type { Decision, DurableSyntheticStore } from '../../durable/contracts';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { backendPid, durableHarness, scriptedActors } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
let worker: Client;
let workerPid: number; // captured idle: a busy connection cannot answer its own pid
const h = durableHarness(() => fixture, () => owner);
const methods = ['load', 'sources', 'advance', 'begin', 'observe', 'finish'];
// The accept path's protected boundaries, in kernel order, and how many actor calls precede each.
const boundaries = [['load', 0], ['sources', 0], ['advance', 0], ['begin', 0], ['observe', 1], ['advance', 1],
  ['begin', 1], ['observe', 2], ['advance', 2], ['finish', 2]] as const;
const revoke = (tenant: string, sub: string, how: 'bump' | 'remove') => owner.query(how === 'bump'
  ? 'UPDATE public.tenant_memberships SET roles = roles WHERE tenant_id=$1 AND sub=$2' // any update bumps the version
  : `UPDATE public.tenant_memberships SET status='removed' WHERE tenant_id=$1 AND sub=$2`, [tenant, sub]);
const outcomes = async (runId: string) =>
  (await h.row('SELECT count(*)::int AS n FROM public.agentic_synthetic_outcomes WHERE run_id=$1', [runId])).n as number;
const finishSql = 'SELECT public.agentic_synthetic_finish($1::jsonb,$2::jsonb,$3::jsonb) AS r';

/** Runs `beforeCall` ahead of the n-th protected store call and records that call's answer. */
function revokingAt(store: DurableSyntheticStore, at: number, beforeCall: () => Promise<unknown>) {
  let n = 0;
  const seen: { method?: string; answer?: Decision<unknown> } = {};
  const proxy = new Proxy(store, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== 'function' || !methods.includes(String(key))) return value;
    return async (...args: unknown[]) => {
      const mine = n++ === at;
      if (mine) await beforeCall();
      const answer = await value.apply(target, args);
      if (mine) Object.assign(seen, { method: String(key), answer });
      return answer;
    };
  } });
  return { proxy, seen };
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

describe('owned PostgreSQL synthetic membership at every protected boundary', () => {
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
  afterAll(async () => { await worker?.end(); await owner?.end(); await fixture?.drop(); }, 60_000);
  afterEach(() => h.releaseAllPermits());

  test('P2-07 control: the valid active membership version passes every boundary', async () => {
    const { caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const { proxy, seen } = revokingAt(run.store, -1, async () => undefined);
    const result = await runDurableSynthetic(run.stamp, run.expected, proxy, scriptedActors(['accept']), new AbortController().signal);
    expect(result).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    expect(seen).toEqual({});
    await run.queue.succeed(run.jobId, 'worker-a');
  });

  boundaries.forEach(([method, actorCalls], at) => {
    const how = at % 2 ? 'remove' : 'bump';
    test(`P2-07 membership ${how} before ${method} #${at} refuses it with no later dispatch or release`, async () => {
      const { tenant, caller } = await h.seedTenant();
      const run = await h.admitAndClaim(worker, caller);
      const trace: string[] = [];
      const { proxy, seen } = revokingAt(run.store, at, () => revoke(tenant, caller.requesterRef, how));
      const result = await runDurableSynthetic(run.stamp, run.expected, proxy, scriptedActors(['accept'], trace),
        new AbortController().signal);
      expect(seen).toEqual({ method, answer: { kind: 'refused', code: 'NOT_AUTHORIZED' } });
      expect(result).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
      expect(trace).toHaveLength(actorCalls);
      expect(await outcomes(run.runId)).toBe(0);
      expect(await h.accounts(tenant, run.runId)).toMatchObject({ settled: false, in_flight: true });
      // The app's readback and cancel refuse the stale requester too.
      expect(await run.store.read(run.runId, caller)).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
      expect(await run.store.cancel(run.runId, caller)).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    });
  });

  test('P2-11 revocation committed while finish waits on the membership lock denies the finish', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const { proxy, captured } = withheldFinish(run.store);
    await runDurableSynthetic(run.stamp, run.expected, proxy, scriptedActors(['accept']), new AbortController().signal);
    if (!captured.args) throw new Error('no final decision');
    const revoker = new Client({ connectionString: fixture.adminUrl });
    await revoker.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query(`UPDATE public.tenant_memberships SET status='removed' WHERE tenant_id=$1 AND sub=$2`, [tenant, caller.requesterRef]);
      const finishing = worker.query(finishSql, captured.args.map(a => JSON.stringify(a)));
      await h.lockWaiting(workerPid);
      await revoker.query('COMMIT');
      expect((await finishing).rows[0].r).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    } finally { await revoker.end(); }
    expect(await outcomes(run.runId)).toBe(0);
  });

  test('P2-11 a finish that holds the membership lock commits once; the later revocation waits, then reads refuse', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const { proxy, captured } = withheldFinish(run.store);
    await runDurableSynthetic(run.stamp, run.expected, proxy, scriptedActors(['accept']), new AbortController().signal);
    if (!captured.args) throw new Error('no final decision');
    const revoker = new Client({ connectionString: fixture.adminUrl });
    await revoker.connect();
    const revokerPid = await backendPid(revoker);
    try {
      await worker.query('BEGIN');
      const finished = (await worker.query(finishSql, captured.args.map(a => JSON.stringify(a)))).rows[0].r;
      expect(finished).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
      const revoking = revoker.query(`UPDATE public.tenant_memberships SET status='removed' WHERE tenant_id=$1 AND sub=$2`,
        [tenant, caller.requesterRef]);
      await h.lockWaiting(revokerPid);
      await worker.query('COMMIT');
      expect((await revoking).rowCount).toBe(1);
      expect(await outcomes(run.runId)).toBe(1);
      expect(await run.store.read(run.runId, caller)).toEqual({ kind: 'refused', code: 'NOT_AUTHORIZED' });
      expect(await h.accounts(tenant, run.runId)).toMatchObject({ settled: true, in_flight: false });
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined); // no-op after COMMIT; unblocks on failure
      await revoker.end();
    }
  });
});
