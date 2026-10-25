import { REASON_CODES, REASON_OUTCOME } from '@telesphoros/cpic-schema';
import { describe, expect, test } from 'vitest';
import { ATTACKS } from '../evals/attacks/attacks';
import { RESULTS } from '../evals/golden/results';
import { EXPLAIN_LIMITS, EXPLAIN_TASK, EXPLANATION_LABEL, engineTextOf, FAILURE_REASONS, type ExplainOutcome, type FailureReason } from '../src/explain-contracts';
import { runExplanation } from '../src/explain';
import { FALLBACK_TEXT } from '../src/fallback';
import { syntheticProfile } from '../src/policy';
import { TASKS } from '../src/tasks';
import { runVector } from './helpers/memory-adapters';
import { accept, BAD_GLOSS, explainScenario, GOOD } from './helpers/explain-adapters';

type S = ReturnType<typeof explainScenario>;
const go = (s: S, registry?: Parameters<typeof runExplanation>[3]) => runExplanation(s.request, s.context, s.ports, registry);
const avoidText = engineTextOf(RESULTS.avoid);

describe('the explanation run releases only a grounded, verified explanation', () => {
  test('a good draft and an accepting verifier release it, labelled, with the engine text first', async () => {
    const s = explainScenario(); const o = await go(s);
    expect(o.released).toBe(true);
    if (!o.released) return;
    expect(o).toMatchObject({ reasonCode: 'RELEASED', label: EXPLANATION_LABEL, engineText: avoidText, explanation: GOOD });
    expect(o.guardsRun).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'VERIFIER']);
    expect(s.calls).toMatchObject({ draft: 1, repair: 0, verify: 1 });
    expect(s.store.get(o.runId!).state).toBe('released');
    expect(s.budgets.counters(o.runId!)).toMatchObject({ slots: 2 });
  });
  test('one repair attempt: a sensor hold on the first draft, a good second draft', async () => {
    const s = explainScenario({ replies: { draft: BAD_GLOSS } }); const o = await go(s);
    expect(o.released).toBe(true);
    expect(s.calls).toMatchObject({ draft: 1, repair: 1, verify: 1 });
    expect(s.budgets.counters(o.runId!).slots).toBe(3);
  });
  test('two bad drafts end as a sensor hold with fixed reason codes only, and the verifier is never called', async () => {
    const s = explainScenario({ replies: { draft: BAD_GLOSS, repair: BAD_GLOSS } }); const o = await go(s);
    expect(o).toMatchObject({ released: false, reasonCode: 'SENSOR_HOLD', engineText: avoidText });
    expect(s.calls).toMatchObject({ draft: 1, repair: 1, verify: 0 });
    if (!o.released) expect(o.detail).toMatch(/^[A-Z0-9_]+(,[A-Z0-9_]+)*$/);
  });
});

describe('the verifier can only add a hold (FR-005)', () => {
  test('a verifier that accepts cannot release what the sensors hold', async () => {
    const s = explainScenario({ replies: { draft: BAD_GLOSS, repair: BAD_GLOSS, verify: accept(1) } }); const o = await go(s);
    expect(o.released).toBe(false);
    expect(s.calls.verify).toBe(0);
  });
  test.each([
    ['says hold', { decision: 'hold', statements: [{ index: 0, supported: true }, { index: 1, supported: true }, { index: 2, supported: true }] }],
    ['marks one statement unsupported', { decision: 'accept', statements: [{ index: 0, supported: true }, { index: 1, supported: false }, { index: 2, supported: true }] }],
    ['skips a statement', { decision: 'accept', statements: [{ index: 0, supported: true }, { index: 1, supported: true }] }],
    ['repeats a statement', { decision: 'accept', statements: [{ index: 0, supported: true }, { index: 0, supported: true }, { index: 1, supported: true }] }],
    ['is malformed', { decision: 'accept' }], ['is not an object', 'accept'], ['has an extra key', { ...accept(3), release: true }],
  ])('a verifier reply that %s holds the run', async (_name, reply) => {
    const s = explainScenario({ replies: { verify: reply } }); const o = await go(s);
    expect(o).toMatchObject({ released: false, reasonCode: 'VERIFIER_HOLD', engineText: avoidText });
  });
});

describe('only a shown result with a strength other than "No recommendation" reaches the model (FR-002)', () => {
  test.each([...REASON_CODES])('engine reason %s returns the fixed text and makes no model call', async code => {
    const s = explainScenario(); s.request.engine = { outcome: REASON_OUTCOME[code], reasonCode: code, strength: null, explainable: null };
    const o = await go(s);
    expect(o).toMatchObject({ released: false, reasonCode: 'NOT_ELIGIBLE', engineText: FALLBACK_TEXT[code], detail: code });
    expect(s.calls.model).toBe(0);
  });
  test('"No recommendation" returns its fixed text with no model call; control: a shown Strong result does call the model', async () => {
    const none = explainScenario(); none.request.engine = { outcome: 'shown', reasonCode: null, strength: 'No recommendation', explainable: null };
    expect(await go(none)).toMatchObject({ released: false, detail: 'no-recommendation-strength' }); expect(none.calls.model).toBe(0);
    const shown = explainScenario(); await go(shown); expect(shown.calls.model).toBeGreaterThan(0);
  });
});

describe('every failure shows the engine text alone, with no model-written word (T014, SC-004)', () => {
  const marked = { statements: [{ kind: 'gloss', fields: ['implication'], text: 'MODELWORD refer the patient.' }] };
  const SCENARIOS: Record<FailureReason, () => Promise<{ o: ExplainOutcome; text: string }>> = {
    INVALID_INPUT: async () => ({ o: await runExplanation({ nonsense: 1 }, explainScenario().context, explainScenario().ports), text: FALLBACK_TEXT['unknown-outcome'] }),
    TASK_UNDECLARED: async () => { const s = explainScenario(); return { o: await go(s, { [EXPLAIN_TASK]: { ...TASKS[EXPLAIN_TASK], dataClass: undefined } as never }), text: avoidText }; },
    NOT_SYNTHETIC: async () => { const s = explainScenario({ baaCovered: true, syntheticOnly: true }); s.request.dataMarker = 'real'; return { o: await go(s), text: avoidText }; },
    NO_BAA: async () => { const s = explainScenario({ baaCovered: false, syntheticOnly: false }); s.request.dataMarker = 'real'; return { o: await go(s), text: avoidText }; },
    AUTHORITY_HELD: async () => { const s = explainScenario(); s.revoke(); return { o: await go(s), text: avoidText }; },
    IDEMPOTENCY_CONFLICT: async () => { const s = explainScenario(); await go(s); s.request.engine = { ...s.request.engine, strength: 'Moderate', explainable: RESULTS.dose }; return { o: await go(s), text: engineTextOf(RESULTS.dose) }; },
    IN_PROGRESS: async () => { const s = explainScenario(); let inner: Promise<ExplainOutcome> | null = null; s.hooks.draft = () => { s.hooks.draft = () => {}; inner = go(s); }; await go(s); return { o: await inner!, text: avoidText }; },
    IDEMPOTENT_REPLAY: async () => { const s = explainScenario(); await go(s); return { o: await go(s), text: avoidText }; },
    BUDGET_HELD: async () => { const s = explainScenario(); s.budgets.inner.reserve(runVector('other', 'tenant-a'), syntheticProfile()); return { o: await go(s), text: avoidText }; },
    NOT_ELIGIBLE: async () => { const s = explainScenario(); s.request.engine = { outcome: 'held', reasonCode: 'cell-disputed', strength: null, explainable: null }; return { o: await go(s), text: FALLBACK_TEXT['cell-disputed'] }; },
    INPUT_REFUSED: async () => { const s = explainScenario(); s.request.engine = { ...s.request.engine, explainable: ATTACKS.find(a => a.id === 'a08-phenotype-sentence')!.input }; return { o: await go(s), text: FALLBACK_TEXT['unknown-outcome'] }; },
    USAGE_HELD: async () => { const s = explainScenario({ model: { complete: async () => ({ artifact: marked, observation: null }) } }); return { o: await go(s), text: avoidText }; },
    MODEL_ERROR: async () => { const s = explainScenario({ model: { complete: async () => { throw new Error('MODELWORD upstream said no'); } } }); return { o: await go(s), text: avoidText }; },
    MODEL_REFUSED: async () => ({ o: await go(explainScenario({ replies: { draft: { refused: true } } })), text: avoidText }),
    INVALID_STRUCTURE: async () => ({ o: await go(explainScenario({ replies: { draft: { statements: [] }, repair: { statements: [] } } })), text: avoidText }),
    SENSOR_HOLD: async () => ({ o: await go(explainScenario({ replies: { draft: marked, repair: marked } })), text: avoidText }),
    VERIFIER_HOLD: async () => ({ o: await go(explainScenario({ replies: { verify: { decision: 'hold', statements: [] } } })), text: avoidText }),
    DEADLINE: async () => { const s = explainScenario(); s.hooks['draft-complete'] = () => s.tick(121000); return { o: await go(s), text: avoidText }; },
    CONTROL_HELD: async () => { const s = explainScenario(); s.hooks.draft = () => { s.store.cancel('tenant-a-x1'); }; return { o: await go(s), text: avoidText }; },
  };
  test('the table covers exactly the failure reasons', () => expect(Object.keys(SCENARIOS).sort()).toEqual([...FAILURE_REASONS].sort()));
  test.each([...FAILURE_REASONS])('%s', async reason => {
    const { o, text } = await SCENARIOS[reason]();
    expect(o.released).toBe(false);
    expect(o.reasonCode).toBe(reason);
    expect(o.engineText).toBe(text);
    expect('explanation' in o).toBe(false);
    expect(JSON.stringify(o)).not.toMatch(/MODELWORD|refer the patient|upstream/i);
  });
  test('control: the same run with no fault releases (so the table above is not vacuous)', async () => expect((await go(explainScenario())).released).toBe(true));
});

describe('loop control, authority and caps carry over from the kernel (FR-007)', () => {
  test('the limits equal the synthetic profile budget', () => {
    const b = syntheticProfile().budget;
    expect(EXPLAIN_LIMITS).toMatchObject({ slots: b.slots, deadlineMs: b.elapsedMs, tokens: b.tokens });
  });
  test('authority is re-checked at each boundary: revoked before the verifier, nothing is released', async () => {
    const s = explainScenario(); s.hooks.verify = () => s.revoke(); const o = await go(s);
    expect(o).toMatchObject({ released: false, reasonCode: 'AUTHORITY_HELD' });
    expect(s.trace).toEqual(expect.arrayContaining(['admission', 'draft', 'draft-complete', 'verify']));
  });
  test('authority lost between the verifier and the release is still held', async () => {
    const s = explainScenario(); s.hooks.release = () => s.revoke();
    expect(await go(s)).toMatchObject({ released: false, reasonCode: 'AUTHORITY_HELD' });
  });
  test('an expired run ends in the expired state', async () => {
    const s = explainScenario(); s.hooks['draft-complete'] = () => s.tick(121000); const o = await go(s);
    expect(s.store.get(o.runId!).state).toBe('expired');
  });
  test('a replay of a finished run makes no model call and stores nothing new', async () => {
    const s = explainScenario(); await go(s); const calls = s.calls.model; const o = await go(s);
    expect(o).toMatchObject({ reasonCode: 'IDEMPOTENT_REPLAY', engineText: avoidText });
    expect(s.calls.model).toBe(calls);
  });
  test('an over-large usage report is a cap hold', async () => {
    const s = explainScenario({ model: { complete: async () => ({ artifact: GOOD, observation: { inputUnits: 999999, generatedUnits: 1 } }) } });
    expect(await go(s)).toMatchObject({ released: false, reasonCode: 'USAGE_HELD' });
  });
  test('the slot cap is four: both drafts and both checks never exceed it', async () => {
    const s = explainScenario({ replies: { draft: BAD_GLOSS } }); const o = await go(s);
    expect(s.budgets.counters(o.runId!).slots).toBeLessThanOrEqual(EXPLAIN_LIMITS.slots);
  });
});

describe('R1 at run time (FR-011): a phi task refuses rather than falls back', () => {
  test('real data with no business associate agreement is refused before any model call', async () => {
    const s = explainScenario({ baaCovered: false, syntheticOnly: false }); s.request.dataMarker = 'real';
    expect(await go(s)).toMatchObject({ released: false, reasonCode: 'NO_BAA' }); expect(s.calls.model).toBe(0);
  });
  test('real data while the system is synthetic-only is refused even with an agreement', async () => {
    const s = explainScenario({ baaCovered: true, syntheticOnly: true }); s.request.dataMarker = 'real';
    expect(await go(s)).toMatchObject({ reasonCode: 'NOT_SYNTHETIC' }); expect(s.calls.model).toBe(0);
  });
  test('control: synthetic data proceeds with no agreement; real data proceeds only with both conditions met', async () => {
    expect((await go(explainScenario())).released).toBe(true);
    const ok = explainScenario({ baaCovered: true, syntheticOnly: false }); ok.request.dataMarker = 'real';
    expect((await go(ok)).released).toBe(true);
  });
  test('a task with no declaration, or a free-text task with no listed checks, does not run', async () => {
    for (const broken of [{ ...TASKS[EXPLAIN_TASK], dataClass: undefined }, { ...TASKS[EXPLAIN_TASK], checks: [] }, {}]) {
      const s = explainScenario(); const o = await go(s, { [EXPLAIN_TASK]: broken as never });
      expect(o).toMatchObject({ released: false, reasonCode: 'TASK_UNDECLARED' }); expect(s.calls.model).toBe(0);
    }
  });
});
