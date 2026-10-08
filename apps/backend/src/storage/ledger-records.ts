import type { DrugResult, GeneStateResult } from '@telesphoros/cpic-schema';

/**
 * Records of the lab-report pipeline (docs/design/records-and-corrections.md). Every one is append-only, tenant-scoped, and committed
 * together with its ledger event. Reads return the PROJECTION of the stored row (the exact object that was hashed): camelCase,
 * `seq` as a decimal string, timestamps as UTC text with microseconds, free text replaced by `{ id, bodySha256 }`.
 */

export interface CaptureInput {
  reportId: string;
  pdfSha256: string;
  textStorageKey: string;
  textSha256: string;
  textScalars: number;
  popplerVersion: string;
  runner: 'fake' | 'poppler';
}

export interface AcceptanceInput {
  captureId: string;
  decision: 'accepted' | 'rejected';
  textSha256: string;
  popplerVersion: string;
  /** Free text; stored in event_notes, never in the ledger. */
  note?: string;
}

export interface EvaluationInput {
  patientId: string;
  reportId: string;
  captureId: string;
  captureAcceptanceId: string | null;
  disposition: 'held' | 'evaluated';
  holdCode: string | null;
  /** The adapter's SourceBinding. */
  binding: Record<string, unknown>;
  knowledgeSetId: string;
  engineVersion: string;
  /** Exactly what was passed to evaluate(); empty when held. */
  geneInputs: unknown[];
  /** The adapter's audit trail (offsets, hashes, states, codes); empty when held. */
  occurrences: unknown[];
  /** The engine's output, stored as it was shown. Empty when held. */
  results: DrugResult[];
  geneStates: GeneStateResult[];
}

export type CorrectionKind = 'retraction' | 'supersession' | 'reinstatement';
export type CorrectionReasonCode =
  | 'capture-wrong' | 'wrong-patient' | 'input-misread' | 'knowledge-error-found' | 'software-defect' | 'clinical-review-disagrees' | 'retraction-mistaken';

export interface CorrectionInput {
  evaluationId: string;
  kind: CorrectionKind;
  reasonCode: CorrectionReasonCode;
  previousCorrectionId?: string;
  replacementEvaluationId?: string;
  note?: string;
}

export interface DisputeInput {
  guidelineId: string;
  guidelineVersion: string;
  guidelineContentSha256: string;
  locator: { table: string; row: string; column?: string };
  note: string;
}

export interface DisputeDecisionInput {
  disputeId: string;
  decision: 'upheld' | 'dismissed';
  evidenceNote: string;
}

/** What a read returns. */
export type Projected = Record<string, unknown> & { id: string; tenantId: string; seq: string; createdBy: string; createdAt: string };

export interface InsertResult {
  record: Projected;
  /** False when the same inputs had already been stored and the existing record is returned. */
  created: boolean;
}

export type EvaluationState = { state: 'active' } | { state: 'retracted' } | { state: 'superseded'; by: string };

export interface DisputeStatus {
  dispute: Projected;
  status: 'open' | 'upheld' | 'dismissed';
  decision: Projected | null;
}
