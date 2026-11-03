import { z } from 'zod';

// Spec 032 S2c: independent review of stored synthetic laboratory findings, and explicit resolution of conflicting sources.
// "accepted-as-evidence" says only that the stored finding matches its source. It never makes a finding actionable.
const syntheticId = z.string().regex(/^syn-[a-z0-9-]{1,76}$/);

export const FINDING_REVIEW_REASONS = {
  'accepted-as-evidence': ['matches-source'],
  rejected: ['does-not-match-source', 'source-unreadable'],
  held: ['needs-clarification', 'source-uncertain'],
} as const;
export const findingReviewDecisionSchema = z.enum(['accepted-as-evidence', 'rejected', 'held']);
export type FindingReviewDecision = z.infer<typeof findingReviewDecisionSchema>;

export const structuredFindingReviewCreateSchema = z
  .strictObject({
    requestId: z.uuid(),
    revisionId: z.uuid(),
    patientId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    objectVersion: z.string().min(1).max(1024),
    patientLinkDecisionId: z.uuid(),
    findingId: syntheticId,
    decision: findingReviewDecisionSchema,
    reasonCode: z.enum(['matches-source', 'does-not-match-source', 'source-unreadable', 'needs-clarification', 'source-uncertain']),
  })
  .refine((v) => (FINDING_REVIEW_REASONS[v.decision] as readonly string[]).includes(v.reasonCode), { message: 'The reason does not fit the decision.', path: ['reasonCode'] });
export type StructuredFindingReviewCreate = z.infer<typeof structuredFindingReviewCreateSchema>;

export const SOURCE_RESOLUTION_REASONS = {
  'use-revision': ['verified-against-laboratory'],
  'none-usable': ['sources-unreliable', 'cannot-establish'],
  'keep-held': ['awaiting-laboratory'],
} as const;
export const sourceResolutionOutcomeSchema = z.enum(['use-revision', 'none-usable', 'keep-held']);
export type SourceResolutionOutcome = z.infer<typeof sourceResolutionOutcomeSchema>;

// The resolver names the exact set of conflicting stored revisions it looked at; a changed set makes the decision stale.
export const structuredSourceResolutionCreateSchema = z
  .strictObject({
    requestId: z.uuid(),
    patientId: z.uuid(),
    laboratoryId: syntheticId,
    seriesId: syntheticId,
    revision: z.int().positive().max(1_000_000),
    revisionIds: z.array(z.uuid()).min(2).max(100),
    outcome: sourceResolutionOutcomeSchema,
    chosenRevisionId: z.uuid().optional(),
    reasonCode: z.enum(['verified-against-laboratory', 'sources-unreliable', 'cannot-establish', 'awaiting-laboratory']),
  })
  .refine((v) => new Set(v.revisionIds).size === v.revisionIds.length, { message: 'Revision ids must be distinct.', path: ['revisionIds'] })
  .refine((v) => (SOURCE_RESOLUTION_REASONS[v.outcome] as readonly string[]).includes(v.reasonCode), { message: 'The reason does not fit the outcome.', path: ['reasonCode'] })
  .refine((v) => (v.outcome === 'use-revision' ? v.chosenRevisionId !== undefined && v.revisionIds.includes(v.chosenRevisionId) : v.chosenRevisionId === undefined), {
    message: 'Only a use-revision outcome names one of the conflicting revisions.',
    path: ['chosenRevisionId'],
  });
export type StructuredSourceResolutionCreate = z.infer<typeof structuredSourceResolutionCreateSchema>;

export const reviewedFindingSchema = z.strictObject({
  findingId: z.string(),
  targetId: z.string().nullable(),
  gene: z.string().nullable(),
  coverage: z.string().nullable(),
  analyticalState: z.string().nullable(),
  interpretationState: z.string().nullable(),
  decision: z.enum(['unreviewed', 'accepted-as-evidence', 'rejected', 'held']),
  reasonCode: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  actionable: z.literal(false),
});
export type ReviewedFinding = z.infer<typeof reviewedFindingSchema>;

export const OUTSTANDING_REVIEW_ACTIONS = ['review-findings', 'reopen-held-findings', 'resolve-source-conflict', 'await-new-source', 'recheck-changed-binding'] as const;
export const structuredReviewStateSchema = z.strictObject({
  status: z.enum(['not-reviewable', 'awaiting-review', 'in-progress', 'attention', 'complete']),
  findings: z.array(reviewedFindingSchema).max(50),
  outstanding: z.array(z.enum(OUTSTANDING_REVIEW_ACTIONS)).max(5),
  evidenceOnly: z.literal(true),
});
export type StructuredReviewState = z.infer<typeof structuredReviewStateSchema>;

export const structuredConflictSchema = z.strictObject({
  laboratoryId: z.string(),
  seriesId: z.string(),
  revision: z.int().positive(),
  revisionIds: z.array(z.uuid()).min(2).max(100),
  resolution: z
    .strictObject({
      id: z.uuid(),
      outcome: sourceResolutionOutcomeSchema,
      chosenRevisionId: z.uuid().nullable(),
      reasonCode: z.string(),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
});
export type StructuredConflict = z.infer<typeof structuredConflictSchema>;
