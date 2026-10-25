import { describe, expect, test } from 'vitest';
import { outcomeV2Schema, PINNED_MODEL_ID, type OutcomeV2 } from '../src/outcome-v2';
import { keyedDigest } from '../src/keyed-digest';

const key = new Uint8Array(32).fill(3);
const released: OutcomeV2 = {
  schemaVersion: 'agentic.explain-outcome.v2',
  evidenceKind: 'harness-run',
  runId: 'tenant-a-x1',
  tenantId: 'tenant-a',
  requesterRef: 'staff-a',
  task: 'pgx.explain.v1',
  terminalState: 'released',
  reasonCode: 'RELEASED',
  detailCodes: [],
  harnessVersion: 'sha256:' + 'a'.repeat(64),
  model: { modelId: 'scripted-v1', invocationPath: 'scripted', sdkVersion: 'none' },
  digests: { template: 'sha256:' + 'c'.repeat(64), evidence: keyedDigest(key, 'e'), output: keyedDigest(key, 'o') },
  guardsRun: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'VERIFIER'],
  counters: { slots: 2, modelCalls: 2, inputUnits: 1200, generatedUnits: 128, usageState: 'known' },
};
const held: OutcomeV2 = {
  ...released,
  terminalState: 'held',
  reasonCode: 'SENSOR_HOLD',
  detailCodes: ['S3_TERM_NOT_ALLOWED'],
  digests: { ...released.digests, output: null },
  guardsRun: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
};
const noCall: OutcomeV2 = {
  ...held,
  reasonCode: 'NOT_ELIGIBLE',
  detailCodes: ['cell-disputed'],
  model: null,
  digests: { template: null, evidence: released.digests.evidence, output: null },
  guardsRun: [],
  counters: { slots: 0, modelCalls: 0, inputUnits: 0, generatedUnits: 0, usageState: 'known' },
};

describe('outcome v2 (FR-009, FR-014)', () => {
  test.each([
    ['a release', released],
    ['a sensor hold', held],
    ['a run that never reached a model', noCall],
  ])('accepts %s', (_name, value) => expect(outcomeV2Schema.safeParse(value).success).toBe(true));

  test.each([
    ['an extra key holding explanation text', { ...released, explanation: 'Reduced enzyme function increases exposure.' }],
    ['an extra key holding a note', { ...held, note: 'free text' }],
    ['a release with no output digest', { ...released, digests: { ...released.digests, output: null } }],
    ['a release with unknown usage', { ...released, counters: { ...released.counters, usageState: 'unknown' } }],
    ['a release with no model', { ...released, model: null, counters: { ...released.counters, modelCalls: 0 } }],
    ['the RELEASED reason on a held run', { ...held, reasonCode: 'RELEASED' }],
    ['a held reason on a released run', { ...released, reasonCode: 'SENSOR_HOLD' }],
    ['a model recorded for a run that made no call', { ...noCall, model: released.model }],
    ['a call made with no model recorded', { ...held, model: null }],
    ['an evidence digest that is a plain sha256', { ...released, digests: { ...released.digests, evidence: 'sha256:' + 'd'.repeat(64) } }],
    ['an output digest that is a plain sha256', { ...released, digests: { ...released.digests, output: 'sha256:' + 'd'.repeat(64) } }],
    ['a model alias', { ...released, model: { ...released.model!, modelId: 'latest' } }],
    ['an undated model id', { ...released, model: { ...released.model!, modelId: 'anthropic.claude-sonnet' } }],
    ['a free-text detail', { ...held, detailCodes: ['the phenotype was Synthetic Poor'] }],
    ['a sentence as the tenant id', { ...released, tenantId: 'a person with a long name' }],
    ['a fifth slot', { ...released, counters: { ...released.counters, slots: 5 } }],
    ['a negative unit count', { ...released, counters: { ...released.counters, inputUnits: -1 } }],
    ['a wrong schema version', { ...released, schemaVersion: 'synthetic.business-outcome.v1' }],
  ])('refuses %s', (_name, value) => expect(outcomeV2Schema.safeParse(value).success).toBe(false));

  test('pinned model ids: dated and versioned only', () => {
    for (const ok of ['scripted-v1', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-haiku-4-5-20251001-v1:0']) expect(PINNED_MODEL_ID.test(ok), ok).toBe(true);
    for (const bad of ['latest', 'claude-sonnet-latest', 'anthropic.claude-sonnet-4-5', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0 ', '', 'scripted'])
      expect(PINNED_MODEL_ID.test(bad), bad).toBe(false);
  });

  test('R5: every string a valid row can hold is a digest, a code, an id or an enum, so the schema has no place for text', () => {
    const shapes = [
      /^sha256:[0-9a-f]{64}$/,
      /^hmac-sha256:[0-9a-f]{64}$/,
      /^[A-Za-z][A-Za-z0-9_-]{1,63}$/,
      /^[A-Za-z0-9._:@-]{1,128}$/,
      /^(none|\d+\.\d+\.\d+)$/,
      /^[a-z0-9.-]+\.[a-z0-9-]+-\d{8}-v\d+:\d+$/,
      /^scripted-v\d+$/,
    ];
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
    for (const row of [released, held, noCall])
      for (const s of strings(row))
        expect(
          shapes.some((r) => r.test(s)),
          s,
        ).toBe(true);
    // Control: a sentence matches none of them, so the walk above would catch text.
    expect(shapes.some((r) => r.test('Reduced enzyme function increases exposure to drugv.'))).toBe(false);
  });
});
