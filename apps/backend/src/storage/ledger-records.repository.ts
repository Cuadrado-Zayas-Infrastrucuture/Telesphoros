import type {
  AcceptanceInput, CaptureInput, CorrectionInput, DisputeDecisionInput, DisputeInput, DisputeStatus, EvaluationInput, EvaluationState, InsertResult, Projected,
} from './ledger-records';

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
   * A NEW evaluation that shows drug results (`disposition: 'evaluated'`) throws DisputeActiveError if a dispute is open or upheld,
   * checked in a separate statement AFTER the tenant's ledger lock is held (see the implementation). A held evaluation shows nothing
   * and is not blocked.
   * A new evaluation naming an acceptance also rechecks that decision after the lock; supersession throws StaleAcceptanceError.
   */
  abstract insertEvaluation(tenantId: string, actor: string, input: EvaluationInput): Promise<InsertResult>;
  abstract findEvaluation(tenantId: string, id: string): Promise<Projected | undefined>;
  /** True when a dispute is open or upheld in the tenant. An early exit for callers; `insertEvaluation` repeats it after the ledger lock. */
  abstract activeDisputeExists(tenantId: string): Promise<boolean>;
  abstract listEvaluations(tenantId: string, filter: { reportId?: string; patientId?: string }): Promise<Projected[]>;

  abstract insertCorrection(tenantId: string, actor: string, input: CorrectionInput): Promise<InsertResult>;
  abstract listCorrections(tenantId: string, evaluationId: string): Promise<Projected[]>;
  abstract evaluationState(tenantId: string, evaluationId: string): Promise<EvaluationState>;

  abstract raiseDispute(tenantId: string, actor: string, input: DisputeInput): Promise<InsertResult>;
  abstract decideDispute(tenantId: string, actor: string, input: DisputeDecisionInput): Promise<InsertResult>;
  abstract listDisputes(tenantId: string): Promise<DisputeStatus[]>;
}
