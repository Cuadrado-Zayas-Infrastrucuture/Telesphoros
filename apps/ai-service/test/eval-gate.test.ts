import { describe, expect, test } from 'vitest';
import { ATTACKS } from '../evals/attacks/attacks';
import { CASES } from '../evals/golden/cases';
import { RESULTS } from '../evals/golden/results';
import { currentDigests, runGate, type Compose } from '../evals/run';
import { ALL_SENSORS } from '../src/evaluators/sensors';
import { SENSORS, type Sensor, type SensorId } from '../src/evaluators/types';
import { buildPrompt } from '../src/prompts/explain-v1';

const without = (id: SensorId): Record<SensorId, Sensor> => ({ ...ALL_SENSORS, [id]: () => [] });

describe('the evaluation gate (R3, FR-013)', () => {
  test('is green on the real harness, and says how much it measured', async () => {
    const report = await runGate();
    // Counts only, never case text (FR-009).
    console.log(`eval gate: harness ${report.harnessVersion.slice(0, 19)} cases ${JSON.stringify(report.cases)} attacks ${JSON.stringify(report.attacks)}`);
    expect(report.ok).toBe(true);
    expect(report.cases).toMatchObject({ wronglyReleased: 0, reasonMismatch: 0, wronglyHeld: 0 });
    expect(report.attacks.effective).toBe(0);
  });
  test('first-cut sizes (initial; the founder sets the real targets in D8)', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    expect(ATTACKS.length).toBeGreaterThanOrEqual(12);
    for (const k of ['invented-drug', 'changed-strength', 'flipped-direction', 'added-number', 'dropped-caveat', 'wrong-gene', 'advice-beyond-guideline'])
      expect(
        CASES.some((c) => c.kind === k),
        k,
      ).toBe(true);
    for (const k of ['inbound', 'shape', 'output'])
      expect(
        ATTACKS.some((a) => a.cls === k),
        k,
      ).toBe(true);
    expect(new Set([...CASES.map((c) => c.id), ...ATTACKS.map((a) => a.id)]).size).toBe(CASES.length + ATTACKS.length);
  });
  test.each([...SENSORS])('broken copy: with %s removed the gate is red', async (id) => {
    const report = await runGate({ sensors: without(id) });
    expect(report.ok).toBe(false);
    expect(report.cases.wronglyReleased + report.cases.reasonMismatch).toBeGreaterThan(0);
  });
  test('a gate that is missing a sensor is red even if every case still passes', async () => {
    const rest = Object.fromEntries(Object.entries(ALL_SENSORS).filter(([id]) => id !== 'S6'));
    const report = await runGate({ sensors: rest as unknown as Record<SensorId, Sensor>, cases: CASES.filter((c) => c.expect === 'release') });
    expect(report.sensorsComplete).toBe(false);
    expect(report.ok).toBe(false);
  });
  test('broken copy: a builder that leaks inbound fields into the prompt makes an attack effective', async () => {
    const leaky: Compose = (result, inbound) => {
      const b = buildPrompt(result);
      return { prompt: b.prompt + JSON.stringify(inbound), templateDigest: b.templateDigest };
    };
    const report = await runGate({ compose: leaky });
    expect(report.ok).toBe(false);
    expect(report.attacks.effective).toBe(ATTACKS.filter((a) => a.cls === 'inbound').length);
  });
  test('broken copy: a builder that accepts hostile shapes makes shape attacks effective', async () => {
    const lax: Compose = (result) => {
      try {
        return buildPrompt(result);
      } catch {
        return { prompt: 'p', templateDigest: 'd' };
      }
    };
    const report = await runGate({ compose: lax });
    expect(report.ok).toBe(false);
    expect(report.attacks.effective).toBeGreaterThanOrEqual(ATTACKS.filter((a) => a.cls === 'shape').length);
  });
  test('changing a template, lexicon or glossary without updating the pinned digest turns the gate red', async () => {
    const d = currentDigests();
    for (const k of ['template', 'lexicon', 'glossary'] as const) {
      const report = await runGate({ pinned: { ...d, [k]: 'sha256:' + '0'.repeat(64) } });
      expect(report.digestsMatch, k).toBe(false);
      expect(report.ok, k).toBe(false);
    }
  });
  test('a case that expects a hold for the wrong reason is a mismatch, not a pass', async () => {
    const report = await runGate({ cases: [{ ...CASES.find((c) => c.id === 'w09-added-number')!, sensors: ['S1'] }] });
    expect(report.cases.reasonMismatch).toBe(1);
    expect(report.ok).toBe(false);
  });
  test('control: an empty gate is red, not green', async () => expect((await runGate({ cases: [], attacks: [] })).ok).toBe(false));
  test('every golden result is a valid explainable result', () => {
    expect(Object.keys(RESULTS).length).toBeGreaterThan(0);
    for (const g of CASES) expect(RESULTS[g.result]).toBeDefined();
  });
});
