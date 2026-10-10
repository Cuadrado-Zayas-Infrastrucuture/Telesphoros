import type {
  AcceptanceInput, CaptureInput, CorrectionInput, DisputeDecisionInput, DisputeInput, DisputeStatus, EvaluationInput, EvaluationReadContext, EvaluationState, InsertResult, NoteRecord, Projected,
} from './ledger-records';
import type { DisputeStatusValue } from '@telesphoros/shared-types';
import type { Page, PageRequest } from './records';

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
