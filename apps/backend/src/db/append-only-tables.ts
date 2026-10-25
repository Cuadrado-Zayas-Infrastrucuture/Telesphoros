/**
 * Every table of the audit design, by what it is allowed to do. A catalog test (test/db/ledger-catalog.pg-spec.ts) reads the live
 * database and fails when a table in the `public` schema is not classified here, or when a classified table lacks what its class requires.
 * Adding a table therefore forces a decision, in code review, about its protection.
 */
export const APPEND_ONLY_CLASSES = {
  /** One row per fact, with its own ledger event (`ledger_event_id`, `created_by`, `seq`). Insert-only for everyone. */
  record: [
    'report_captures',
    'capture_acceptances',
    'evaluations',
    'corrections',
    'cell_disputes',
    'cell_dispute_decisions',
    'report_patient_decisions',
    'patient_merge_proposals',
    'patient_merge_decisions',
  ],
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
export const LEGACY_TABLES = ['patients', 'reports', 'schema_migrations'] as const;

// Local operational state advances under CAS/identity guards; it is not a clinical append-only fact.
export const MUTABLE_OPERATIONAL_TABLES = ['report_upload_runs', 'report_upload_attempts'] as const;

/**
 * Authority state (migration 0017): who belongs to which organization with which roles. Written only by the operator command (the table's
 * owner); the application role can only read its own organization's rows. Rows are never deleted: a removed person's row is the revocation record.
 */
export const AUTHORITY_TABLES = ['tenant_memberships', 'tenants', 'invitations'] as const;

/** Short-lived encrypted browser credentials: tenant-scoped, immutable except terminal revocation; expired rows alone may be removed. */
export const BROWSER_SESSION_TABLES = ['browser_sessions'] as const;

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

/**
 * The transactional outbox and the stored-file re-check record (migration 0024), owned by the queue's definer role `telesphoros_jobs`. `outbox_events` is written by
 * the application only through `outbox_append` (inside the business transaction) and changes only by being relayed once; `outbox_routes` is reviewed configuration.
 * `file_verifications` is append-only for everyone, the owner included; the application can read its own organization's rows.
 */
export const OUTBOX_TABLES = ['outbox_events', 'outbox_routes'] as const;
export const VERIFICATION_TABLES = ['file_verifications'] as const;

/**
 * The tenant capability (migration 0028, DATA-01), owned by the NOLOGIN role `telesphoros_capability`. No login holds any privilege on these tables: the session
 * issuer writes only through `tenant_capability_issue`, and a request's binding is read only through `app_tenant()` / `app_actor()`. `capability_issuance_log` is
 * append-only (refuse_mutation); `tenant_capabilities` rows expire and are swept; `capability_purposes` and `tenant_binding_mode` are reviewed configuration.
 */
export const CAPABILITY_TABLES = ['tenant_capabilities', 'capability_issuance_log', 'capability_purposes', 'tenant_binding_mode'] as const;

/**
 * The inactive synthetic agentic fixtures (migration 0029, P2), owned by the NOLOGIN role `telesphoros_jobs`. No login holds a table privilege: the application and the
 * worker call the narrow `agentic_synthetic_*` functions only. Admission, run, reservation and bucket rows advance under those functions' guards; `agentic_synthetic_outcomes`,
 * `agentic_synthetic_audit` and the source rows are immutable. Seeded only by test owners; nothing here is clinical data or a ledger record.
 */
export const AGENTIC_SYNTHETIC_TABLES = [
  'agentic_synthetic_capacity',
  'agentic_synthetic_grants',
  'agentic_synthetic_sources',
  'agentic_synthetic_grant_sources',
  'agentic_synthetic_runs',
  'agentic_synthetic_reservations',
  'agentic_synthetic_buckets',
  'agentic_synthetic_invocations',
  'agentic_synthetic_outcomes',
  'agentic_synthetic_audit',
] as const;

/**
 * The receipts of explanation runs (migration 0048, LLM harness 3b-1), owned by the NOLOGIN role `telesphoros_jobs`. No login holds a table privilege: the application and the
 * worker call `agentic_explain_receipt_append`, `_read` and `_purge` only, each taking its caller from a presented capability. A receipt holds digests, fixed codes and counters
 * and no text (every text column is bound to a pattern); it is never updated, and a delete is refused until the row is 2190 days old.
 */
export const AGENTIC_EXPLAIN_TABLES = ['agentic_explain_receipts'] as const;

export const ALL_CLASSIFIED_TABLES: readonly string[] = [
  ...Object.values(APPEND_ONLY_CLASSES).flat(),
  ...LEGACY_TABLES,
  ...MUTABLE_OPERATIONAL_TABLES,
  ...AUTHORITY_TABLES,
  ...BROWSER_SESSION_TABLES,
  ...PATIENT_IDENTITY_TABLES,
  ...PATIENT_DUPLICATE_TABLES,
  ...SECURITY_AUDIT_TABLES,
  ...JOB_TABLES,
  ...OUTBOX_TABLES,
  ...VERIFICATION_TABLES,
  ...CAPABILITY_TABLES,
  ...AGENTIC_SYNTHETIC_TABLES,
  ...AGENTIC_EXPLAIN_TABLES,
];
