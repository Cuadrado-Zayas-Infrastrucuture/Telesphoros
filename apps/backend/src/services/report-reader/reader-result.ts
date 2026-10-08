import { z } from 'zod';

/**
 * What the Stage A reader returns (the imported hand-off engine, version stage-a/2), validated strictly so a change in
 * its output shape is a loud failure and never a silent misread. The reader finds spans of text; it never decides what a
 * value means (that is the adapter's job, docs/design/report-adapter-spec.md).
 *
 * Fields the adapter does not need are kept loose (`looseObject`); the ones it relies on are exact.
 */

const nonNegativeInt = z.number().int().min(0);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const SPAN_ROLES = ['gene', 'diplotype', 'reportedResult'] as const;

export const readerSpanSchema = z.strictObject({
  gene: z.string().min(1),
  occurrenceIndex: nonNegativeInt,
  role: z.enum(SPAN_ROLES),
  start: nonNegativeInt,
  end: nonNegativeInt,
  text: z.string(),
});
export type ReaderSpan = z.infer<typeof readerSpanSchema>;

/** `projected`: genes tied to values. `source-abstained`: values with no key tying them to genes. `held`: not understood. */
export const projectionSchema = z.strictObject({
  status: z.enum(['projected', 'held', 'source-abstained']),
  reason: z.string().nullable(),
  payload: z.strictObject({ spans: z.array(readerSpanSchema), abstain: z.boolean() }).nullable(),
  provenance: z.looseObject({ packetHash: hex64.nullable().optional() }),
});
export type ReaderProjection = z.infer<typeof projectionSchema>;

export const PROCESSING_FAILURE_REASONS = ['source-limit', 'candidate-or-frame-limit', 'source-time-budget', 'worker-error'] as const;
export type ProcessingFailureReason = (typeof PROCESSING_FAILURE_REASONS)[number];

/** The engine's own envelope for "could not process" (and the shape this wrapper uses when its subprocess fails). */
export const processingFailureSchema = z.strictObject({
  schema: z.literal('pgx-span-processing-failure/1'),
  status: z.literal('held'),
  reason: z.enum(PROCESSING_FAILURE_REASONS),
  payload: z.null(),
});
export type ProcessingFailure = z.infer<typeof processingFailureSchema>;

const candidateSchema = z.strictObject({
  contentId: hex64,
  candidateId: hex64,
  kind: z.enum(SPAN_ROLES),
  start: nonNegativeInt,
  end: nonNegativeInt,
  text: z.string(),
});

const frameSchema = z.strictObject({
  frameId: hex64,
  geneCandidateId: hex64,
  sourceAnchor: nonNegativeInt,
  ruleId: z.string(),
  allowed: z.strictObject({ diplotype: z.array(hex64), reportedResult: z.array(hex64) }),
});

const edgeSchema = z.strictObject({
  frameId: hex64,
  valueCandidateId: hex64,
  role: z.enum(['diplotype', 'reportedResult']),
  evidence: z.strictObject({ start: nonNegativeInt, end: nonNegativeInt, ruleId: z.string() }),
});

/** Build bindings: which exact reader produced a packet. Compared with PINNED_READER by the adapter. */
export const readerBindingsSchema = z.strictObject({
  generatorVersion: z.string(),
  generatorCodeHash: hex64,
  grammarHash: hex64,
  offsetContractHash: hex64,
  fieldBoundaryPolicyHash: hex64,
});
export type ReaderBindings = z.infer<typeof readerBindingsSchema>;

export const packetSchema = z.looseObject({
  schema: z.literal('pgx-span-candidates/3-draft'),
  status: z.enum(['ready', 'held']),
  reason: z.string().nullable(),
  frameSetState: z.enum(['unclassified', 'resolved', 'ambiguous', 'mixed']),
  packetHash: hex64,
  sourceRef: z.looseObject({ sourceHash: hex64, decodedLength: nonNegativeInt }),
  ...readerBindingsSchema.shape,
  candidates: z.array(candidateSchema),
  frames: z.array(frameSchema),
  allowedEdges: z.array(edgeSchema),
  /** Includes `present-empty-field` (a label present with no value), which only the packet carries. */
  diagnostics: z.array(z.looseObject({ kind: z.string() })),
  ambiguityEvidence: z.array(z.looseObject({})),
});
export type ReaderPacket = z.infer<typeof packetSchema>;

export const readerResultSchema = z.strictObject({
  packet: z.union([packetSchema, processingFailureSchema]),
  projection: projectionSchema,
});
export type ReaderResult = z.infer<typeof readerResultSchema>;

/** The result this wrapper returns when it could not get a valid answer from the subprocess. Fixed shape, no text. */
export function failureResult(reason: ProcessingFailureReason): ReaderResult {
  return {
    packet: { schema: 'pgx-span-processing-failure/1', status: 'held', reason, payload: null },
    projection: { status: 'held', reason, payload: null, provenance: { packetHash: null } },
  };
}
