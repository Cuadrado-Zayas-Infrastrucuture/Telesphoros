-- Recreates the legacy `recommendations` table as it stood after 0013: empty. Rows dropped by the up migration do not come back.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE recommendations (
  seq               bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL,
  patient_id        uuid NOT NULL,
  report_id         uuid NOT NULL,
  gene              text NOT NULL,
  drug              text NOT NULL,
  phenotype         text NOT NULL,
  summary           text NOT NULL,
  strength          text NOT NULL,
  guideline_version text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  created_by        text NOT NULL,
  CONSTRAINT recommendations_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT recommendations_strength_valid CHECK (strength IN ('Strong', 'Moderate', 'Optional', 'No recommendation')),
  CONSTRAINT recommendations_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT recommendations_patient_fk FOREIGN KEY (patient_id, tenant_id)
    REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT recommendations_report_fk FOREIGN KEY (report_id, tenant_id)
    REFERENCES reports (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT recommendations_report_patient_fk FOREIGN KEY (tenant_id, patient_id, report_id)
    REFERENCES reports (tenant_id, patient_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX recommendations_tenant_seq_idx ON recommendations (tenant_id, seq) WHERE deleted_at IS NULL;
CREATE INDEX recommendations_tenant_patient_idx ON recommendations (tenant_id, patient_id) WHERE deleted_at IS NULL;
CREATE INDEX recommendations_tenant_report_idx ON recommendations (tenant_id, report_id) WHERE deleted_at IS NULL;
CREATE INDEX recommendations_patient_idx ON recommendations (patient_id);
CREATE INDEX recommendations_report_idx ON recommendations (report_id);
CREATE TRIGGER recommendations_set_updated_at BEFORE UPDATE ON recommendations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER recommendations_forbid_identity_change BEFORE UPDATE OF tenant_id, created_by ON recommendations FOR EACH ROW EXECUTE FUNCTION forbid_identity_change();

ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations FORCE ROW LEVEL SECURITY;
-- The policy as 0032 left it: bound through app_tenant(), not the setting 0003 used. 0032 counts these policies when it is reverted.
CREATE POLICY recommendations_tenant ON recommendations FOR ALL TO telesphoros_app
  USING      (tenant_id = (SELECT public.app_tenant()))
  WITH CHECK (tenant_id = (SELECT public.app_tenant()));
REVOKE ALL ON recommendations FROM PUBLIC;
GRANT SELECT, INSERT ON recommendations TO telesphoros_app;

-- Owned by whoever owns `reports`, like the sibling tables, whichever role runs this revert: a table left owned by another role makes the next
-- migration's policy rewrite (0032) try to switch to a role the migrator cannot become.
DO $$
BEGIN
  EXECUTE format('ALTER TABLE recommendations OWNER TO %I', (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'public.reports'::regclass));
END $$;

-- The guard from 0008, with the recommendations check again.
CREATE OR REPLACE FUNCTION block_report_soft_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM recommendations WHERE report_id = OLD.id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'report still has live recommendations' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM evaluations WHERE report_id = OLD.id) THEN
    RAISE EXCEPTION 'report has evaluations' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
