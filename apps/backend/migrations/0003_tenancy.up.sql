-- Tenancy: records belong to a TENANT (an organization whose members share them), not to one user.
--
--   owner_id   -> tenant_id   who may see the row (what row-level security binds on)
--   created_by (new)          the individual who created it, set by the server from the token
--
-- Existing rows keep working: each former owner simply becomes a tenant of one, and created_by is
-- backfilled with that same value, so no row changes who can see it. Neither column can change
-- after the row exists (trigger below), so a record can never move to another tenant.
--
-- The policy setting is renamed too (app.current_owner_id -> app.current_tenant_id). Any code still
-- setting the old name finds the new policies unmatched and sees no rows: it fails closed.

-- 1. Rename the scoping column and everything named after it.
ALTER TABLE patients        RENAME COLUMN owner_id TO tenant_id;
ALTER TABLE reports         RENAME COLUMN owner_id TO tenant_id;
ALTER TABLE recommendations RENAME COLUMN owner_id TO tenant_id;

ALTER TABLE patients        RENAME CONSTRAINT patients_owner_id_len        TO patients_tenant_id_len;
ALTER TABLE patients        RENAME CONSTRAINT patients_id_owner_uq         TO patients_id_tenant_uq;
ALTER TABLE reports         RENAME CONSTRAINT reports_owner_id_len         TO reports_tenant_id_len;
ALTER TABLE reports         RENAME CONSTRAINT reports_id_owner_uq          TO reports_id_tenant_uq;
ALTER TABLE recommendations RENAME CONSTRAINT recommendations_owner_id_len TO recommendations_tenant_id_len;

ALTER INDEX patients_owner_label_uq           RENAME TO patients_tenant_label_uq;
ALTER INDEX patients_owner_seq_idx            RENAME TO patients_tenant_seq_idx;
ALTER INDEX reports_owner_seq_idx             RENAME TO reports_tenant_seq_idx;
ALTER INDEX reports_owner_patient_idx         RENAME TO reports_tenant_patient_idx;
ALTER INDEX recommendations_owner_seq_idx     RENAME TO recommendations_tenant_seq_idx;
ALTER INDEX recommendations_owner_patient_idx RENAME TO recommendations_tenant_patient_idx;
ALTER INDEX recommendations_owner_report_idx  RENAME TO recommendations_tenant_report_idx;

-- 2. Add created_by and backfill it.
-- The tables are FORCE ROW LEVEL SECURITY, which also binds the role running this migration (the
-- policies name only telesphoros_app, so everyone else sees no rows). Lift it for the backfill and
-- restore it right after. The updated_at trigger is paused so history is not rewritten.
ALTER TABLE patients        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE reports         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE recommendations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE patients        DISABLE TRIGGER patients_set_updated_at;
ALTER TABLE reports         DISABLE TRIGGER reports_set_updated_at;
ALTER TABLE recommendations DISABLE TRIGGER recommendations_set_updated_at;

ALTER TABLE patients        ADD COLUMN created_by text;
ALTER TABLE reports         ADD COLUMN created_by text;
ALTER TABLE recommendations ADD COLUMN created_by text;
UPDATE patients        SET created_by = tenant_id;
UPDATE reports         SET created_by = tenant_id;
UPDATE recommendations SET created_by = tenant_id;
ALTER TABLE patients        ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE reports         ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE recommendations ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE patients        ADD CONSTRAINT patients_created_by_len        CHECK (length(created_by) BETWEEN 1 AND 128);
ALTER TABLE reports         ADD CONSTRAINT reports_created_by_len         CHECK (length(created_by) BETWEEN 1 AND 128);
ALTER TABLE recommendations ADD CONSTRAINT recommendations_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128);

ALTER TABLE patients        ENABLE TRIGGER patients_set_updated_at;
ALTER TABLE reports         ENABLE TRIGGER reports_set_updated_at;
ALTER TABLE recommendations ENABLE TRIGGER recommendations_set_updated_at;
ALTER TABLE patients        FORCE ROW LEVEL SECURITY;
ALTER TABLE reports         FORCE ROW LEVEL SECURITY;
ALTER TABLE recommendations FORCE ROW LEVEL SECURITY;

-- 3. A row never changes tenant or author. (Fires only when an UPDATE names these columns.)
CREATE FUNCTION forbid_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'tenant_id and created_by cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER patients_forbid_identity_change        BEFORE UPDATE OF tenant_id, created_by ON patients        FOR EACH ROW EXECUTE FUNCTION forbid_identity_change();
CREATE TRIGGER reports_forbid_identity_change         BEFORE UPDATE OF tenant_id, created_by ON reports         FOR EACH ROW EXECUTE FUNCTION forbid_identity_change();
CREATE TRIGGER recommendations_forbid_identity_change BEFORE UPDATE OF tenant_id, created_by ON recommendations FOR EACH ROW EXECUTE FUNCTION forbid_identity_change();

-- 4. Row-level security binds on the tenant now. Same shape as before: no setting, no rows.
DROP POLICY patients_owner        ON patients;
DROP POLICY reports_owner         ON reports;
DROP POLICY recommendations_owner ON recommendations;
CREATE POLICY patients_tenant ON patients FOR ALL TO telesphoros_app
  USING      (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY reports_tenant ON reports FOR ALL TO telesphoros_app
  USING      (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY recommendations_tenant ON recommendations FOR ALL TO telesphoros_app
  USING      (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
-- Grants are unchanged: SELECT/INSERT/UPDATE on patients and reports, SELECT/INSERT on recommendations.
