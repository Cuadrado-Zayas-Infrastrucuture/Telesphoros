/**
 * Every table of the audit design, by what it is allowed to do. A catalog test (test/db/ledger-catalog.pg-spec.ts) reads the live
 * database and fails when a table in the `public` schema is not classified here, or when a classified table lacks what its class requires.
 * Adding a table therefore forces a decision, in code review, about its protection.
 */
export const APPEND_ONLY_CLASSES = {
  /** One row per fact, with its own ledger event (`ledger_event_id`, `created_by`, `seq`). Insert-only for everyone. */
  record: ['report_captures', 'capture_acceptances', 'evaluations', 'corrections', 'cell_disputes', 'cell_dispute_decisions'],
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
export const AUTHORITY_TABLES = ['tenant_memberships'] as const;

/**
 * The security-event record (migration 0018): append-only, no privilege for the application role (it calls security_event_append()), readable only by the
 * auditor role. Not part of the clinical ledger and not clinical data.
 */
export const SECURITY_AUDIT_TABLES = ['security_events'] as const;

export const ALL_CLASSIFIED_TABLES: readonly string[] = [...Object.values(APPEND_ONLY_CLASSES).flat(), ...LEGACY_TABLES, ...MUTABLE_OPERATIONAL_TABLES, ...AUTHORITY_TABLES, ...SECURITY_AUDIT_TABLES];
