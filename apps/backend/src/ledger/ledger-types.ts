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
/**
 * SQLSTATE class 23 (integrity constraint violation) becomes a LedgerIntegrityError; a lock timeout (55P03) becomes a LedgerBusyError;
 * anything else is returned untouched.
 */
export function toLedgerError(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  if (typeof code === 'string' && code.startsWith(INTEGRITY_CLASS)) return new LedgerIntegrityError('A ledger or record integrity rule refused this write.', code, constraint);
  if (code === LOCK_NOT_AVAILABLE) return new LedgerBusyError();
  return error;
}
