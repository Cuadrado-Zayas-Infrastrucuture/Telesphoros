/**
 * A write violated a database integrity rule (duplicate key, or a foreign-key RESTRICT).
 * Raised by the storage layer so the HTTP layer can answer 409 CONFLICT instead of 500, including
 * when two requests race past the service-level checks and the database is the one to say no.
 */
export class IntegrityError extends Error {
  constructor(readonly constraint?: string) {
    super('Integrity constraint violated');
  }
}

/** A soft delete refused by the database because other patients were merged into the patient (migration 0034, SQLSTATE PM002). */
export class PatientHasMergedRecordsError extends Error {
  readonly reason = 'patient-has-merged-records';
  constructor() {
    super('Other patient records were merged into this one.');
  }
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
/** Raised explicitly by our own triggers (migration 0010: the stored file and a captured report cannot change). */
const INTEGRITY_RULE = '23000';
const PATIENT_DELETE_REFUSED = 'PM002';

/** Translates a PostgreSQL error into a storage error; anything unrecognised is returned untouched. */
export function toStorageError(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  if (code === PATIENT_DELETE_REFUSED) return new PatientHasMergedRecordsError();
  if (code === UNIQUE_VIOLATION || code === FOREIGN_KEY_VIOLATION || code === INTEGRITY_RULE) return new IntegrityError(constraint);
  return error;
}
