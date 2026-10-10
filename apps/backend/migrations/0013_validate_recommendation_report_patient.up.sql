-- A separate committed step. Existing violations cause failure; no repair/quarantine runs here.
-- Stop on failure: the founder must approve a specific remediation before retrying this step.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE recommendations VALIDATE CONSTRAINT recommendations_report_patient_fk;
