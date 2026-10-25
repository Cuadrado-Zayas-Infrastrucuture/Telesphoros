import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresSyntheticStore } from '../../durable/postgres';
import { SyntheticJobQueue } from '../../durable/queue';
import { runDurableSynthetic, type ScriptedActors } from '../../durable/kernel';
import type { Expected } from '../../durable/contracts';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { candidateFrom, claimOptions, durableHarness, inputDigest, scriptedActors } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
let worker: Client;
const h = durableHarness(
  () => fixture,
  () => owner,
);
const observeSql = 'SELECT public.agentic_synthetic_observe($1::jsonb,$2::jsonb,$3::jsonb) AS r';
const viewOf = (r: { kind: string; value?: unknown }): Expected => {
  if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
  const v = r.value as { state: Expected['state']; sequence: string };
  return { state: v.state, sequence: v.sequence };
};
const bucket = (scope: 'tenant' | 'fleet', key: string, start: string) =>
  h.row(
    `SELECT reserved_units::text AS reserved,
  consumed_units::text AS consumed FROM public.agentic_synthetic_buckets
  WHERE scope=$1 AND scope_key=$2 AND period_start=$3::date`,
    [scope, key, start],
  );
const today = async () =>
  (
    await owner.query(`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS d,
  date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS m`)
  ).rows[0] as { d: string; m: string };

/** A begun, unobserved draft slot: the point where only an exact bounded observation may settle usage. */
async function begunDraft(caller: Parameters<typeof h.admitAndClaim>[1]) {
  const run = await h.admitAndClaim(worker, caller);
  const sources = await run.store.sources(run.stamp, run.expected);
  if (sources.kind !== 'ok') throw new Error('sources');
  const running = viewOf(await run.store.advance(run.stamp, run.expected, 'running'));
  const d1 = { invocationId: randomUUID(), role: 'draft' as const, ordinal: 1 as const, inputDigest: inputDigest(run.runId, sources.value, 'draft', 1) };
  const begun = viewOf(await run.store.begin(run.stamp, running, d1));
  const receipt = (observation: unknown) => ({
    invocationId: d1.invocationId,
    role: 'draft',
    inputDigest: d1.inputDigest,
    observation,
    artifact: observation && typeof observation === 'object' ? candidateFrom(sources.value[0]!, [[0, 26]]) : null,
  });
  // A `{ raw }` observation is spliced in as exact JSON text, for numbers JavaScript itself cannot represent.
  const observe = async (observation: unknown) => {
    const raw = observation && typeof observation === 'object' && 'raw' in observation ? String(observation.raw) : null;
    const text = raw === null ? JSON.stringify(receipt(observation)) : JSON.stringify(receipt({ placeholder: true })).replace('{"placeholder":true}', raw);
    return (await worker.query(observeSql, [JSON.stringify(run.stamp), JSON.stringify(begun), text])).rows[0].r;
  };
  return { ...run, begun, observe, receipt };
}

describe('owned PostgreSQL synthetic budgets: integer bounds, unknown usage and original periods', () => {
  beforeAll(async () => {
    fixture = await ownedPostgresFixture();
    owner = new Client({ connectionString: fixture.adminUrl });
    worker = new Client({ connectionString: fixture.workerUrl });
    await owner.connect();
    await worker.connect();
    await owner.query(`INSERT INTO public.agentic_synthetic_capacity(singleton,tenant_day_units,fleet_month_units)
      VALUES (1,5000000,300000000)`);
  }, 180_000);
  afterAll(async () => {
    await worker?.end();
    await owner?.end();
    await fixture?.drop();
  }, 60_000);
  afterEach(() => h.releaseAllPermits());

  test('P2-21 malformed, over-bound and conflicting observations are refused without any partial charge', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await begunDraft(caller);
    const malformed: unknown[] = [
      { inputUnits: 4097, generatedUnits: 0 },
      { inputUnits: 0, generatedUnits: 769 },
      { inputUnits: -1, generatedUnits: 0 },
      { inputUnits: 1.5, generatedUnits: 0 },
      { inputUnits: 1.0e10, generatedUnits: 0 },
      { inputUnits: '100', generatedUnits: 0 },
      { inputUnits: 100 },
      { inputUnits: 1, generatedUnits: 1, extra: 0 },
      { raw: '{"inputUnits":9007199254740993,"generatedUnits":0}' },
      { raw: '{"inputUnits":1e2,"generatedUnits":0.0}' },
      [],
      'NaN',
      7,
    ];
    for (const observation of malformed) {
      expect.soft({ observation, r: await run.observe(observation) }).toEqual({ observation, r: { kind: 'refused', code: 'INVALID_INPUT' } });
    }
    // An absent observation is not a refusal of the data: usage stays unknown and nothing settles.
    expect(await run.observe(null)).toEqual({ kind: 'refused', code: 'USAGE_UNKNOWN' });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ observed: '0', unknown_slots: 1, usage_state: 'unknown', tenant_reserved: '250000' });
    // The exact per-role maximum is accepted once; an exact repeat is idempotent and any change is refused.
    expect((await run.observe({ inputUnits: 4096, generatedUnits: 768 })).kind).toBe('ok');
    expect((await run.observe({ inputUnits: 4096, generatedUnits: 768 })).kind).toBe('ok');
    expect(await run.observe({ inputUnits: 4095, generatedUnits: 768 })).toEqual({ kind: 'refused', code: 'INVALID_EVIDENCE' });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ observed: '4864', unknown_slots: 0, usage_state: 'known', slots: 1 });
  });

  test('P2-21 four maximal slots observe exactly 28160 units and settle the full 250000 once', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    let directorCalls = 0;
    const maximal: ScriptedActors = {
      async draft(sources, attemptId) {
        const reply = await scriptedActors(['accept']).draft(sources, attemptId);
        return { ...reply, observation: { inputUnits: 4096, generatedUnits: 768 } };
      },
      async director(candidate, evidenceDigest, attemptId) {
        const reply = await scriptedActors([directorCalls++ ? 'accept' : 'repair']).director(candidate, evidenceDigest, attemptId);
        return { ...reply, observation: { inputUnits: 8192, generatedUnits: 1024 } };
      },
    };
    const result = await runDurableSynthetic(run.stamp, run.expected, run.store, maximal, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'ok', value: { terminalState: 'released', counters: { logicalSlots: 4, projectedTokens: 28160 } } });
    expect(await h.accounts(tenant, run.runId)).toMatchObject({ observed: '28160', settled: true, in_flight: false, tenant_reserved: '0', tenant_consumed: '250000', slots: 4 });
  });

  test('P2-22 a missing observation keeps the full reservation and permit across reconnect, expiry and the sweep', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const silent: ScriptedActors = {
      ...scriptedActors(['accept']),
      async draft(sources, attemptId) {
        const reply = await scriptedActors(['accept']).draft(sources, attemptId);
        return { ...reply, observation: null as never };
      },
    };
    expect(await runDurableSynthetic(run.stamp, run.expected, run.store, silent, new AbortController().signal)).toEqual({ kind: 'refused', code: 'USAGE_UNKNOWN' });
    await h.expireLease(run.jobId);
    const reconnected = new Client({ connectionString: fixture.workerUrl });
    await reconnected.connect();
    try {
      await new SyntheticJobQueue(reconnected).claim('worker-b', claimOptions);
    } finally {
      await reconnected.end();
    }
    expect(await h.accounts(tenant, run.runId)).toMatchObject({
      settled: false,
      in_flight: true,
      usage_state: 'unknown',
      unknown_slots: 1,
      observed: '0',
      tenant_reserved: '250000',
      tenant_consumed: '0',
      outcomes: 1,
      run_state: 'held',
    });
    expect(await h.row(`SELECT count(*)::int AS n FROM public.agentic_synthetic_reservations WHERE in_flight`, [])).toEqual({ n: 1 });
  });

  test('P2-23 a run admitted in the previous UTC day and month settles to those buckets; the next period starts clean', async () => {
    const { tenant, caller } = await h.seedTenant();
    const now = await today();
    const run = await h.admitAndClaim(worker, caller);
    // Re-date the admission to 23:59 on the last day of the previous month (both a day and a month edge).
    const edge = (
      await owner.query(
        `SELECT (date_trunc('month', $1::date) - interval '1 day')::date::text AS d,
      (date_trunc('month', $1::date) - interval '1 month')::date::text AS m`,
        [now.d],
      )
    ).rows[0] as { d: string; m: string };
    await owner.query('BEGIN');
    await owner.query(
      `UPDATE public.agentic_synthetic_buckets SET reserved_units = reserved_units - 250000
      WHERE (scope='tenant' AND scope_key=$1 AND period_start=$2::date) OR (scope='fleet' AND period_start=$3::date)`,
      [tenant, now.d, now.m],
    );
    await owner.query(
      `INSERT INTO public.agentic_synthetic_buckets(scope,scope_key,period_kind,period_start,limit_units,reserved_units)
      VALUES ('tenant',$1,'day',$2::date,5000000,250000), ('fleet','fleet','month',$3::date,300000000,250000)
      ON CONFLICT (scope,scope_key,period_kind,period_start) DO UPDATE SET reserved_units = public.agentic_synthetic_buckets.reserved_units + 250000`,
      [tenant, edge.d, edge.m],
    );
    await owner.query(`UPDATE public.agentic_synthetic_reservations SET original_day=$2::date, original_month=$3::date WHERE run_id=$1`, [run.runId, edge.d, edge.m]);
    await owner.query('COMMIT');
    const reconnected = new Client({ connectionString: fixture.workerUrl });
    await reconnected.connect();
    try {
      const store = new PostgresSyntheticStore(reconnected, h.app);
      expect(await runDurableSynthetic(run.stamp, run.expected, store, scriptedActors(['accept']), new AbortController().signal)).toMatchObject({
        kind: 'ok',
        value: { terminalState: 'released' },
      });
    } finally {
      await reconnected.end();
    }
    expect(await bucket('tenant', tenant, edge.d)).toEqual({ reserved: '0', consumed: '250000' });
    expect(await bucket('fleet', 'fleet', edge.m)).toEqual({ reserved: '0', consumed: '250000' });
    expect(await bucket('tenant', tenant, now.d)).toEqual({ reserved: '0', consumed: '0' });
    await run.queue.succeed(run.jobId, 'worker-a');
    // The same tenant's next run reserves only in the current period; the original buckets never reset.
    const next = await h.admit(new PostgresSyntheticStore(worker, h.app), caller);
    expect(next.runId).not.toBe(run.runId);
    expect(await bucket('tenant', tenant, now.d)).toEqual({ reserved: '250000', consumed: '0' });
    expect(await bucket('tenant', tenant, edge.d)).toEqual({ reserved: '0', consumed: '250000' });
    const queue = new SyntheticJobQueue(worker);
    await queue.claim('worker-a', claimOptions);
    const claim = queue.claimFor(next.jobId, 'worker-a')!;
    expect(
      await runDurableSynthetic(claim.stamp, claim.expected, new PostgresSyntheticStore(worker, h.app), scriptedActors(['accept']), new AbortController().signal),
    ).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    expect(await queue.succeed(next.jobId, 'worker-a')).toBe(true);
    expect(await bucket('tenant', tenant, now.d)).toEqual({ reserved: '0', consumed: '250000' });
  });

  test('P2-36 the exact remaining budget admits; one unit less refuses with nothing written; settlement never repeats', async () => {
    const { tenant, caller } = await h.seedTenant();
    const now = await today();
    const store = new PostgresSyntheticStore(worker, h.app);
    // reserved + consumed + 250000 == limit is allowed; one more unit of either kind is not.
    await owner.query(
      `INSERT INTO public.agentic_synthetic_buckets(scope,scope_key,period_kind,period_start,limit_units,reserved_units,consumed_units)
      VALUES ('tenant',$1,'day',$2::date,5000000,2000001,2750000)`,
      [tenant, now.d],
    );
    const runs = (await owner.query('SELECT count(*)::int AS n FROM public.agentic_synthetic_runs')).rows[0].n as number;
    expect(
      await store.admit(
        { schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1', locale: 'en', question: 'Budget edge', idempotencyKey: `edge/${randomUUID()}` },
        caller,
      ),
    ).toEqual({ kind: 'refused', code: 'BUDGET_REFUSED' });
    expect((await owner.query('SELECT count(*)::int AS n FROM public.agentic_synthetic_runs')).rows[0].n).toBe(runs);
    await owner.query(`UPDATE public.agentic_synthetic_buckets SET reserved_units = 2000000 WHERE scope='tenant' AND scope_key=$1`, [tenant]);
    const run = await h.admitAndClaim(worker, caller);
    expect(await bucket('tenant', tenant, now.d)).toEqual({ reserved: '2250000', consumed: '2750000' });
    const done = await runDurableSynthetic(run.stamp, run.expected, run.store, scriptedActors(['accept']), new AbortController().signal);
    expect(done).toMatchObject({ kind: 'ok', value: { counters: { actualModelCalls: 0 } } });
    expect(await bucket('tenant', tenant, now.d)).toEqual({ reserved: '2000000', consumed: '3000000' });
    // A second settlement of the same run is an invariant failure, never a second charge.
    await expect(owner.query('SELECT public.agentic_synthetic_settle($1,$2)', [tenant, run.runId])).rejects.toThrow(/settlement invariant/);
    expect(await bucket('tenant', tenant, now.d)).toEqual({ reserved: '2000000', consumed: '3000000' });
    // The table refuses any write that would exceed the fixed limit, whatever the caller.
    await expect(
      owner.query(
        `UPDATE public.agentic_synthetic_buckets SET consumed_units = 5000001 - reserved_units
      WHERE scope='tenant' AND scope_key=$1`,
        [tenant],
      ),
    ).rejects.toThrow(/check constraint/);
    await run.queue.succeed(run.jobId, 'worker-a');
  });

  test('P2-36 a missing capacity configuration refuses admission instead of running unlimited', async () => {
    const { caller } = await h.seedTenant();
    await owner.query('DELETE FROM public.agentic_synthetic_capacity');
    try {
      const store = new PostgresSyntheticStore(worker, h.app);
      expect(
        await store.admit(
          { schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1', locale: 'en', question: 'No config', idempotencyKey: `cfg/${randomUUID()}` },
          caller,
        ),
      ).toEqual({ kind: 'refused', code: 'CAPACITY_REFUSED' });
      expect(await h.row('SELECT count(*)::int AS n FROM public.agentic_synthetic_runs r WHERE r.tenant_id=$1', [caller.tenantId])).toEqual({ n: 0 });
    } finally {
      await owner.query(`INSERT INTO public.agentic_synthetic_capacity(singleton,tenant_day_units,fleet_month_units)
        VALUES (1,5000000,300000000) ON CONFLICT DO NOTHING`);
    }
    // Limits are fixed by CHECK: no other value, and no NULL, can be configured.
    await expect(owner.query('UPDATE public.agentic_synthetic_capacity SET tenant_day_units = 5000001')).rejects.toThrow(/check constraint/);
    await expect(owner.query('UPDATE public.agentic_synthetic_capacity SET fleet_month_units = NULL')).rejects.toThrow(/null value/);
  });
});
