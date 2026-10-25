import type { DrugResult, GeneStateResult } from '@telesphoros/cpic-schema';

/** Mutable read context for an evaluation; corrections retain their complete canonical projections, oldest first. */
export interface EvaluationReadContext {
  acceptance: { id: string; decision: 'accepted' | 'rejected'; current: boolean } | null;
  corrections: Projected[];
}

/**
 * Records of the lab-report pipeline (docs/design/records-and-corrections.md). Every one is append-only, tenant-scoped, and committed
 * together with its ledger event. Reads return the PROJECTION of the stored row (the exact object that was hashed): camelCase,
 * `seq` as a decimal string, timestamps as UTC text with microseconds, free text replaced by `{ id, bodySha256 }`.
 */

/**
 * What the caller saw of the report before it read the stored file. The capture's transaction locks the report row, re-reads these
 * and refuses (SourceChangedError) if any differs: a capture can only ever describe the report that was actually processed.
 */
export interface ExpectedReportBindings {
  patientId: string;
  sha256: string;
  objectVersion: string;
  storageKey: string;
}

export interface CaptureInput {
  reportId: string;
  /** Required, so no caller can write a capture without saying what it relied on. */
  expectedReport: ExpectedReportBindings;
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
  /**
   * The retry identity of this decision: set by the caller, kept with the row, never shown. `hash` fingerprints the original request (the capture, the
   * decision and the note), so a repeat by the same reviewer with the same fingerprint returns the decision already stored and another fingerprint is refused.
   */
  request?: { id: string; hash: string };
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
  /**
   * The ids of the disputes (open or upheld) that were in force when the overlay for these results was built. A NEW evaluated evaluation
   * is refused (DisputeChangedError) if, after the ledger lock is held, any active dispute is not in this list. Omitted means "none were
   * considered", so any active dispute refuses (fail closed). Not stored; the effective knowledge set id records what was applied.
   */
  disputeBasis?: readonly string[];
  /**
   * The patient-link decision the caller relied on (the report's latest). A NEW evaluation is refused (PatientLinkUnverifiedError) if, once the
   * ledger lock is held, that decision is not still the latest, is not `verified`, or was made about a file or patient the report no longer has.
   * Omitted means no such check: only the evaluations service creates evaluations in production, and it always passes this (a test enforces that).
   */
  patientLinkDecisionId?: string;
  /** The adapter's audit trail (offsets, hashes, states, codes); empty when held. */
  occurrences: unknown[];
  /** The engine's output, stored as it was shown. Empty when held. */
  results: DrugResult[];
  geneStates: GeneStateResult[];
}

/**
 * A person's decision that a report's exact file version belongs to a patient (M2.1b). The caller states the file and patient it relied on; the
 * transaction locks the report row, re-reads them and refuses (SourceChangedError) if any differs, so a decision can only ever describe the file
 * that was actually looked at.
 */
export interface PatientDecisionInput {
  reportId: string;
  expectedReport: { patientId: string; sha256: string; objectVersion: string };
  decision: 'verified' | 'rejected';
  method: 'identifier-match' | 'person-confirmed';
  /** Required with `person-confirmed`, absent with `identifier-match`. */
  basisCode?: string;
  /** Required with `identifier-match`: the registered identifier that matched. Never the value. */
  identifierId?: string;
}

export type CorrectionKind = 'retraction' | 'supersession' | 'reinstatement';
export type CorrectionReasonCode =
  'capture-wrong' | 'wrong-patient' | 'input-misread' | 'knowledge-error-found' | 'software-defect' | 'clinical-review-disagrees' | 'retraction-mistaken';

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
  /**
   * The retry identity of this dispute: set by the caller, kept with the row, never shown. `hash` fingerprints the original request (the guideline, the cell and the
   * note), so a repeat by the same reviewer with the same fingerprint returns the dispute already stored and another fingerprint is refused.
   */
  request?: { id: string; hash: string };
}

export interface DisputeDecisionInput {
  disputeId: string;
  decision: 'upheld' | 'dismissed';
  evidenceNote: string;
}

/** Where a report's link to its patient stands for the file it holds NOW (derived from the newest decision; see `linkState`). */
export type PatientLinkStateValue = 'verified' | 'unverified' | 'rejected';

/** A quarantined report that still has active evaluations (M2.1c-1). */
export interface QuarantineEntry {
  reportId: string;
  patientId: string;
  basisCode: string | null;
  rejectedAt: string;
  activeEvaluationIds: string[];
}

/** A proposal to merge one patient into another, or to undo that merge (M2.1c-2). */
export interface MergeProposalInput {
  kind: 'merge' | 'unmerge';
  /** The patient that becomes (or stops being) an alias. */
  sourcePatientId: string;
  /** The patient it is (or was) merged into. */
  targetPatientId: string;
  reasonCode: string;
}

export interface MergeDecisionInput {
  proposalId: string;
  decision: 'approved' | 'declined';
}

/** A proposal and where it stands: pending, or the decision that settled it. */
export interface MergeStatus {
  proposal: Projected;
  status: 'pending' | 'approved' | 'declined';
  decision: Projected | null;
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

/** A stored note, for the one route that reads free text. `body` is the fixed tombstone once redacted. */
export interface NoteRecord {
  id: string;
  body: string;
  bodySha256: string;
  redacted: boolean;
  createdAt: string;
}
