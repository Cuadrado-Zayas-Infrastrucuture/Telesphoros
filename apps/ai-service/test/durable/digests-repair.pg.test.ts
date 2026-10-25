import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresSyntheticStore } from '../../durable/postgres';
import { SyntheticJobQueue } from '../../durable/queue';
import { runDurableSynthetic } from '../../durable/kernel';
import type { DurableSyntheticStore, Expected, FixtureCaller, Stamp } from '../../durable/contracts';
import type { Candidate, Source } from '../../src/contracts';
import { ownedPostgresFixture } from '../helpers/postgres-fixture';
import { candidateFrom, claimOptions, digest, durableHarness, inputDigest, scriptedActors, sopBody } from '../helpers/durable-pg';
import type { EphemeralDatabase } from '../../../backend/test/helpers/database';

let fixture: EphemeralDatabase;
let owner: Client;
let worker: Client;
const h = durableHarness(
  () => fixture,
  () => owner,
);
const viewOf = (r: { kind: string; value?: unknown }): Expected => {
  if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
  const v = r.value as { state: Expected['state']; sequence: string };
  return { state: v.state, sequence: v.sequence };
};

// Golden vectors. Ids and versions exercise JSON escaping; bodies start with 26 ASCII bytes so the
// scripted candidate span never splits a code point. Byte order puts 'B…' before 'a…' before 'sop…'.
const tricky = { id: 'B-ü/"q"\\', version: 'v1\t2', body: 'Step one: wash both hands. ¿Lávese bien? 😀 fin\u0001' };
const spanish = { id: 'a-ñ', version: 'v1', body: 'Step one: wash both hands. Ñandú «Ω» é é' };
const question = 'Paso: «Ω» "comillas" \\ barra/ \n línea \t tab 😀   \u0001 \u007f';
// Written by hand, independently of both serializers.
const expectedRequestPreimage = '["agentic.request.v1","business.sop-draft.v1","es","Paso: «Ω» \\"comillas\\" \\\\ barra/ \\n línea \\t tab 😀   \\u0001 \u007f"]';
const expectedEvidencePreimage = () =>
  '[' + [`["B-ü/\\"q\\"\\\\","v1\\t2","${digest(tricky.body)}"]`, `["a-ñ","v1","${digest(spanish.body)}"]`, `["sop-handwash","v1","${digest(sopBody)}"]`].join(',') + ']';

async function seedVectors(tenant: string, grantId: string) {
  for (const s of [tricky, spanish]) {
    await owner.query(
      `INSERT INTO public.agentic_synthetic_sources(tenant_id,source_id,source_version,digest,body,eligible)
      VALUES ($1,$2,$3,$4,$5,true)`,
      [tenant, s.id, s.version, digest(s.body), s.body],
    );
    await owner.query(
      `INSERT INTO public.agentic_synthetic_grant_sources(tenant_id,grant_id,source_id,source_version,enabled)
      VALUES ($1,$2,$3,$4,true)`,
      [tenant, grantId, s.id, s.version],
    );
  }
}
const admitVector = async (caller: FixtureCaller) => {
  const admitted = await new PostgresSyntheticStore(worker, h.app).admit(
    { schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1', locale: 'es', question, idempotencyKey: `vec/${randomUUID()}` },
    caller,
  );
  if (admitted.kind !== 'ok') throw new Error(admitted.code);
  return admitted.value;
};
const preimages = (runId: string) =>
  h.row(
    `SELECT request_tuple_preimage AS request, request_digest, evidence_tuple_preimage AS evidence,
  evidence_digest FROM public.agentic_synthetic_runs WHERE run_id=$1`,
    [runId],
  );

describe('owned PostgreSQL synthetic digest parity and the attempt-two matrix', () => {
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

  test('P2-26 EN/ES, escaping and Unicode preimages match a hand-written golden, TypeScript and SQL byte for byte', async () => {
    const { tenant, grantId, caller } = await h.seedTenant();
    await seedVectors(tenant, grantId);
    const admitted = await admitVector(caller);
    const row = await preimages(admitted.runId);
    const tsRequest = JSON.stringify(['agentic.request.v1', 'business.sop-draft.v1', 'es', question]);
    const tuple = [
      [tricky.id, tricky.version, digest(tricky.body)],
      [spanish.id, 'v1', digest(spanish.body)],
      ['sop-handwash', 'v1', digest(sopBody)],
    ];
    expect({ sql: row.request, ts: tsRequest }).toEqual({ sql: expectedRequestPreimage, ts: expectedRequestPreimage });
    expect(row.request_digest).toBe(digest(expectedRequestPreimage));
    expect({ sql: row.evidence, ts: JSON.stringify(tuple) }).toEqual({ sql: expectedEvidencePreimage(), ts: expectedEvidencePreimage() });
    expect(row.evidence_digest).toBe(digest(expectedEvidencePreimage()));
    // The SQL-derived draft input digest equals the TypeScript one for the same vector.
    const sources = tuple.map(([id, version, d]) => ({ id, version, digest: d })) as unknown as Source[];
    const sqlInput = (await h.row('SELECT public.agentic_synthetic_input_digest($1,$2,$3,1) AS d', [tenant, admitted.runId, 'draft'])).d;
    expect(sqlInput).toBe(inputDigest(admitted.runId, sources, 'draft', 1));
    // End to end: the kernel's TypeScript digests are accepted by every SQL check and the run releases.
    const queue = new SyntheticJobQueue(worker);
    await queue.claim('worker-a', claimOptions);
    const claim = queue.claimFor(admitted.jobId, 'worker-a')!;
    expect(
      await runDurableSynthetic(claim.stamp, claim.expected, new PostgresSyntheticStore(worker, h.app), scriptedActors(['accept']), new AbortController().signal),
    ).toMatchObject({ kind: 'ok', value: { terminalState: 'released' } });
    expect(await queue.succeed(admitted.jobId, 'worker-a')).toBe(true);
  });

  test('P2-26 NUL and lone surrogates never reach a preimage: the parameter itself is rejected and nothing is written', async () => {
    const { caller } = await h.seedTenant();
    const store = new PostgresSyntheticStore(worker, h.app);
    for (const bad of ['NUL\u0000', 'lone\ud800']) {
      expect(
        await store.admit({ schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1', locale: 'en', question: bad, idempotencyKey: `bad/${randomUUID()}` }, caller),
      ).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    }
    for (const raw of ['"NUL\\u0000"', '"lone\\ud800"']) {
      const text = `{"schemaVersion":"agentic.request.v1","taskKey":"business.sop-draft.v1","locale":"en","question":${raw},"idempotencyKey":"raw-${randomUUID()}"}`;
      await expect(
        h.app.withTenant(caller.tenantId, (db) => db.query('SELECT public.agentic_synthetic_admit($1::jsonb,$2::jsonb) AS r', [text, JSON.stringify(caller)]), {
          actor: caller.requesterRef,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^22/) });
    }
    expect(await h.row('SELECT count(*)::int AS n FROM public.agentic_synthetic_runs WHERE tenant_id=$1', [caller.tenantId])).toEqual({ n: 0 });
  });

  test('P2-26 attempt two opens only from the persisted valid first repair; every swapped or forged input is refused', async () => {
    const { caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const { store, stamp } = run;
    let expected = run.expected;
    const ok = async (p: Promise<{ kind: string; value?: unknown }>) => {
      expected = viewOf(await p);
    };
    const sourcesResult = await store.sources(stamp, expected);
    if (sourcesResult.kind !== 'ok') throw new Error('sources');
    const sources = sourcesResult.value;
    const evidence = digest(JSON.stringify(sources.map((s) => [s.id, s.version, s.digest])));
    await ok(store.advance(stamp, expected, 'running'));
    const d1 = { invocationId: randomUUID(), role: 'draft' as const, ordinal: 1 as const, inputDigest: inputDigest(run.runId, sources, 'draft', 1) };
    await ok(store.begin(stamp, expected, d1));
    const candidate: Candidate = candidateFrom(sources[0]!, [[0, 26]]);
    const obs = { inputUnits: 10, generatedUnits: 10 };
    await ok(store.observe(stamp, expected, { invocationId: d1.invocationId, role: 'draft', inputDigest: d1.inputDigest, observation: obs, artifact: candidate }));
    await ok(store.advance(stamp, expected, 'reviewing'));
    const v1 = { invocationId: randomUUID(), role: 'director' as const, ordinal: 1 as const, inputDigest: inputDigest(run.runId, sources, 'director', 1, candidate) };
    await ok(store.begin(stamp, expected, v1));
    const verdict = (over: object = {}) => ({
      decision: 'repair',
      candidateDigest: candidate.digest,
      evidenceDigest: evidence,
      claimVerdicts: [{ claimId: 'claim-1', supported: true }],
      ...over,
    });
    const observeVerdict = (artifact: object) =>
      store.observe(stamp, expected, { invocationId: v1.invocationId, role: 'director', inputDigest: v1.inputDigest, observation: obs, artifact: artifact as never });
    const refused = (code: string) => ({ kind: 'refused', code });
    // A verdict bound to another evidence set or candidate is not a repair authority.
    expect(await observeVerdict(verdict({ evidenceDigest: digest('other evidence') }))).toEqual(refused('INVALID_EVIDENCE'));
    expect(await observeVerdict(verdict({ candidateDigest: digest('other candidate') }))).toEqual(refused('INVALID_EVIDENCE'));
    await ok(observeVerdict(verdict()));
    const d2 = (over: Partial<{ inputDigest: string; invocationId: string }> = {}) => ({
      invocationId: randomUUID(),
      role: 'draft' as const,
      ordinal: 2 as const,
      inputDigest: inputDigest(run.runId, sources, 'draft', 2),
      ...over,
    });
    // Not yet: still reviewing, and a repair verdict never opens release.
    expect(await store.begin(stamp, expected, d2())).toEqual(refused('INVALID_TRANSITION'));
    expect(await store.advance(stamp, expected, 'release-pending')).toEqual(refused('INVALID_TRANSITION'));
    await ok(store.advance(stamp, expected, 'repair-pending'));
    expect(await store.begin(stamp, expected, d2())).toEqual(refused('INVALID_TRANSITION'));
    await ok(store.advance(stamp, expected, 'running'));
    // Swapped attempt, run or evidence in the input digest.
    expect(await store.begin(stamp, expected, d2({ inputDigest: inputDigest(run.runId, sources, 'draft', 1) }))).toEqual(refused('INVALID_EVIDENCE'));
    expect(await store.begin(stamp, expected, d2({ inputDigest: inputDigest(randomUUID(), sources, 'draft', 2) }))).toEqual(refused('INVALID_EVIDENCE'));
    expect(await store.begin(stamp, expected, d2({ inputDigest: digest(JSON.stringify([`${run.runId}:draft:2`, digest('x'), []])) }))).toEqual(refused('INVALID_EVIDENCE'));
    // Stale stamp and stale sequence.
    const stale: Stamp = { ...stamp, fence: String(BigInt(stamp.fence) + 1n) };
    expect(await store.begin(stale, expected, d2())).toEqual(refused('STALE_CLAIM'));
    expect(await store.begin(stamp, { ...expected, sequence: '1' }, d2())).toEqual(refused('STALE_SEQUENCE'));
    // The exact attempt two begins once; a duplicate begin is refused (its usage is now unknown, which refuses first).
    await ok(store.begin(stamp, expected, d2()));
    expect(await store.begin(stamp, expected, d2())).toEqual(refused('USAGE_UNKNOWN'));
    expect(await h.row('SELECT count(*)::int AS n FROM public.agentic_synthetic_invocations WHERE run_id=$1', [run.runId])).toEqual({ n: 3 });
    // A NUL in a terminal proposal is rejected by the parameter cast; no outcome is created.
    await expect(
      worker.query('SELECT public.agentic_synthetic_finish($1::jsonb,$2::jsonb,$3::jsonb) AS r', [
        JSON.stringify(stamp),
        JSON.stringify(expected),
        '{"terminalState":"held","reasonCode":"DIRECTOR_HELD\\u0000"}',
      ]),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^22/) });
    expect(await h.row('SELECT count(*)::int AS n FROM public.agentic_synthetic_outcomes WHERE run_id=$1', [run.runId])).toEqual({ n: 0 });
  });

  test('P2-26 a source revoked after the persisted repair blocks attempt two: no second dispatch, no outcome', async () => {
    const { tenant, caller } = await h.seedTenant();
    const run = await h.admitAndClaim(worker, caller);
    const trace: string[] = [];
    const revokeBeforeRepair = new Proxy(run.store, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== 'advance') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: Parameters<DurableSyntheticStore['advance']>) => {
          if (args[2] === 'repair-pending') await owner.query('UPDATE public.agentic_synthetic_sources SET eligible=false WHERE tenant_id=$1', [tenant]);
          return target.advance(...args);
        };
      },
    });
    expect(await runDurableSynthetic(run.stamp, run.expected, revokeBeforeRepair, scriptedActors(['repair', 'accept'], trace), new AbortController().signal)).toEqual({
      kind: 'refused',
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(trace).toEqual([`${run.runId}:draft:1`, `${run.runId}:director:1`]);
    expect(await h.row('SELECT count(*)::int AS n FROM public.agentic_synthetic_outcomes WHERE run_id=$1', [run.runId])).toEqual({ n: 0 });
  });

  // Last: it changes this disposable database's column collation for the rest of the file.
  test('P2-26 the evidence order is byte order even when the source column uses a locale collation', async () => {
    const icu = (await owner.query(`SELECT collname FROM pg_collation WHERE collname = 'en-US-x-icu'`)).rows;
    expect(icu).toEqual([{ collname: 'en-US-x-icu' }]); // the simulation needs ICU; fail loudly if absent
    await owner.query(`ALTER TABLE public.agentic_synthetic_grant_sources ALTER COLUMN source_id TYPE text COLLATE "en-US-x-icu"`);
    await owner.query(`ALTER TABLE public.agentic_synthetic_sources ALTER COLUMN source_id TYPE text COLLATE "en-US-x-icu"`);
    const locale = (await owner.query(`SELECT array_agg(x ORDER BY x) AS o FROM unnest(ARRAY[$1::text,$2::text]) x`, ['B', 'a'])).rows[0].o;
    const icuOrder = (await owner.query(`SELECT array_agg(x ORDER BY x COLLATE "en-US-x-icu") AS o FROM unnest(ARRAY[$1::text,$2::text]) x`, ['B', 'a'])).rows[0].o;
    expect({ locale, icuOrder }).toEqual({ locale: ['B', 'a'], icuOrder: ['a', 'B'] }); // the two orders really differ
    const { tenant, grantId, caller } = await h.seedTenant();
    await seedVectors(tenant, grantId);
    const admitted = await admitVector(caller);
    expect((await preimages(admitted.runId)).evidence).toBe(expectedEvidencePreimage());
  });
});
