-- Reverts tenancy. created_by is dropped, so who created each row is lost; tenant_id goes back to
-- owner_id with the same values (a former one-user "tenant" is simply that user's owner id again).
DROP POLICY recommendations_tenant ON recommendations;
DROP POLICY reports_tenant         ON reports;
DROP POLICY patients_tenant        ON patients;
DROP TRIGGER recommendations_forbid_identity_change ON recommendations;
DROP TRIGGER reports_forbid_identity_change         ON reports;
DROP TRIGGER patients_forbid_identity_change        ON patients;
DROP FUNCTION forbid_identity_change();

ALTER TABLE recommendations DROP CONSTRAINT recommendations_created_by_len;
ALTER TABLE reports         DROP CONSTRAINT reports_created_by_len;
ALTER TABLE patients        DROP CONSTRAINT patients_created_by_len;
ALTER TABLE recommendations DROP COLUMN created_by;
ALTER TABLE reports         DROP COLUMN created_by;
ALTER TABLE patients        DROP COLUMN created_by;

ALTER INDEX recommendations_tenant_report_idx  RENAME TO recommendations_owner_report_idx;
ALTER INDEX recommendations_tenant_patient_idx RENAME TO recommendations_owner_patient_idx;
ALTER INDEX recommendations_tenant_seq_idx     RENAME TO recommendations_owner_seq_idx;
ALTER INDEX reports_tenant_patient_idx         RENAME TO reports_owner_patient_idx;
ALTER INDEX reports_tenant_seq_idx             RENAME TO reports_owner_seq_idx;
ALTER INDEX patients_tenant_seq_idx            RENAME TO patients_owner_seq_idx;
ALTER INDEX patients_tenant_label_uq           RENAME TO patients_owner_label_uq;

ALTER TABLE recommendations RENAME CONSTRAINT recommendations_tenant_id_len TO recommendations_owner_id_len;
ALTER TABLE reports         RENAME CONSTRAINT reports_id_tenant_uq          TO reports_id_owner_uq;
ALTER TABLE reports         RENAME CONSTRAINT reports_tenant_id_len         TO reports_owner_id_len;
ALTER TABLE patients        RENAME CONSTRAINT patients_id_tenant_uq         TO patients_id_owner_uq;
ALTER TABLE patients        RENAME CONSTRAINT patients_tenant_id_len        TO patients_owner_id_len;

ALTER TABLE recommendations RENAME COLUMN tenant_id TO owner_id;
ALTER TABLE reports         RENAME COLUMN tenant_id TO owner_id;
ALTER TABLE patients        RENAME COLUMN tenant_id TO owner_id;

-- Last: the policies refer to owner_id, which exists again only after the renames above.
CREATE POLICY patients_owner ON patients FOR ALL TO telesphoros_app
  USING      (owner_id = current_setting('app.current_owner_id', true))
  WITH CHECK (owner_id = current_setting('app.current_owner_id', true));
CREATE POLICY reports_owner ON reports FOR ALL TO telesphoros_app
  USING      (owner_id = current_setting('app.current_owner_id', true))
  WITH CHECK (owner_id = current_setting('app.current_owner_id', true));
CREATE POLICY recommendations_owner ON recommendations FOR ALL TO telesphoros_app
  USING      (owner_id = current_setting('app.current_owner_id', true))
  WITH CHECK (owner_id = current_setting('app.current_owner_id', true));
