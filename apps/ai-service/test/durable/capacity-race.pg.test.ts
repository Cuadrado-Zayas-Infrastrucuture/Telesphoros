import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresSyntheticStore } from '../../durable/postgres';
import { SyntheticJobQueue } from '../../durable/queue';
import type { FixtureCaller } from '../../durable/contracts';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { claimOptions, durableHarness, inputDigest } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
let worker: Client;
const h = durableHarness(() => fixture, () => owner);
const request = () => ({ schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1', locale: 'en',
  question: 'Draft the hand-washing SOP', idempotencyKey: `race/${randomUUID()}` });
// Each admission opens its own restricted app connection, so Promise.all is a real cross-connection race.
const raceAdmit = (store: PostgresSyntheticStore, callers: FixtureCaller[]) => Promise.all(callers.map(c => store.admit(request(), c)));
const totals = async () => (await owner.query(`SELECT
    (SELECT count(*)::int FROM public.jobs WHERE type='test.agentic-synthetic') AS jobs,
    (SELECT count(*)::int FROM public.agentic_synthetic_runs) AS runs,
    (SELECT count(*)::int FROM public.agentic_synthetic_reservations) AS reservations,
    (SELECT count(*)::int FROM public.agentic_synthetic_reservations WHERE in_flight) AS permits,
    (SELECT coalesce(sum(reserved_units),0)::text FROM public.agentic_synthetic_buckets WHERE scope='fleet') AS fleet_reserved,
    (SELECT coalesce(sum(reserved_units),0)::text FROM public.agentic_synthetic_buckets WHERE scope='tenant') AS tenant_reserved`)).rows[0];

describe('owned PostgreSQL synthetic cross-connection capacity', () => {
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

  let held: { tenant: string; caller: FixtureCaller; runId: string; jobId: string } | undefined;

  test('P2-20 one tenant racing four connections gets exactly one permit and no partial rows', async () => {
    const { tenant, caller } = await h.seedTenant();
    const store = new PostgresSyntheticStore(worker, h.app);
    const results = await raceAdmit(store, [caller, caller, caller, caller]);
    const won = results.filter(r => r.kind === 'ok');
    expect(won).toHaveLength(1);
    expect(results.filter(r => r.kind === 'refused' && r.code === 'CAPACITY_REFUSED')).toHaveLength(3);
    expect(await totals()).toEqual({ jobs: 1, runs: 1, reservations: 1, permits: 1, fleet_reserved: '250000', tenant_reserved: '250000' });
    const value = won[0]!.kind === 'ok' ? won[0]!.value : null;
    held = { tenant, caller, runId: value!.runId, jobId: value!.jobId };
  });

  test('P2-20 an unknown dispatch keeps its permit through cancel; three tenants race for the one left', async () => {
    if (!held) throw new Error('previous test');
    const store = new PostgresSyntheticStore(worker, h.app);
    const queue = new SyntheticJobQueue(worker);
    expect((await queue.claim('worker-a', claimOptions)).map(j => j.id)).toEqual([held.jobId]);
    const claim = queue.claimFor(held.jobId, 'worker-a')!;
    const sources = await store.sources(claim.stamp, claim.expected);
    if (sources.kind !== 'ok') throw new Error('sources');
    const running = await store.advance(claim.stamp, claim.expected, 'running');
    if (running.kind !== 'ok') throw new Error('advance');
    const begun = await store.begin(claim.stamp, { state: running.value.state, sequence: running.value.sequence },
      { invocationId: randomUUID(), role: 'draft', ordinal: 1, inputDigest: inputDigest(held.runId, sources.value, 'draft', 1) });
    expect(begun.kind).toBe('ok'); // potentially dispatched: usage is unknown from here
    expect(await store.cancel(held.runId, held.caller)).toMatchObject({ kind: 'ok',
      value: { terminalState: 'cancelled', counters: { usageState: 'unknown' } } });
    expect(await store.admit(request(), held.caller)).toEqual({ kind: 'refused', code: 'CAPACITY_REFUSED' });

    const others = [await h.seedTenant(), await h.seedTenant(), await h.seedTenant()]; // one owner connection
    const results = await raceAdmit(store, others.map(o => o.caller));
    expect(results.filter(r => r.kind === 'ok')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'refused' && r.code === 'CAPACITY_REFUSED')).toHaveLength(2);
    expect(await totals()).toEqual({ jobs: 2, runs: 2, reservations: 2, permits: 2, fleet_reserved: '500000', tenant_reserved: '500000' });
    expect(await h.accounts(held.tenant, held.runId)).toMatchObject({ settled: false, in_flight: true, usage_state: 'unknown',
      tenant_reserved: '250000', tenant_consumed: '0' });
    // The fleet is full: a fifth tenant is refused and still leaves no row behind.
    const fifth = await h.seedTenant();
    expect(await store.admit(request(), fifth.caller)).toEqual({ kind: 'refused', code: 'CAPACITY_REFUSED' });
    expect((await totals()).runs).toBe(2);
  });
});
