import { z } from 'zod';

export const GENES = ['CYP2C19', 'CYP2B6'] as const;
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const index = z.number().int().min(0).max(100000);
const gene = z.enum(GENES);
const label = z.string().min(1).max(100);
export const REASONS = [
  'lookup-input-invalid', 'capture-not-accepted', 'capture-hash-mismatch', 'poppler-version-mismatch',
  'reader-binding-mismatch', 'packet-invalid', 'evidence-overlap', 'reader-held', 'source-limit',
  'duplicate-identical', 'duplicate-gene-conflict', 'reported-field-empty', 'other-gene-unresolved',
  'malformed-diplotype', 'allele-not-in-definitions', 'no-phenotype-mapping', 'no-gene-definition',
  'conflicting-gene-inputs', 'sentinel-literal-in-source', 'lookup-context-required',
  'lookup-context-invalid', 'lookup-context-source-mismatch', 'lookup-policy-invalid',
  'out-of-review-scope', 'cell-unverified', 'cell-disputed', 'evidence-operation-failed',
  'snapshot-changed',
] as const;
export const reasonSchema = z.enum(REASONS);
export type LookupReason = z.infer<typeof reasonSchema>;
export const evidenceRefSchema = z.strictObject({
  sourceArtifactSha256: hash, start: index, end: index, literalSha256: hash,
}).refine((r) => r.start < r.end);
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const contextSchema = z.strictObject({
  schema: z.literal('report-lookup-context/1'), drug: z.literal('sertraline'), population: z.literal('general'),
  sourceKind: z.enum(['report', 'reviewed-external']), sourceArtifactSha256: hash,
  drugEvidence: evidenceRefSchema, populationEvidence: evidenceRefSchema, reviewRecordId: id,
});
export const geneStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ gene, state: z.literal('canonical'), phenotype: label, derivationRecordId: id }),
  z.strictObject({ gene, state: z.literal('absent'), coverageRecordId: id }),
  z.strictObject({ gene, state: z.literal('approved-unavailable'), basis: z.literal('unavailable-token'),
    valueEvidence: evidenceRefSchema, matcherPolicySha256: hash, reviewRecordId: id }),
  z.strictObject({ gene, state: z.literal('unresolved'), reasonCode: reasonSchema, evidenceRecordId: id }),
  z.strictObject({ gene, state: z.literal('sentinel'), valueEvidence: evidenceRefSchema, evidenceRecordId: id }),
  z.strictObject({ gene, state: z.literal('empty'), emptyFieldRecordId: id }),
]);
export const lookupInputSchema = z.strictObject({
  schema: z.literal('report-lookup-input/1'), textSha256: hash, packetHash: hash,
  captureAcceptanceId: id, policyId: id, policySha256: hash, context: contextSchema,
  geneStates: z.array(geneStateSchema).length(2),
}).refine((r) => new Set(r.geneStates.map((s) => s.gene)).size === 2);
export type ReportLookupInputV1 = z.infer<typeof lookupInputSchema>;
export type GeneState = z.infer<typeof geneStateSchema>;
export const selectorSchema = z.strictObject({ guidelineId: id, table: label, row: label, column: label.nullable() });
export type RowSelector = z.infer<typeof selectorSchema>;
export const policySchema = z.strictObject({
  schema: z.literal('sertraline-routing-policy/1'), id, drug: z.literal('sertraline'), population: z.literal('general'),
  genes: z.tuple([z.literal('CYP2C19'), z.literal('CYP2B6')]), combinedGuidelineId: id,
  singleGeneGuidelineIds: z.strictObject({ CYP2C19: id, CYP2B6: id }),
  reviewedRows: z.array(selectorSchema).min(1).max(500), knowledgeSetId: hash, reviewRecordId: id,
});
export type SertralineRoutingPolicyV1 = z.infer<typeof policySchema>;

export const scopeSchema = z.strictObject({ tenantId: id, reportId: id, captureId: id, actorId: id });
export type TrustedProcessingScope = z.infer<typeof scopeSchema>;
const relation = { tenantId: id, reportId: id, captureId: id };
const reviewSchema = z.strictObject({ id, reviewerId: id, sequence: index, decision: z.enum(['accepted', 'rejected']) });
const sourceBase = {
  id, version: z.literal(1), ...relation, textSha256: hash, packetHash: hash, generatorCodeHash: hash,
  gene, occurrenceIndex: index.nullable(), frameId: hash.nullable(), evidence: z.array(evidenceRefSchema).max(3),
  review: reviewSchema,
};
const field = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('missing') }), z.strictObject({ state: z.literal('empty') }),
  z.strictObject({ state: z.literal('present'), text: z.string().min(1).max(100) }),
]);
const facts = z.strictObject({ gene, diplotype: field, result: field });
const occurrenceBase = { ...sourceBase, facts, candidateIds: z.array(hash).min(1).max(3) };
const derivation = z.strictObject({ ...occurrenceBase, type: z.literal('derivation'),
  knowledgeSetId: hash, mappingFileId: id, mappingContentSha256: hash, phenotype: label });
const coverage = z.strictObject({ ...sourceBase, type: z.literal('coverage'), anchorPolicySha256: hash,
  region: z.strictObject({ start: index, end: index }), regionRuleId: id });
const unavailable = z.strictObject({ ...occurrenceBase, type: z.literal('unavailable'),
  matcherPolicySha256: hash, routingPolicySha256: hash, valueEvidence: evidenceRefSchema });
const unresolved = z.strictObject({ ...occurrenceBase, type: z.literal('unresolved'), reasonCode: reasonSchema });
const sentinel = z.strictObject({ ...occurrenceBase, type: z.literal('sentinel'), valueEvidence: evidenceRefSchema });
const empty = z.strictObject({ ...occurrenceBase, type: z.literal('empty'), role: z.enum(['diplotype', 'reportedResult']) });
export const sourceRecordSchema = z.discriminatedUnion('type', [derivation, coverage, unavailable, unresolved, sentinel, empty]);
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
const contextReview = z.strictObject({ id, type: z.literal('context-review'), version: z.literal(1),
  ...relation, sourceArtifactSha256: hash, contextRecordSha256: hash,
  drugEvidence: evidenceRefSchema, populationEvidence: evidenceRefSchema, review: reviewSchema });
const policyReview = z.strictObject({ id, type: z.literal('policy-review'), version: z.literal(1),
  policySha256: hash, knowledgeSetId: hash, reviewedRows: z.array(selectorSchema).min(1).max(500), review: reviewSchema });
export const recordSchema = z.discriminatedUnion('type', [
  derivation, coverage, unavailable, unresolved, sentinel, empty, contextReview, policyReview,
]);
export const snapshotSchema = z.strictObject({
  version: id,
  capture: z.strictObject({ ...relation, createdBy: id, pdfSha256: hash, objectVersion: id,
    text: z.string().max(200000), textSha256: hash, popplerVersion: id,
    acceptance: reviewSchema.extend({ ...relation, pdfSha256: hash, objectVersion: id, textSha256: hash, popplerVersion: id }) }),
  reader: z.unknown(),
  records: z.array(z.strictObject({ payload: recordSchema, recordSha256: hash })).max(200),
  latestReviews: z.array(z.strictObject({ recordId: id, reviewId: id, sequence: index })).max(200),
  sources: z.array(z.strictObject({ sha256: hash, text: z.string().max(200000) })).max(10),
  policyBytes: z.string().max(1048576),
  matcherPolicyBytes: z.string().max(4096),
  /** Current tenant dispute overlay. Knowledge identity keeps its existing loader computation. */
  knowledgeSetId: hash, disputedRows: z.array(selectorSchema).max(500),
});
export type LookupSnapshot = z.infer<typeof snapshotSchema>;
export type ValidatedRecord = z.infer<typeof recordSchema>;
export interface LookupPorts {
  /** Authorized store, not request data. One consistent read; JSON retains duplicate-key validation. */
  readSnapshot(scope: TrustedProcessingScope, signal: AbortSignal): Promise<string>;
  /** Local pinned deterministic reader replay. No remote service or model; returns the complete reader result. */
  replaySource(scope: TrustedProcessingScope, text: string, signal: AbortSignal): Promise<string>;
  /** Same authorized dependency read. Required immediately before returning; persistence remains a later slice. */
  currentVersion(scope: TrustedProcessingScope, signal: AbortSignal): Promise<string>;
}
export interface ValidatedBindings {
  inputRecordSha256: string | null; textSha256: string | null; packetHash: string | null;
  contextRecordSha256: string | null; policySha256: string | null; captureAcceptanceId: string | null;
}
export type AdmissionStage = 'capture' | 'packet' | 'association' | 'duplicate' | 'field' | 'reconciliation' | 'context' | 'policy' | 'input';
export type ReportLookupOutcome =
  | { schema: 'report-lookup-admission-failure/1'; stage: AdmissionStage; reasonCode: LookupReason; bindings: ValidatedBindings; selectedRow: null }
  | { schema: 'report-lookup-abstention/1'; reasonCode: 'association-abstained'; bindings: ValidatedBindings; selectedRow: null }
  | { schema: 'report-lookup-decision/1'; inputRecordSha256: string; policySha256: string; contextRecordSha256: string;
      decision: { state: 'held'; reasonCode: LookupReason; selectedRow: null }
        | { state: 'no-row'; reasonCode: 'both-results-missing'; selectedRow: null }
        | { state: 'row-selected'; selectedRow: RowSelector } };
export interface OfflineLookupResult {
  outcome: ReportLookupOutcome;
  /** Protected storage only; ordered gate/source diagnostics, no literal values. Never an automatic clinical release. */
  diagnostics: Array<{ stage: AdmissionStage; reasonCode: LookupReason }>;
  snapshotVersion: string | null;
  dependencyRecords: Array<{ id: string; recordSha256: string }>;
}

const stages = z.enum(['capture', 'packet', 'association', 'duplicate', 'field', 'reconciliation', 'context', 'policy', 'input']);
export const bindingsSchema = z.strictObject({
  inputRecordSha256: hash.nullable(), textSha256: hash.nullable(), packetHash: hash.nullable(),
  contextRecordSha256: hash.nullable(), policySha256: hash.nullable(), captureAcceptanceId: id.nullable(),
});
export const outcomeSchema = z.discriminatedUnion('schema', [
  z.strictObject({ schema: z.literal('report-lookup-admission-failure/1'), stage: stages,
    reasonCode: reasonSchema, bindings: bindingsSchema, selectedRow: z.null() }),
  z.strictObject({ schema: z.literal('report-lookup-abstention/1'), reasonCode: z.literal('association-abstained'),
    bindings: bindingsSchema, selectedRow: z.null() }),
  z.strictObject({ schema: z.literal('report-lookup-decision/1'), inputRecordSha256: hash,
    policySha256: hash, contextRecordSha256: hash, decision: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('held'), reasonCode: reasonSchema, selectedRow: z.null() }),
      z.strictObject({ state: z.literal('no-row'), reasonCode: z.literal('both-results-missing'), selectedRow: z.null() }),
      z.strictObject({ state: z.literal('row-selected'), selectedRow: selectorSchema }),
    ]) }),
]);
