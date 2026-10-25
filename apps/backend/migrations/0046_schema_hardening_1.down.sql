-- Restores the state 0045 left. No data is touched, so nothing needs refusing.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DROP POLICY security_events_auditor ON security_events;
ALTER TABLE security_events DISABLE ROW LEVEL SECURITY;

DROP POLICY upload_attempt_tenant ON report_upload_attempts;
CREATE POLICY upload_attempt_tenant ON report_upload_attempts
  USING (tenant_id = (SELECT app_tenant())) WITH CHECK (tenant_id = (SELECT app_tenant()));
DROP POLICY upload_run_tenant ON report_upload_runs;
CREATE POLICY upload_run_tenant ON report_upload_runs
  USING (tenant_id = (SELECT app_tenant())) WITH CHECK (tenant_id = (SELECT app_tenant()));

ALTER TABLE evaluation_results
  DROP CONSTRAINT evaluation_results_citation_size,
  DROP CONSTRAINT evaluation_results_gene_evidence_size;
ALTER TABLE evaluations
  DROP CONSTRAINT evaluations_gene_inputs_size,
  DROP CONSTRAINT evaluations_binding_size,
  DROP CONSTRAINT evaluations_occurrences_size;
