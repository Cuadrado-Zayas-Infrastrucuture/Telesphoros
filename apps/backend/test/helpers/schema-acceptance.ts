import type { Client } from 'pg';

// Hand-reviewed against the relationship design and original SQL, not generated from the live catalog.
// Global containment clearances intentionally lack tenant-composite FKs: their functions check scope.
const relationships: [string, string, string, string][] = [
  ['tenant_memberships_tenant_fk', 'tenant_memberships', 'tenant_id', 'tenants:id'],
  ['invitations_tenant_id_fkey', 'invitations', 'tenant_id', 'tenants:id'],
  ['patient_identifiers_patient_fk', 'patient_identifiers', 'patient_id,tenant_id', 'patients:id,tenant_id'],
  ['report_patient_decisions_report_fk', 'report_patient_decisions', 'tenant_id,patient_id,report_id', 'reports:tenant_id,patient_id,id'],
  ['report_patient_decisions_identifier_fk', 'report_patient_decisions', 'identifier_id,tenant_id,patient_id', 'patient_identifiers:id,tenant_id,patient_id'],
  ['upload_attempt_report_fk', 'report_upload_attempts', 'tenant_id,patient_id,report_id', 'reports:tenant_id,patient_id,id'],
  ['upload_attempt_run_fk', 'report_upload_attempts', 'tenant_id,run_id', 'report_upload_runs:tenant_id,run_id'],
  ['reports_patient_fk', 'reports', 'patient_id,tenant_id', 'patients:id,tenant_id'],
  ['recommendations_patient_fk', 'recommendations', 'patient_id,tenant_id', 'patients:id,tenant_id'],
  ['recommendations_report_fk', 'recommendations', 'report_id,tenant_id', 'reports:id,tenant_id'],
  ['recommendations_report_patient_fk', 'recommendations', 'tenant_id,patient_id,report_id', 'reports:tenant_id,patient_id,id'],
  ['report_captures_report_fk', 'report_captures', 'report_id,tenant_id', 'reports:id,tenant_id'],
  ['capture_acceptances_capture_fk', 'capture_acceptances', 'capture_id,tenant_id', 'report_captures:id,tenant_id'],
  ['capture_acceptances_note_fk', 'capture_acceptances', 'note_id,tenant_id', 'event_notes:id,tenant_id'],
  ['evaluations_patient_fk', 'evaluations', 'patient_id,tenant_id', 'patients:id,tenant_id'],
  ['evaluations_report_fk', 'evaluations', 'report_id,patient_id,tenant_id', 'reports:id,patient_id,tenant_id'],
  ['evaluations_capture_fk', 'evaluations', 'capture_id,tenant_id', 'report_captures:id,tenant_id'],
  ['evaluations_acceptance_fk', 'evaluations', 'capture_acceptance_id,tenant_id', 'capture_acceptances:id,tenant_id'],
  ['evaluation_results_evaluation_fk', 'evaluation_results', 'evaluation_id,tenant_id', 'evaluations:id,tenant_id'],
  ['evaluation_gene_states_evaluation_fk', 'evaluation_gene_states', 'evaluation_id,tenant_id', 'evaluations:id,tenant_id'],
  ['corrections_evaluation_fk', 'corrections', 'evaluation_id,tenant_id,report_id', 'evaluations:id,tenant_id,report_id'],
  ['corrections_replacement_fk', 'corrections', 'replacement_evaluation_id,tenant_id,report_id', 'evaluations:id,tenant_id,report_id'],
  ['corrections_previous_fk', 'corrections', 'previous_correction_id,evaluation_id,tenant_id', 'corrections:id,evaluation_id,tenant_id'],
  ['corrections_note_fk', 'corrections', 'note_id,tenant_id', 'event_notes:id,tenant_id'],
  ['cell_disputes_note_fk', 'cell_disputes', 'note_id,tenant_id', 'event_notes:id,tenant_id'],
  ['cell_dispute_decisions_dispute_fk', 'cell_dispute_decisions', 'dispute_id,tenant_id', 'cell_disputes:id,tenant_id'],
  ['cell_dispute_decisions_note_fk', 'cell_dispute_decisions', 'evidence_note_id,tenant_id', 'event_notes:id,tenant_id'],
  ['ledger_clearances_incident_fk', 'ledger_incident_clearances', 'incident_id', 'ledger_incidents:id'],
  ['ledger_clearances_checkpoint_fk', 'ledger_incident_clearances', 'verified_checkpoint_id', 'ledger_checkpoints:id'],
];
const primaryKeys: Record<string, string> = {
  report_upload_runs: 'run_id', report_upload_attempts: 'id',
  patients: 'id', reports: 'id', recommendations: 'id', schema_migrations: 'version',
  ledger_heads: 'tenant_id', ledger_events: 'id', ledger_checkpoints: 'id', event_notes: 'id',
  report_captures: 'id', capture_acceptances: 'id', evaluations: 'id', evaluation_results: 'id',
  evaluation_gene_states: 'id', corrections: 'id', cell_disputes: 'id', cell_dispute_decisions: 'id',
  ledger_incidents: 'id', ledger_incident_clearances: 'id', tenant_memberships: 'tenant_id, sub',
  security_audit_events: 'id', security_events: 'id', tenants: 'id', invitations: 'id',
  patient_identifiers: 'id', report_patient_decisions: 'id',
};
const uniqueKeys: Record<string, string> = {
  report_upload_runs_tenant_id_run_id_key: 'tenant_id, run_id', upload_attempt_request_uq: 'tenant_id, report_id, principal, request_id', upload_attempt_key_uq: 'storage_key',
  patients_id_tenant_uq: 'id, tenant_id', reports_id_tenant_uq: 'id, tenant_id',
  reports_creation_request_uq: 'tenant_id, created_by, creation_request_id',
  reports_id_patient_tenant_uq: 'id, patient_id, tenant_id', reports_tenant_patient_id_uq: 'tenant_id, patient_id, id',
  ledger_events_id_tenant_uq: 'id, tenant_id', ledger_events_subject_uq: 'subject_table, subject_id',
  ledger_events_tenant_prev_uq: 'tenant_id, prev_hash', ledger_events_tenant_seq_uq: 'tenant_id, seq',
  ledger_checkpoints_id_tenant_uq: 'id, tenant_id', event_notes_id_tenant_uq: 'id, tenant_id',
  report_captures_id_tenant_uq: 'id, tenant_id', report_captures_identity_uq: 'tenant_id, report_id, text_sha256, poppler_version',
  report_captures_text_key_uq: 'text_storage_key', capture_acceptances_id_tenant_uq: 'id, tenant_id',
  evaluations_id_tenant_report_uq: 'id, tenant_id, report_id', evaluations_id_tenant_uq: 'id, tenant_id',
  evaluations_identity_uq: 'tenant_id, identity_key', evaluation_results_ordinal_uq: 'evaluation_id, ordinal',
  evaluation_gene_states_gene_uq: 'evaluation_id, gene', corrections_id_eval_tenant_uq: 'id, evaluation_id, tenant_id',
  corrections_id_tenant_uq: 'id, tenant_id', cell_disputes_id_tenant_uq: 'id, tenant_id',
  cell_dispute_decisions_dispute_uq: 'dispute_id', cell_dispute_decisions_id_tenant_uq: 'id, tenant_id',
  ledger_clearances_incident_uq: 'incident_id', security_events_seq_uq: 'seq',
  patient_identifiers_id_tenant_patient_uq: 'id, tenant_id, patient_id', report_patient_decisions_id_tenant_uq: 'id, tenant_id',
};
// Complete CHECK inventory; semantic refusal/control tests remain in the existing behavior suites.
const checkNames: Record<string, string> = {
  patient_identifiers: 'tenant_id_len created_by_len system_shape digest_len key_version status withdrawal_shape withdrawn_by_len',
  report_patient_decisions: 'tenant_id_len created_by_len hash version_len decision method shape',
  tenants: 'id_len display_name_len status_check created_by_len changed_by_len',
  invitations: 'digest_len hint_len roles_check status_check created_by_len decided_shape fulfilled_sub_len',
  security_events: 'tenant_id_len type_check outcome_check actor_kind_check actor_ref_len subject_kind_check subject_ref_len request_id_len db_user_len details_shape',
  tenant_memberships: 'tenant_id_len sub_len status_check roles_check version_check changed_by_len reason_len',
  report_upload_runs: 'reserved_bytes_check',
  report_upload_attempts: 'principal_check type_check size_bytes_check content_type_check sha256_check storage_key_check state_check object_version_check',
  upload_attempt: 'committed_pin',
  patients: 'created_by_len label_format tenant_id_len',
  reports: 'created_by_len creation_request_pair filename_format lab_pdf_pinned object_version_valid pin_after_upload sha256_format size_range status_valid tenant_id_len type_valid upload_consistent upload_requested_by_len uploaded_by_len',
  recommendations: 'created_by_len strength_valid tenant_id_len',
  report_captures: 'created_by_len hashes key_len poppler runner scalars tenant_id_len',
  capture_acceptances: 'created_by_len decision poppler tenant_id_len text_hash',
  evaluations: 'created_by_len disposition engine_version_len hash_formats hold_code hold_consistent json_shapes tenant_id_len',
  evaluation_results: 'citation_ids json ordinal outcome reason shape strength',
  evaluation_gene_states: 'gene reason shape state',
  corrections: 'created_by_len kind note_required reason_for_kind reinstatement_chain replacement tenant_id_len',
  cell_disputes: 'created_by_len hash labels tenant_id_len',
  cell_dispute_decisions: 'created_by_len decision tenant_id_len',
  event_notes: 'basis body_len created_by_len digest_format redaction_consistent tenant_id_len',
  ledger_checkpoints: 'head_format mode tenant_id_len up_to',
  ledger_events: 'actor_len hash_formats no_separator seq_positive tenant_id_len type_subject type_valid versions',
  ledger_heads: 'hash_format seq_nonneg tenant_id_len',
  ledger_incidents: 'basis failed_seq kind recorded_by scope scope_tenant source tenant_len',
  ledger_clearances: 'basis cleared_by', // constraint prefix differs from table ledger_incident_clearances
  security_audit: 'identity kind request route',
};
for (const table of ['report_captures', 'capture_acceptances', 'evaluations', 'corrections', 'cell_disputes', 'cell_dispute_decisions', 'report_patient_decisions', 'ledger_checkpoints']) {
  relationships.push([`${table}_event_fk`, table, 'ledger_event_id,tenant_id', 'ledger_events:id,tenant_id']);
}

// Query-facing definitions. Constraint-backed indexes and internal append-only guards are also covered by ledger-catalog/behavior suites.
const queryIndexes: Record<string, string> = {
  upload_attempt_run_idx: 'INDEX upload_attempt_run_idx ON public.report_upload_attempts USING btree (tenant_id, run_id, state)',
  patients_tenant_label_uq: 'UNIQUE INDEX patients_tenant_label_uq ON public.patients USING btree (tenant_id, lower(label)) WHERE (deleted_at IS NULL)',
  patients_tenant_seq_idx: 'INDEX patients_tenant_seq_idx ON public.patients USING btree (tenant_id, seq) WHERE (deleted_at IS NULL)',
  reports_tenant_seq_idx: 'INDEX reports_tenant_seq_idx ON public.reports USING btree (tenant_id, seq) WHERE (deleted_at IS NULL)',
  reports_tenant_patient_idx: 'INDEX reports_tenant_patient_idx ON public.reports USING btree (tenant_id, patient_id) WHERE (deleted_at IS NULL)',
  reports_storage_key_uq: 'UNIQUE INDEX reports_storage_key_uq ON public.reports USING btree (storage_key) WHERE (storage_key IS NOT NULL)',
  reports_tenant_patient_id_uq: 'UNIQUE INDEX reports_tenant_patient_id_uq ON public.reports USING btree (tenant_id, patient_id, id)',
  recommendations_tenant_seq_idx: 'INDEX recommendations_tenant_seq_idx ON public.recommendations USING btree (tenant_id, seq) WHERE (deleted_at IS NULL)',
  recommendations_tenant_patient_idx: 'INDEX recommendations_tenant_patient_idx ON public.recommendations USING btree (tenant_id, patient_id) WHERE (deleted_at IS NULL)',
  recommendations_tenant_report_idx: 'INDEX recommendations_tenant_report_idx ON public.recommendations USING btree (tenant_id, report_id) WHERE (deleted_at IS NULL)',
  report_captures_tenant_report_idx: 'INDEX report_captures_tenant_report_idx ON public.report_captures USING btree (tenant_id, report_id, seq)',
  capture_acceptances_tenant_capture_idx: 'INDEX capture_acceptances_tenant_capture_idx ON public.capture_acceptances USING btree (tenant_id, capture_id, seq)',
  evaluations_tenant_report_idx: 'INDEX evaluations_tenant_report_idx ON public.evaluations USING btree (tenant_id, report_id, seq)',
  evaluations_tenant_patient_idx: 'INDEX evaluations_tenant_patient_idx ON public.evaluations USING btree (tenant_id, patient_id, seq)',
  evaluation_results_tenant_evaluation_idx: 'INDEX evaluation_results_tenant_evaluation_idx ON public.evaluation_results USING btree (tenant_id, evaluation_id, ordinal)',
  evaluation_gene_states_tenant_evaluation_idx: 'INDEX evaluation_gene_states_tenant_evaluation_idx ON public.evaluation_gene_states USING btree (tenant_id, evaluation_id)',
  corrections_tenant_evaluation_idx: 'INDEX corrections_tenant_evaluation_idx ON public.corrections USING btree (tenant_id, evaluation_id, seq)',
  cell_disputes_tenant_guideline_idx: 'INDEX cell_disputes_tenant_guideline_idx ON public.cell_disputes USING btree (tenant_id, guideline_id, guideline_content_sha256)',
  cell_dispute_decisions_dispute_uq: 'UNIQUE INDEX cell_dispute_decisions_dispute_uq ON public.cell_dispute_decisions USING btree (dispute_id)',
  event_notes_tenant_seq_idx: 'INDEX event_notes_tenant_seq_idx ON public.event_notes USING btree (tenant_id, seq)',
  ledger_events_tenant_seq_uq: 'UNIQUE INDEX ledger_events_tenant_seq_uq ON public.ledger_events USING btree (tenant_id, seq)',
  ledger_checkpoints_tenant_seq_idx: 'INDEX ledger_checkpoints_tenant_seq_idx ON public.ledger_checkpoints USING btree (tenant_id, up_to_seq DESC)',
  ledger_incidents_tenant_idx: "INDEX ledger_incidents_tenant_idx ON public.ledger_incidents USING btree (tenant_id) WHERE (scope = 'tenant'::text)",
  security_events_tenant_time_idx: 'INDEX security_events_tenant_time_idx ON public.security_events USING btree (tenant_id, occurred_at)',
  security_events_refusal_idx: "INDEX security_events_refusal_idx ON public.security_events USING btree (tenant_id, actor_ref, ((details ->> 'reason'::text)), occurred_at DESC) WHERE (event_type = 'access.refused'::text)",
  invitations_one_pending_uq: "UNIQUE INDEX invitations_one_pending_uq ON public.invitations USING btree (tenant_id, email_digest) WHERE (status = 'pending'::text)",
  patient_identifiers_active_uq: "UNIQUE INDEX patient_identifiers_active_uq ON public.patient_identifiers USING btree (tenant_id, system, value_digest) WHERE (status = 'active'::text)",
  patient_identifiers_patient_idx: 'INDEX patient_identifiers_patient_idx ON public.patient_identifiers USING btree (tenant_id, patient_id, seq)',
  report_patient_decisions_report_idx: 'INDEX report_patient_decisions_report_idx ON public.report_patient_decisions USING btree (tenant_id, report_id, seq)',
  invitations_tenant_idx: 'INDEX invitations_tenant_idx ON public.invitations USING btree (tenant_id, created_at)',
  tenant_memberships_one_active_uq: "UNIQUE INDEX tenant_memberships_one_active_uq ON public.tenant_memberships USING btree (sub) WHERE (status = 'active'::text)",
  ledger_incidents_global_idx: "INDEX ledger_incidents_global_idx ON public.ledger_incidents USING btree (scope) WHERE (scope = 'global'::text)",
  security_audit_tenant_time: 'INDEX security_audit_tenant_time ON public.security_audit_events USING btree (tenant_id, occurred_at DESC, id) WHERE (tenant_id IS NOT NULL)',
  security_audit_request_id: 'INDEX security_audit_request_id ON public.security_audit_events USING btree (request_id)',
};

/** Reusable acceptance gate for a migrated or restored database; counts/names alone are insufficient. */
export async function assertSchemaAcceptance(c: Client): Promise<void> {
  const keys = (await c.query(`SELECT conrelid::regclass::text AS table_name, conname, contype, condeferrable, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('p','u')`)).rows;
  expect(Object.fromEntries(keys.filter(r => r.contype === 'p').map(r => [r.table_name, r.definition]))).toEqual(
    Object.fromEntries(Object.entries(primaryKeys).map(([table, columns]) => [table, `PRIMARY KEY (${columns})`])));
  expect(Object.fromEntries(keys.filter(r => r.contype === 'u').map(r => [r.conname, r.definition]))).toEqual(
    Object.fromEntries(Object.entries(uniqueKeys).map(([name, columns]) => [name, `UNIQUE (${columns})`])));
  expect(keys.filter(r => r.condeferrable)).toEqual([]);
  const fks = (await c.query(`SELECT conname, conrelid::regclass::text AS child, confrelid::regclass::text AS parent,
      ARRAY(SELECT attname::text FROM unnest(conkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.n ORDER BY o) AS child_columns,
      ARRAY(SELECT attname::text FROM unnest(confkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=confrelid AND a.attnum=k.n ORDER BY o) AS parent_columns,
      confdeltype, confupdtype, convalidated, condeferrable, condeferred
      FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace`)).rows;
  expect(fks.map(r => r.conname).sort()).toEqual(relationships.map(r => r[0]).sort());
  for (const [name, child, columns, reference] of relationships) {
    const [parent, parentColumns] = reference.split(':');
    const deferred = name.endsWith('_event_fk');
    expect(fks.find(r => r.conname === name)).toEqual({
      conname: name, child, parent, child_columns: columns.split(','), parent_columns: parentColumns!.split(','),
      confdeltype: 'r', confupdtype: ['recommendations_report_patient_fk', 'tenant_memberships_tenant_fk', 'invitations_tenant_id_fkey'].includes(name) ? 'r' : 'a',
      convalidated: true, condeferrable: deferred, condeferred: deferred,
    });
  }
  const constraints = (await c.query(`SELECT conname, contype, convalidated FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('c','f')`)).rows;
  expect(constraints.filter(r => r.contype === 'c').map(r => r.conname).sort()).toEqual(
    Object.entries(checkNames).flatMap(([prefix, names]) => names.split(' ').map(name => `${prefix}_${name}`)).sort());
  expect(constraints.filter(r => !r.convalidated).map(r => r.conname)).toEqual([]);
  const indexes = (await c.query(`SELECT ci.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid, i.indisready
    FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE ci.relnamespace='public'::regnamespace`)).rows;
  for (const [name, definition] of Object.entries(queryIndexes)) {
    expect(indexes.find(r => r.name === name)).toEqual({ name, definition: `CREATE ${definition}`, indisvalid: true, indisready: true });
  }
  expect((await c.query(`SELECT contype, condeferrable FROM pg_constraint WHERE conname='reports_tenant_patient_id_uq'`)).rows).toEqual([{ contype: 'u', condeferrable: false }]);
}
