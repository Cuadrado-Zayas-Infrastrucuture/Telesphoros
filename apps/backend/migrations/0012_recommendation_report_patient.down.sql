-- Schema rollback only: it does not remove or repair any record.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE recommendations DROP CONSTRAINT recommendations_report_patient_fk;
ALTER TABLE reports DROP CONSTRAINT reports_tenant_patient_id_uq;
