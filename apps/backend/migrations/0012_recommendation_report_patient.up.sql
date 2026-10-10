-- Establish the engine-level patient/report invariant before scanning historical rows.
-- No data is changed. A failure in 0013 leaves this migration committed and new writes protected.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- The existing id/tenant uniqueness cannot enforce patient agreement as well.
ALTER TABLE reports ADD CONSTRAINT reports_tenant_patient_id_uq UNIQUE (tenant_id, patient_id, id);
ALTER TABLE recommendations ADD CONSTRAINT recommendations_report_patient_fk
  FOREIGN KEY (tenant_id, patient_id, report_id)
  REFERENCES reports (tenant_id, patient_id, id)
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
