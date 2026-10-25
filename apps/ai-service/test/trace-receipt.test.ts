import { describe, expect, test } from 'vitest';
import { CASES } from '../evals/golden/cases';
import { RESULTS } from '../evals/golden/results';
import { canonicalJson, keyedDigest } from '../src/keyed-digest';
import { runExplanation } from '../src/explain';
import { hashBytes } from '../src/evidence';
import { outcomeV2Schema } from '../src/outcome-v2';
import { traceSchema } from '../src/trace';
import { BAD_GLOSS, explainScenario, GOOD, modelOf, TEST_KEY } from './helpers/explain-adapters';

type S = ReturnType<typeof explainScenario>;
const go = (s: S) => runExplanation(s.request, s.context, s.ports);

/** Every string from the engine result and the model's output that must never appear in a trace, receipt or log (SC-005). */
const forbidden = (): string[] => {
  const out = new Set<string>();
  for (const r of Object.values(RESULTS)) {
    out.add(r.recommendationText);
    if (r.implication) out.add(r.implication);
    for (const g of r.genes) {
      out.add(g.phenotype);
      out.add(g.gene);
    }
    out.add(r.drug);
  }
  for (const c of CASES) for (const st of (c.candidate as { statements?: Array<{ text?: string }> }).statements ?? []) if (st.text) out.add(st.text);
  out.add('MODELWORD');
  out.add(Buffer.from(TEST_KEY).toString('hex'));
  return [...out].filter((x) => x.length >= 4);
};
const leaks = (value: unknown): string[] => {
  const text = JSON.stringify(value);
  return forbidden().filter((f) => text.includes(f));
};

describe('SC-005: no result text, phenotype string or model word in any trace, receipt or outcome record', () => {
  test('control: the scan finds text when it is there', () => {
    expect(leaks({ note: 'Reduced enzyme function increases exposure to drugv.' }).length).toBeGreaterThan(0);
    expect(leaks({ gene: 'GENEA' })).toContain('GENEA');
    expect(leaks({ k: Buffer.from(TEST_KEY).toString('hex') }).length).toBeGreaterThan(0);
  });
  test('a released run and every golden case run through the harness leave none', async () => {
    const runs: S[] = [];
    for (const c of CASES) {
      const s = explainScenario({ resultKey: c.result, replies: { draft: c.candidate, repair: c.candidate } });
      s.request.engine = { ...s.request.engine, strength: RESULTS[c.result].strength, explainable: RESULTS[c.result] };
      runs.push(s);
    }
    runs.push(explainScenario({ replies: { draft: BAD_GLOSS, repair: BAD_GLOSS } }));
    let released = 0;
    for (const s of runs) {
      const o = await go(s);
      if (o.released) released++;
      expect(o.receipt, 'every run leaves a receipt').not.toBeNull();
      expect(outcomeV2Schema.safeParse(o.receipt).success).toBe(true);
      expect(traceSchema.safeParse(o.trace).success).toBe(true);
      expect(leaks({ receipt: o.receipt, trace: o.trace }), JSON.stringify(o.reasonCode)).toEqual([]);
    }
    expect(released).toBeGreaterThan(0);
  });
  test('a failure with a hostile model reply leaves none either', async () => {
    const s = explainScenario({ replies: { draft: BAD_GLOSS, repair: BAD_GLOSS } });
    const o = await go(s);
    expect(o.reasonCode).toBe('SENSOR_HOLD');
    expect(leaks({ receipt: o.receipt, trace: o.trace })).toEqual([]);
  });
});

describe('the receipt (FR-009, FR-010, T043)', () => {
  test('records the pinned model, the harness version, keyed digests of the evidence and the output, and the guards that ran', async () => {
    const s = explainScenario();
    const o = await go(s);
    const r = o.receipt!;
    expect(r).toMatchObject({
      task: 'pgx.explain.v1',
      terminalState: 'released',
      reasonCode: 'RELEASED',
      tenantId: 'tenant-a',
      requesterRef: 'staff-a',
      harnessVersion: s.ports.harnessVersion,
    });
    expect(r.model).toEqual(s.ports.model.identity);
    expect(r.digests.evidence).toBe(keyedDigest(TEST_KEY, canonicalJson(RESULTS.avoid)));
    expect(r.digests.output).toBe(keyedDigest(TEST_KEY, canonicalJson(GOOD)));
    expect(r.digests.template).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.guardsRun).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'VERIFIER']);
  });
  test('a plain SHA-256 of the evidence does not match the stored digest', async () => {
    const o = await go(explainScenario());
    expect(o.receipt!.digests.evidence.replace('hmac-sha256:', '')).not.toBe(hashBytes(canonicalJson(RESULTS.avoid)).replace('sha256:', ''));
  });
  test('the digests depend on the key: another key gives another digest for the same evidence', async () => {
    const a = explainScenario(),
      b = explainScenario();
    b.ports.digestKey = new Uint8Array(32).fill(9);
    expect((await go(a)).receipt!.digests.evidence).not.toBe((await go(b)).receipt!.digests.evidence);
  });
  test('a short key cannot produce a receipt, and the run still returns the engine text', async () => {
    const s = explainScenario();
    s.ports.digestKey = new Uint8Array(8);
    const o = await go(s);
    expect(o.receipt).toBeNull();
    expect(o.engineText.length).toBeGreaterThan(0);
  });
  test('a run that never reaches a model records no model and no template', async () => {
    const s = explainScenario();
    s.request.engine = { outcome: 'held', reasonCode: 'cell-disputed', strength: null, explainable: null };
    const o = await go(s);
    expect(o.receipt).toMatchObject({
      reasonCode: 'NOT_ELIGIBLE',
      detailCodes: ['cell-disputed'],
      model: null,
      digests: { template: null, output: null },
      counters: { modelCalls: 0 },
    });
  });
  test('refusals before admission still leave a receipt for the caller', async () => {
    const s = explainScenario({ baaCovered: false, syntheticOnly: false });
    s.request.dataMarker = 'real';
    const o = await go(s);
    expect(o.receipt).toMatchObject({ reasonCode: 'NO_BAA', runId: 'unadmitted', terminalState: 'held' });
  });
  test('a sensor hold records the fixed reason codes, the digest of the held output, and no text', async () => {
    const o = await go(explainScenario({ replies: { draft: BAD_GLOSS, repair: BAD_GLOSS } }));
    expect(o.receipt).toMatchObject({ reasonCode: 'SENSOR_HOLD', terminalState: 'held' });
    expect(o.receipt!.detailCodes.length).toBeGreaterThan(0);
    expect(o.receipt!.digests.output).toMatch(/^hmac-sha256:/);
  });
  test('a deadline is recorded as expired', async () => {
    const s = explainScenario();
    s.hooks['draft-complete'] = () => s.tick(121000);
    expect((await go(s)).receipt).toMatchObject({ reasonCode: 'DEADLINE', terminalState: 'expired' });
  });
});

describe('real usage (FR-008, T024)', () => {
  test('counters are the provider-reported units summed over every call, and the state is known', async () => {
    const s = explainScenario();
    let expectedIn = 0;
    const inner = s.ports.model;
    s.ports.model = modelOf(async (req) => {
      const reply = await inner.complete(req);
      expectedIn += reply.observation!.inputUnits;
      return reply;
    });
    const o = await go(s);
    expect(o.receipt!.counters).toEqual({ slots: 2, modelCalls: 2, inputUnits: expectedIn, generatedUnits: 128, usageState: 'known' });
    expect(o.counters).toMatchObject({ inputUnits: expectedIn, generatedUnits: 128, usageState: 'known' });
  });
  test('a provider that reports no usage holds the run and the usage is unknown', async () => {
    const s = explainScenario({ model: modelOf(async () => ({ artifact: GOOD, observation: null })) });
    const o = await go(s);
    expect(o).toMatchObject({ released: false, reasonCode: 'USAGE_HELD' });
    expect(o.receipt).toMatchObject({ reasonCode: 'USAGE_HELD', counters: { usageState: 'unknown', modelCalls: 1 } });
  });
  test('a call that fails after it started leaves the usage unknown, not zero', async () => {
    const s = explainScenario({
      model: modelOf(async () => {
        throw new Error('upstream');
      }),
    });
    expect((await go(s)).receipt).toMatchObject({ reasonCode: 'MODEL_ERROR', counters: { usageState: 'unknown', modelCalls: 1, inputUnits: 0 } });
  });
  test('a release never has unknown usage', async () => expect((await go(explainScenario())).receipt!.counters.usageState).toBe('known'));
});

describe('the trace (FR-009)', () => {
  test('a release records its steps in order, with the state, no reason, and usage that only grows', async () => {
    const o = await go(explainScenario());
    expect(o.trace.map((t) => t.step)).toEqual(['admission', 'draft', 'sensors', 'verify', 'release', 'end']);
    expect(o.trace.at(-1)).toMatchObject({ step: 'end', state: 'released', reasonCode: 'RELEASED' });
    for (let i = 1; i < o.trace.length; i++) expect(o.trace[i].inputUnits).toBeGreaterThanOrEqual(o.trace[i - 1].inputUnits);
    expect(o.trace.slice(0, -1).every((t) => t.reasonCode === null)).toBe(true);
  });
  test('a repair shows both drafts and the sensor hold that caused it', async () => {
    const o = await go(explainScenario({ replies: { draft: BAD_GLOSS } }));
    expect(o.trace.map((t) => t.step)).toEqual(['admission', 'draft', 'sensors', 'draft', 'sensors', 'verify', 'release', 'end']);
    expect(o.trace[2].reasonCode).toBe('SENSOR_HOLD');
  });
  test('durations come from the run clock', async () => {
    const s = explainScenario();
    s.hooks.verify = () => s.tick(500);
    const o = await go(s);
    expect(o.trace.find((t) => t.step === 'verify')!.durationMs).toBeGreaterThanOrEqual(500);
  });
});

describe('detail codes keep only code-shaped tokens', () => {
  test('a task-registry detail yields its R-codes, and a detail with no code yields none', async () => {
    const s = explainScenario();
    const o = await runExplanation(s.request, s.context, s.ports, {
      'pgx.explain.v1': { dataClass: 'phi', output: 'free-text', checks: [], promptFields: [], provider: 'baa-required' },
    });
    expect(o.reasonCode).toBe('TASK_UNDECLARED');
    expect(o.receipt!.detailCodes.every((c) => /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(c))).toBe(true);
    expect(o.receipt!.detailCodes).toEqual(expect.arrayContaining(['R4_NO_CHECKS']));
  });
});
