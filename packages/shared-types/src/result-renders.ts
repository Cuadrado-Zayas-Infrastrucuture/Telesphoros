import { z } from 'zod';

/**
 * Render capture (specs/019-presentation-events, slice D02b).
 *
 * The browser reports that a result row's recommendation-summary region was displayed under the rule `render-v1` (plan P2): at least half of it in
 * the viewport (`viewport`), or keyboard or assistive-technology focus inside it (`focus`), in a visible tab, for one continuous second. An episode's
 * first event (seq 0) is its `exposure`; later ones are `duration` events (R1). Evidence of display, never of reading or understanding; a missing
 * event means unknown. Events carry ids and times only (FR-07): the schemas are strict, so no other field is accepted.
 */

export const RENDER_RULE_VERSION = 'render-v1' as const;
export const RENDER_SCHEMA_VERSION = 1 as const;
/** render-v1: one continuous second. The pilot compares 1, 2 and 3 seconds on the same rows; the rule records, it never forces a countdown. */
export const RENDER_THRESHOLD_MS = 1000;
/** render-v1: at least half of the region in the viewport (the `viewport` path). */
export const RENDER_VIEWPORT_RATIO = 0.5;
export const RENDER_KINDS = ['exposure', 'duration'] as const;
export type RenderKind = (typeof RENDER_KINDS)[number];
/** R2: the two measurement paths. */
export const RENDER_MEASUREMENTS = ['viewport', 'focus'] as const;
export type RenderMeasurement = (typeof RENDER_MEASUREMENTS)[number];
/** What the browser supported when it measured. `page-visibility` is always needed; each path needs its own API too. */
export const RENDER_CAPABILITIES = ['intersection-observer', 'page-visibility', 'focus-events'] as const;
export type RenderCapability = (typeof RENDER_CAPABILITIES)[number];
/** P4: the most events one batch may carry. */
export const RENDER_BATCH_MAX = 50;
/** The longest time one row may report (a day): anything longer is a broken client clock, not a display. */
export const RENDER_MAX_MS = 86_400_000;
export const RENDER_MAX_SEQ = 100_000;

/** The `reason` of each refusal a client must tell apart (in `error.details[0].reason`). Nothing in the batch was stored. */
export const RENDER_REFUSAL_REASONS = {
  /**
   * A duration event whose episode has no stored exposure, for the same result and path. The API skips such durations and counts them
   * (`withoutExposure`); this refusal is the trigger's guarantee, raised only if one reaches the table.
   */
  exposureMissing: 'render-exposure-missing',
} as const;

const NEEDS: Record<RenderMeasurement, RenderCapability> = { viewport: 'intersection-observer', focus: 'focus-events' };

export const resultRenderEventSchema = z
  .strictObject({
    /** The client's id for the episode; with `seq`, the event's identity (stored once, however often it is sent). */
    episodeId: z.uuid(),
    seq: z.int().min(0).max(RENDER_MAX_SEQ),
    kind: z.enum(RENDER_KINDS),
    resultId: z.uuid(),
    measurement: z.enum(RENDER_MEASUREMENTS),
    ruleVersion: z.literal(RENDER_RULE_VERSION),
    schemaVersion: z.literal(RENDER_SCHEMA_VERSION),
    capability: z
      .array(z.enum(RENDER_CAPABILITIES))
      .min(1)
      .max(RENDER_CAPABILITIES.length)
      .refine((c) => new Set(c).size === c.length, { message: 'A capability may appear once.' }),
    /** The client's clock: when the threshold was met (exposure) or the time was measured (duration). */
    occurredAt: z.iso.datetime(),
    /** This episode's uninterrupted visible time; never under the threshold, since the episode exists only once it was met. */
    continuousMs: z.int().min(RENDER_THRESHOLD_MS).max(RENDER_MAX_MS),
    /** All visible time of this result, path and page view, this episode's included. */
    cumulativeMs: z.int().min(RENDER_THRESHOLD_MS).max(RENDER_MAX_MS),
  })
  .refine((e) => (e.kind === 'exposure') === (e.seq === 0), { message: 'Seq 0 is the exposure, and only it.', path: ['seq'] })
  .refine((e) => e.cumulativeMs >= e.continuousMs, { message: 'Cumulative time includes the episode.', path: ['cumulativeMs'] })
  .refine((e) => e.capability.includes('page-visibility') && e.capability.includes(NEEDS[e.measurement]), {
    message: 'The path was measured without the API it needs.',
    path: ['capability'],
  });
export type ResultRenderEvent = z.infer<typeof resultRenderEventSchema>;

/** `POST /result-renders`. All or nothing: a batch naming a result outside the caller's organization stores none of its events. */
export const resultRenderBatchSchema = z
  .strictObject({
    /** The client's clock when it sent this batch. The server's receipt minus this is the stored clock uncertainty. */
    sentAt: z.iso.datetime(),
    events: z.array(resultRenderEventSchema).min(1).max(RENDER_BATCH_MAX),
  })
  .refine((b) => new Set(b.events.map((e) => `${e.episodeId.toLowerCase()}:${e.seq}`)).size === b.events.length, {
    message: 'An event appears once in a batch.',
    path: ['events'],
  })
  .refine((b) => b.events.every((e) => Date.parse(e.occurredAt) <= Date.parse(b.sentAt)), {
    message: 'An event is sent after it occurred.',
    path: ['events'],
  });
export type ResultRenderBatch = z.infer<typeof resultRenderBatchSchema>;

/**
 * The answer: how many events this batch stored, how many were stored before (a retried batch stores nothing twice), and how many durations were
 * skipped because their episode's exposure is not stored (it was lost on the way). Skipping them, rather than refusing the batch, keeps one lost
 * exposure from taking other results' events down with it in every later batch of the shared queue.
 */
export const resultRenderBatchResultSchema = z.strictObject({
  stored: z.int().min(0),
  alreadyStored: z.int().min(0),
  withoutExposure: z.int().min(0),
});
export type ResultRenderBatchResult = z.infer<typeof resultRenderBatchResultSchema>;
