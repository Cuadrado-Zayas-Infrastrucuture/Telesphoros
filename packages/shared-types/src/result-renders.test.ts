import { describe, expect, it } from 'vitest';
import { RENDER_BATCH_MAX, resultRenderBatchResultSchema, resultRenderBatchSchema, resultRenderEventSchema } from './index';

// Spec 019 D02b: the render batch (T103). Each malformed or extra field is refused on its own, against a valid control. Synthetic ids only.
const exposure = {
  episodeId: '7c7f6b0d-d038-4ef5-8a8b-8d9e0f1a2b3c',
  seq: 0,
  kind: 'exposure',
  resultId: '1c1f0b4d-7a72-4e9f-8a2b-2d3e4f5a6b7c',
  measurement: 'viewport',
  ruleVersion: 'render-v1',
  schemaVersion: 1,
  capability: ['intersection-observer', 'page-visibility', 'focus-events'],
  occurredAt: '2026-10-29T15:04:05.000Z',
  continuousMs: 1000,
  cumulativeMs: 1000,
};
const duration = { ...exposure, seq: 1, kind: 'duration', occurredAt: '2026-10-29T15:04:09.000Z', continuousMs: 5000, cumulativeMs: 5400 };
const SENT = '2026-10-29T15:04:10.000Z';

describe('resultRenderEventSchema', () => {
  it('accepts an exposure, a duration and a focus exposure (controls)', () => {
    expect(resultRenderEventSchema.parse(exposure)).toEqual(exposure);
    expect(resultRenderEventSchema.parse(duration)).toEqual(duration);
    expect(resultRenderEventSchema.safeParse({ ...exposure, measurement: 'focus', capability: ['page-visibility', 'focus-events'] }).success).toBe(true);
  });

  it.each([
    ['episodeId', { episodeId: 'e1' }],
    ['seq negative', { seq: -1 }],
    ['seq fractional', { seq: 0.5 }],
    ['seq too large', { seq: 100_001 }],
    ['kind', { kind: 'view' }],
    ['seq 0 that is not the exposure', { kind: 'duration' }],
    ['an exposure at seq 1', { seq: 1 }],
    ['resultId', { resultId: 'r1' }],
    ['measurement', { measurement: 'scroll' }],
    ['ruleVersion', { ruleVersion: 'render-v2' }],
    ['schemaVersion', { schemaVersion: 2 }],
    ['capability empty', { capability: [] }],
    ['capability unknown', { capability: ['page-visibility', 'mouse'] }],
    ['capability repeated', { capability: ['page-visibility', 'page-visibility', 'intersection-observer'] }],
    ['viewport without intersection-observer', { capability: ['page-visibility', 'focus-events'] }],
    ['focus without focus-events', { measurement: 'focus', capability: ['page-visibility', 'intersection-observer'] }],
    ['no page-visibility', { capability: ['intersection-observer', 'focus-events'] }],
    ['occurredAt', { occurredAt: 'yesterday' }],
    ['continuousMs under the threshold', { continuousMs: 999, cumulativeMs: 999 }],
    ['continuousMs over a day', { continuousMs: 86_400_001, cumulativeMs: 86_400_001 }],
    ['cumulativeMs under continuousMs', { continuousMs: 2000, cumulativeMs: 1500 }],
    ['a content field: a drug name', { drug: 'syn-drug' }],
    ['a content field: a recommendation', { recommendation: 'x' }],
    ['a patient label', { patientLabel: 'x' }],
    ['a patient id (derived by the server, never sent)', { patientId: '2d2a1c5e-8b83-4fa0-9b3c-3e4f5a6b7c8d' }],
  ])('refuses %s', (_label, change) => {
    expect(resultRenderEventSchema.safeParse({ ...exposure, ...change }).success).toBe(false);
  });

  it('refuses each missing field', () => {
    for (const key of Object.keys(exposure)) {
      const { [key as keyof typeof exposure]: _omit, ...rest } = exposure; // eslint-disable-line @typescript-eslint/no-unused-vars
      expect([key, resultRenderEventSchema.safeParse(rest).success]).toEqual([key, false]);
    }
  });
});

describe('resultRenderBatchSchema', () => {
  it('accepts an exposure and its duration in one batch (control)', () => {
    expect(resultRenderBatchSchema.parse({ sentAt: SENT, events: [exposure, duration] }).events).toHaveLength(2);
  });

  it(`accepts ${RENDER_BATCH_MAX} events and refuses ${RENDER_BATCH_MAX + 1}, or none`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? exposure : { ...duration, seq: i }));
    expect(resultRenderBatchSchema.safeParse({ sentAt: SENT, events: many(RENDER_BATCH_MAX) }).success).toBe(true);
    expect(resultRenderBatchSchema.safeParse({ sentAt: SENT, events: many(RENDER_BATCH_MAX + 1) }).success).toBe(false);
    expect(resultRenderBatchSchema.safeParse({ sentAt: SENT, events: [] }).success).toBe(false);
  });

  it.each([
    ['an extra field', { sentAt: SENT, events: [exposure], note: 'x' }],
    ['no sentAt', { events: [exposure] }],
    ['a malformed sentAt', { sentAt: 'now', events: [exposure] }],
    ['an event sent before it occurred', { sentAt: '2026-10-29T15:04:04.000Z', events: [exposure] }],
    ['the same episode and seq twice', { sentAt: SENT, events: [exposure, { ...exposure }] }],
    ['the same episode and seq twice, in other letter case', { sentAt: SENT, events: [exposure, { ...exposure, episodeId: exposure.episodeId.toUpperCase() }] }],
  ])('refuses %s', (_label, body) => {
    expect(resultRenderBatchSchema.safeParse(body).success).toBe(false);
  });
});

describe('resultRenderBatchResultSchema', () => {
  it('is three counts and nothing else', () => {
    expect(resultRenderBatchResultSchema.safeParse({ stored: 1, alreadyStored: 0, withoutExposure: 0 }).success).toBe(true);
    expect(resultRenderBatchResultSchema.safeParse({ stored: 1, alreadyStored: 0 }).success).toBe(false);
    expect(resultRenderBatchResultSchema.safeParse({ stored: 1, alreadyStored: 0, withoutExposure: 0, read: true }).success).toBe(false);
  });
});
