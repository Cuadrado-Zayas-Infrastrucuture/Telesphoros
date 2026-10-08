import type {
  AcceptanceInput, CaptureInput, CorrectionInput, DisputeDecisionInput, DisputeInput, DisputeStatus, EvaluationInput, EvaluationState, InsertResult, Projected,
} from './ledger-records';

/**
 * The records of the lab-report pipeline. PostgreSQL only: the ledger's guarantees (database-computed hashes, triggers, deferred
 * checks) cannot be honoured by an in-memory store, so with STORAGE_DRIVER=memory these are not registered at all.
 * Every method is tenant-scoped; `actor` is the authenticated individual.
 */
export abstract class LedgerRecordsRepository {
  abstract insertCapture(tenantId: string, actor: string, input: CaptureInput): Promise<InsertResult>;
  abstract findCapture(tenantId: string, id: string): Promise<Projected | undefined>;

  abstract insertAcceptance(tenantId: string, actor: string, input: AcceptanceInput): Promise<InsertResult>;
  /** The latest decision about a capture (by sequence), or undefined. */
  abstract latestAcceptance(tenantId: string, captureId: string): Promise<Projected | undefined>;

  /** Idempotent per identity key: the same inputs, knowledge and code return the existing evaluation. */
  abstract insertEvaluation(tenantId: string, actor: string, input: EvaluationInput): Promise<InsertResult>;
  abstract findEvaluation(tenantId: string, id: string): Promise<Projected | undefined>;
  abstract listEvaluations(tenantId: string, filter: { reportId?: string; patientId?: string }): Promise<Projected[]>;

  abstract insertCorrection(tenantId: string, actor: string, input: CorrectionInput): Promise<InsertResult>;
  abstract listCorrections(tenantId: string, evaluationId: string): Promise<Projected[]>;
  abstract evaluationState(tenantId: string, evaluationId: string): Promise<EvaluationState>;

  abstract raiseDispute(tenantId: string, actor: string, input: DisputeInput): Promise<InsertResult>;
  abstract decideDispute(tenantId: string, actor: string, input: DisputeDecisionInput): Promise<InsertResult>;
  abstract listDisputes(tenantId: string): Promise<DisputeStatus[]>;
}
