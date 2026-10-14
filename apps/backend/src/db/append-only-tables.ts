/**
 * Every table of the audit design, by what it is allowed to do. A catalog test (test/db/ledger-catalog.pg-spec.ts) reads the live
 * database and fails when a table in the `public` schema is not classified here, or when a classified table lacks what its class requires.
 * Adding a table therefore forces a decision, in code review, about its protection.
 */
export const APPEND_ONLY_CLASSES = {
  /** One row per fact, with its own ledger event (`ledger_event_id`, `created_by`, `seq`). Insert-only for everyone. */
  record: ['report_captures', 'capture_acceptances', 'evaluations', 'corrections', 'cell_disputes', 'cell_dispute_decisions', 'report_patient_decisions', 'patient_merge_proposals', 'patient_merge_decisions'],
  /** Parts of a record, covered by the parent's event. Insert-only; frozen once the parent's event is visible. */
  child: ['evaluation_results', 'evaluation_gene_states'],
  /** The chain itself. Written only by the ledger functions. */
  ledger: ['ledger_events', 'ledger_checkpoints'],
  /** The one controlled-update table: advances by exactly one, together with the event appended in the same transaction. */
  head: ['ledger_heads'],
  /** Free text. Insert-only except the single redaction update. */
  notes: ['event_notes'],
  /** Containment of a damaged ledger (migration 0011): written only by its functions, never updated; open until a clearance names the incident. */
  incident: ['ledger_incidents', 'ledger_incident_clearances'],
  /** Application access evidence: app calls a constrained writer but cannot read or mutate rows. */
  security: ['security_audit_events'],
} as const;

/** Tables from before the ledger: protected by tenant isolation, not by append-only rules. */
export const LEGACY_TABLES = ['patients', 'reports', 'recommendations', 'schema_migrations'] as const;

// Local operational state advances under CAS/identity guards; it is not a clinical append-only fact.
export const MUTABLE_OPERATIONAL_TABLES = ['report_upload_runs','report_upload_attempts'] as const;

/**
 * Authority state (migration 0017): who belongs to which organization with which roles. Written only by the operator command (the table's
 * owner); the application role can only read its own organization's rows. Rows are never deleted: a removed person's row is the revocation record.
 */
export const AUTHORITY_TABLES = ['tenant_memberships', 'tenants', 'invitations'] as const;

/**
 * A clinic's identifiers for patients (migration 0020): tenant-isolated like the patient rows, holding only keyed digests. The one change a row
 * takes is active to withdrawn, once, with the person who did it; nothing is deleted.
 */
export const PATIENT_IDENTITY_TABLES = ['patient_identifiers'] as const;

/**
 * Possible-duplicate flags (migration 0021): tenant-isolated like the patient rows and truly append-only (no update, delete or truncate for anyone).
 * Not a ledger record: a flag says two patients' identifiers collided, holds no identifier, and decides nothing.
 */
export const PATIENT_DUPLICATE_TABLES = ['patient_duplicate_flags'] as const;

/**
 * The security-event record (migration 0018): append-only, no privilege for the application role (it calls security_event_append()), readable only by the
 * auditor role. Not part of the clinical ledger and not clinical data.
 */
export const SECURITY_AUDIT_TABLES = ['security_events'] as const;

/**
 * The background-job queue (migration 0023), owned by `telesphoros_jobs` and written only by its SECURITY DEFINER functions: the application and the worker can
 * read their organization's `jobs` and `job_attempts` and call functions, nothing more. `job_attempts` is append-only for everyone, the owner included; `jobs`,
 * `job_schedules` and `job_workers` are operational state that advances under the functions' guards (a job's state changes; its history does not).
 */
export const JOB_TABLES = ['jobs', 'job_attempts', 'job_schedules', 'job_workers'] as const;

export const ALL_CLASSIFIED_TABLES: readonly string[] = [...Object.values(APPEND_ONLY_CLASSES).flat(), ...LEGACY_TABLES, ...MUTABLE_OPERATIONAL_TABLES, ...AUTHORITY_TABLES, ...PATIENT_IDENTITY_TABLES, ...PATIENT_DUPLICATE_TABLES, ...SECURITY_AUDIT_TABLES, ...JOB_TABLES];
