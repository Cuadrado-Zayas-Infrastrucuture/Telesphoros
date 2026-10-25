import { z } from 'zod';
import { EXPLAIN_TASK, FAILURE_REASONS } from './explain-contracts';
import { KEYED_DIGEST } from './keyed-digest';

export const OUTCOME_V2 = 'agentic.explain-outcome.v2' as const;
const plainDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const keyedDigestSchema = z.string().regex(KEYED_DIGEST);
const code = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,63}$/);
const ref = z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/);
/** An exact model version: a dated, versioned id, never an alias or `latest` (FR-010). `scripted-vN` is the offline stand-in. */
export const PINNED_MODEL_ID = /^(scripted-v\d+|[a-z0-9.-]+\.[a-z0-9-]+-\d{8}-v\d+:\d+)$/;

export const modelIdentitySchema = z.strictObject({
  modelId: z.string().regex(PINNED_MODEL_ID),
  invocationPath: z.enum(['on-demand', 'inference-profile', 'scripted']),
  sdkVersion: z.string().regex(/^(none|\d+\.\d+\.\d+)$/),
});
export type ModelIdentity = z.infer<typeof modelIdentitySchema>;

/**
 * The durable record of one run (FR-009, FR-014): digests, fixed codes and real counters, and no text of any kind. Every string is a digest, a code,
 * an id or an enum, so there is nowhere for a result, a phenotype or a model word to go (R5). The evidence and output digests are keyed.
 */
export const outcomeV2Schema = z
  .strictObject({
    schemaVersion: z.literal(OUTCOME_V2),
    evidenceKind: z.literal('harness-run'),
    runId: ref,
    tenantId: ref,
    requesterRef: ref,
    task: z.literal(EXPLAIN_TASK),
    terminalState: z.enum(['released', 'held', 'expired']),
    reasonCode: z.enum([...FAILURE_REASONS, 'RELEASED']),
    detailCodes: z.array(code).max(16),
    harnessVersion: plainDigest,
    model: modelIdentitySchema.nullable(),
    digests: z.strictObject({ template: plainDigest.nullable(), evidence: keyedDigestSchema, output: keyedDigestSchema.nullable() }),
    guardsRun: z.array(z.enum(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'VERIFIER'])).max(7),
    counters: z.strictObject({
      slots: z.number().int().min(0).max(4),
      modelCalls: z.number().int().min(0).max(4),
      inputUnits: z.number().int().nonnegative().safe(),
      generatedUnits: z.number().int().nonnegative().safe(),
      usageState: z.enum(['known', 'unknown']),
    }),
  })
  .refine((o) => (o.terminalState === 'released') === (o.reasonCode === 'RELEASED'), { message: 'a release has the RELEASED reason and nothing else does' })
  .refine((o) => o.terminalState !== 'released' || (o.digests.output !== null && o.counters.usageState === 'known' && o.model !== null), {
    message: 'a release has an output digest, a pinned model and known usage',
  })
  .refine((o) => o.counters.modelCalls > 0 === (o.model !== null), { message: 'a model identity is recorded exactly when a model was called' });
export type OutcomeV2 = z.infer<typeof outcomeV2Schema>;
