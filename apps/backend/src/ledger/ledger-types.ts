/**
 * The audit ledger (docs/design/records-and-corrections.md, section 6).
 *
 * Two versions are stored on every event, so a future format change is detectable instead of silently reinterpreted:
 *  - PROJECTION_VERSION: how a stored record is turned into the object that is hashed (projections.ts);
 *  - HASH_VERSION:       how an event's own hash is computed from its columns (record-hash.ts, and the SQL in migration 0005).
 */
export const PROJECTION_VERSION = 1;
export const HASH_VERSION = 1;

/** What a redacted note's body is replaced by. */
export const TOMBSTONE = '[redacted]';
export const REDACTION_BASIS_CODES = ['phi-in-note', 'legal-order', 'other-approved'] as const;
export type RedactionBasisCode = (typeof REDACTION_BASIS_CODES)[number];

/** The record tables whose rows each carry their own ledger event, with the event type that describes them. */
export const EVENT_TYPE_FOR_TABLE = {
  report_captures: 'capture',
  capture_acceptances: 'capture-decision',
  evaluations: 'evaluation',
  corrections: 'correction',
  cell_disputes: 'dispute',
  cell_dispute_decisions: 'dispute-decision',
  report_patient_decisions: 'patient-link-decision',
  patient_merge_proposals: 'patient-merge-proposal',
  patient_merge_decisions: 'patient-merge-decision',
  clinician_result_decisions: 'clinician-result-decision',
} as const;
export type RecordTable = keyof typeof EVENT_TYPE_FOR_TABLE;
export const RECORD_TABLES = Object.keys(EVENT_TYPE_FOR_TABLE) as RecordTable[];

/** Every table an event can be about (the record tables, plus checkpoints and redacted notes, which are written by privileged functions). */
export type SubjectTable = RecordTable | 'ledger_checkpoints' | 'event_notes';

/** Raised for an integrity rule of the ledger or the record tables. The message never contains a value from a record. */
export class LedgerIntegrityError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly constraint?: string,
  ) {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

/** The report changed (or vanished) between the moment the caller read it and the moment its capture was written. Nothing was written. */
export class SourceChangedError extends Error {
  constructor() {
    super('The report changed while it was being captured.');
    this.name = 'SourceChangedError';
  }
}

/**
 * A dispute became active (open or upheld) after the evaluation read the disputes it built its overlay from, so the result it was about
 * to store may show a cell that should now be held. Raised AFTER the ledger lock is held, which is what makes the check conclusive.
 * Nothing was written; the caller re-reads the disputes and evaluates again.
 */
export class DisputeChangedError extends Error {
  constructor() {
    super('A dispute changed while the evaluation was being made.');
    this.name = 'DisputeChangedError';
  }
}

/**
 * The report's patient link is not verified for the file it holds now: no decision, a rejection, or a decision made about an earlier file. Raised
 * AFTER the ledger lock is held, so a decision recorded or a file replaced in between cannot slip past. Nothing was saved.
 */
export class PatientLinkUnverifiedError extends Error {
  constructor() {
    super('The report is not verified as belonging to its patient.');
    this.name = 'PatientLinkUnverifiedError';
  }
}

/**
 * A merge or unmerge may not happen in the state the patients are in now: the source is already merged, the target is, the source has aliases of
 * its own, no merge is in force to undo, or a patient is gone. `reason` is the code the database's rule returned. Raised by the repository's own
 * look at the rule, or by the database at COMMIT (SQLSTATE PM001) under the ledger lock. Nothing was saved.
 */
export class MergeRefusedError extends Error {
  constructor(readonly reason: string) {
    super('The merge is not possible in the current state of the patients.');
    this.name = 'MergeRefusedError';
  }
}

/** The proposal already has a decision, and it is not the one being recorded. Nothing was saved. */
export class MergeAlreadyDecidedError extends Error {
  constructor() {
    super('The proposal was already decided.');
    this.name = 'MergeAlreadyDecidedError';
  }
}

/** The acceptance was superseded before the evaluation acquired the ledger lock. Nothing was saved. */
export class StaleAcceptanceError extends Error {
  constructor() {
    super('The capture acceptance is no longer current.');
    this.name = 'StaleAcceptanceError';
  }
}

/**
 * The record log of this tenant is contained (an open incident, or a global hold), so no record is written for it until a person clears the
 * incident after an investigation. Raised by this process's own gate before anything is appended, or by the database (SQLSTATE LC001, from
 * `ledger_append`, which every task shares). The transaction that was about to write rolls back. Reads are not affected.
 */
export class LedgerCompromisedError extends Error {
  constructor() {
    super('The record log is contained; writes are stopped.');
    this.name = 'LedgerCompromisedError';
  }
}

/** The tenant's head-row lock was not obtained within `lock_timeout`. Nothing was written; retrying is safe. */
export class LedgerBusyError extends Error {
  /** The SQLSTATE it came from (lock_not_available), kept so callers that look at `code` still see it. */
  readonly code = '55P03';
  constructor() {
    super('The ledger lock was not obtained in time.');
    this.name = 'LedgerBusyError';
  }
}

const INTEGRITY_CLASS = '23';
const LOCK_NOT_AVAILABLE = '55P03';
/** Raised by `ledger_append` (migration 0011) while the tenant has an open incident or a global hold is open. */
export const LEDGER_CONTAINED = 'LC001';
/** Raised at COMMIT by the merge-decision rule (migration 0021); the message is the reason code. */
export const MERGE_REFUSED = 'PM001';
/**
 * SQLSTATE class 23 (integrity constraint violation) becomes a LedgerIntegrityError; a lock timeout (55P03) becomes a LedgerBusyError;
 * the database's containment refusal (LC001) becomes a LedgerCompromisedError; anything else is returned untouched.
 */
export function toLedgerError(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  if (typeof code === 'string' && code.startsWith(INTEGRITY_CLASS)) return new LedgerIntegrityError('A ledger or record integrity rule refused this write.', code, constraint);
  if (code === LOCK_NOT_AVAILABLE) return new LedgerBusyError();
  if (code === LEDGER_CONTAINED) return new LedgerCompromisedError();
  if (code === MERGE_REFUSED) return new MergeRefusedError((error as Error).message);
  return error;
}
