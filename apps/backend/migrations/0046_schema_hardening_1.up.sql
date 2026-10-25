-- compat: breaking
-- Three small database-side hardening steps from the 2026-10-24 schema assessment (items 7, 11 and 12). Nothing here moves or rewrites a row.
-- 7: the two immutable evaluation tables had a type check on their JSON columns but no size cap, so one oversized row could never be corrected. The caps are on the stored
--    size of the JSON text (octet_length, which does not shrink when the value compresses, as pg_column_size does). They are ASSUMED generous: nothing in the engine bounds these payloads, so they sit far above
--    anything the 200-gene input limit produces. Added NOT VALID and validated straight after, so the check covers existing rows too.
-- 11: the two upload policies were TO PUBLIC; every other policy names its roles. Same predicate, now only for the roles that hold a grant on the tables.
-- 12: security_events had row-level security off. Not forced (its writers are SECURITY DEFINER functions and a trigger owned by the migrator, which must keep writing);
--     the auditor, the only login with a privilege, gets an explicit policy, so a privilege granted to any other role by mistake would still read nothing.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE evaluations
  ADD CONSTRAINT evaluations_occurrences_size CHECK (octet_length(occurrences::text) <= 1048576) NOT VALID,
  ADD CONSTRAINT evaluations_binding_size CHECK (octet_length(binding::text) <= 16384) NOT VALID,
  ADD CONSTRAINT evaluations_gene_inputs_size CHECK (octet_length(gene_inputs::text) <= 262144) NOT VALID;
ALTER TABLE evaluations VALIDATE CONSTRAINT evaluations_occurrences_size;
ALTER TABLE evaluations VALIDATE CONSTRAINT evaluations_binding_size;
ALTER TABLE evaluations VALIDATE CONSTRAINT evaluations_gene_inputs_size;

ALTER TABLE evaluation_results
  ADD CONSTRAINT evaluation_results_gene_evidence_size CHECK (octet_length(gene_evidence::text) <= 262144) NOT VALID,
  ADD CONSTRAINT evaluation_results_citation_size CHECK (citation IS NULL OR octet_length(citation::text) <= 16384) NOT VALID;
ALTER TABLE evaluation_results VALIDATE CONSTRAINT evaluation_results_gene_evidence_size;
ALTER TABLE evaluation_results VALIDATE CONSTRAINT evaluation_results_citation_size;

DROP POLICY upload_run_tenant ON report_upload_runs;
CREATE POLICY upload_run_tenant ON report_upload_runs TO telesphoros_app, telesphoros_jobs
  USING (tenant_id = (SELECT app_tenant())) WITH CHECK (tenant_id = (SELECT app_tenant()));
DROP POLICY upload_attempt_tenant ON report_upload_attempts;
CREATE POLICY upload_attempt_tenant ON report_upload_attempts TO telesphoros_app, telesphoros_jobs
  USING (tenant_id = (SELECT app_tenant())) WITH CHECK (tenant_id = (SELECT app_tenant()));

ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_events_auditor ON security_events FOR SELECT TO telesphoros_security_auditor USING (true);
