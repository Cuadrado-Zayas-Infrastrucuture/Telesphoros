-- PostgreSQL has no "unvalidate" command; recreate the same enforced, unvalidated relationship.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE recommendations DROP CONSTRAINT recommendations_report_patient_fk;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_report_patient_fk
  FOREIGN KEY (tenant_id, patient_id, report_id)
  REFERENCES reports (tenant_id, patient_id, id)
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
