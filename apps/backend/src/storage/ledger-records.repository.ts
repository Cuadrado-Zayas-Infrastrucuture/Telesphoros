import type {
  AcceptanceInput, CaptureInput, CorrectionInput, DisputeDecisionInput, DisputeInput, DisputeStatus, EvaluationInput, EvaluationReadContext, EvaluationState, InsertResult, MergeDecisionInput, MergeProposalInput, MergeStatus, NoteRecord, PatientDecisionInput, PatientLinkStateValue, Projected, QuarantineEntry,
} from './ledger-records';
import type { DisputeStatusValue } from '@telesphoros/shared-types';
import type { Page, PageRequest } from './records';

/** The same retry id came with a different decision or note (or for another capture) than the one stored under it. */
export class CaptureDecisionRequestReusedError extends Error {
  constructor() {
    super('That request id was already used for a different capture decision.');
    this.name = 'CaptureDecisionRequestReusedError';
  }
}

/** The same retry id came with a different guideline, cell or note than the dispute stored under it. */
export class DisputeRequestReusedError extends Error {
  constructor() {
    super('That request id was already used for a different dispute.');
    this.name = 'DisputeRequestReusedError';
  }
}

/**
 * The records of the lab-report pipeline. PostgreSQL only: the ledger's guarantees (database-computed hashes, triggers, deferred
 * checks) cannot be honoured by an in-memory store, so with STORAGE_DRIVER=memory these are not registered at all.
 * Every method is tenant-scoped; `actor` is the authenticated individual.
 */
export abstract class LedgerRecordsRepository {
  /**
   * Locks the report row, re-reads the bindings the caller relied on (`input.expectedReport`) and throws SourceChangedError if any
   * differs; only then inserts. Idempotent per content identity: the same text again returns the existing capture and writes nothing.
   */
  abstract insertCapture(tenantId: string, actor: string, input: CaptureInput): Promise<InsertResult>;
  abstract findCapture(tenantId: string, id: string): Promise<Projected | undefined>;
  /** The capture already stored for this content identity, if any. */
  abstract findCaptureByIdentity(tenantId: string, identity: { reportId: string; textSha256: string; popplerVersion: string }): Promise<Projected | undefined>;

  /**
   * Records a patient-link decision. Locks the report row, re-reads the file and patient the caller relied on and throws SourceChangedError if
   * any differs. If the newest decision for this file already says the same thing, returns it and writes nothing (`created: false`).
   */
  abstract insertPatientDecision(tenantId: string, actor: string, input: PatientDecisionInput): Promise<InsertResult>;
  /** The newest patient-link decision about the report (any file version), or undefined. */
  abstract latestPatientDecision(tenantId: string, reportId: string): Promise<Projected | undefined>;
  /** For each asked report, its link state for the file it holds now, in one statement. Every asked report has an entry (`unverified` when unknown). */
  abstract patientLinkStates(tenantId: string, reportIds: string[]): Promise<Map<string, PatientLinkStateValue>>;
  /**
   * Reports whose link was REJECTED for the file they hold now and that still have an active evaluation, oldest rejection first (M2.1c-1). Counted
   * and paged from one statement.
   */
  abstract pageQuarantine(tenantId: string, page: PageRequest): Promise<Page<QuarantineEntry>>;

  /**
   * Records a proposal to merge (or unmerge) two patients of the organization. In the writing transaction it asks the database's rule whether the
   * merge is possible now (throws MergeRefusedError with the reason if not) and refuses a second undecided proposal for the same pair and kind
   * (MergeRefusedError 'proposal-pending'). The decision is what changes anything.
   */
  abstract insertMergeProposal(tenantId: string, actor: string, input: MergeProposalInput): Promise<InsertResult>;
  /**
   * Records the decision on a proposal. The same decision again returns the stored one (`created: false`); a different one throws
   * MergeAlreadyDecidedError. An approved decision is checked by the database at COMMIT, under the ledger lock, against the patients as they are
   * then: MergeRefusedError with the reason if the merge is no longer possible. The decider must differ from the proposer (the database repeats it).
   */
  abstract insertMergeDecision(tenantId: string, actor: string, input: MergeDecisionInput): Promise<InsertResult>;
  abstract findMerge(tenantId: string, proposalId: string): Promise<MergeStatus | undefined>;
  /** Proposals newest first, with where each stands; optionally only those in one state. */
  abstract pageMerges(tenantId: string, page: PageRequest, status?: 'pending' | 'approved' | 'declined'): Promise<Page<MergeStatus>>;

  abstract insertAcceptance(tenantId: string, actor: string, input: AcceptanceInput): Promise<InsertResult>;
  abstract findAcceptance(tenantId: string, id: string): Promise<Projected | undefined>;
  /** The latest decision about a capture (by sequence), or undefined. */
  abstract latestAcceptance(tenantId: string, captureId: string): Promise<Projected | undefined>;

  /**
   * Idempotent per identity key: the same inputs, knowledge and code return the existing evaluation.
   * A NEW evaluation that shows drug results (`disposition: 'evaluated'`) throws DisputeChangedError if, once the tenant's ledger lock is
   * held, a dispute is active (open or upheld) that is not in `input.disputeBasis`: checked in a separate statement AFTER the lock (see the
   * implementation). A held evaluation shows nothing and is not blocked.
   * A new evaluation naming an acceptance also rechecks that decision after the lock; supersession throws StaleAcceptanceError.
   */
  abstract insertEvaluation(tenantId: string, actor: string, input: EvaluationInput): Promise<InsertResult>;
  abstract findEvaluation(tenantId: string, id: string): Promise<Projected | undefined>;
  /** `current` keeps only the current evaluation of each report: its newest, if active (specification 4.5, amended in section 22); the other filters narrow the result further. */
  abstract listEvaluations(tenantId: string, filter: { reportId?: string; patientId?: string; current?: boolean }, page: PageRequest): Promise<Page<Projected>>;
  /** Batch the named acceptance/current-decision comparison and complete corrections for selected tenant evaluations. Unknown/foreign IDs are absent. */
  abstract evaluationContexts(tenantId: string, evaluationIds: string[]): Promise<Map<string, EvaluationReadContext>>;
  /** For each report, the id of its current evaluation (its newest, if that is active), or null when it has none. Every asked report has an entry. */
  abstract currentEvaluationIds(tenantId: string, reportIds: string[]): Promise<Map<string, string | null>>;

  abstract insertCorrection(tenantId: string, actor: string, input: CorrectionInput): Promise<InsertResult>;
  abstract listCorrections(tenantId: string, evaluationId: string): Promise<Projected[]>;
  abstract evaluationState(tenantId: string, evaluationId: string): Promise<EvaluationState>;

  abstract raiseDispute(tenantId: string, actor: string, input: DisputeInput): Promise<InsertResult>;
  abstract decideDispute(tenantId: string, actor: string, input: DisputeDecisionInput): Promise<InsertResult>;
  /** Complete internal read for clinical overlays and advisories. Never substitute a public page here. */
  abstract listDisputes(tenantId: string): Promise<DisputeStatus[]>;
  abstract pageDisputes(tenantId: string, page: PageRequest, status?: DisputeStatusValue): Promise<Page<DisputeStatus>>;
  abstract findDispute(tenantId: string, id: string): Promise<DisputeStatus | undefined>;
  /** Bounded historical candidates, by citation identity WITHOUT the file hash; the service must classify file provenance. */
  abstract cellEvaluationCandidates(tenantId: string, cell: DisputeInput, afterSeq: string, limit: number): Promise<Projected[]>;

  /** A note's text (or its tombstone). Notes are free text kept out of the ledger; this is the only read of their body. */
  abstract findNote(tenantId: string, id: string): Promise<NoteRecord | undefined>;
}
