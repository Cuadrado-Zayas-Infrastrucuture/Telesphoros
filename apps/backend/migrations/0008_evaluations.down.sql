-- GUARD: removes audit records. See 0005 for how to allow it on purpose.
DO $$ BEGIN
  IF current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop evaluation records: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;
-- Restore the guard from 0001 first: the new one names the table about to be dropped.
CREATE OR REPLACE FUNCTION block_report_soft_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM recommendations WHERE report_id = OLD.id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'report still has live recommendations' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TABLE evaluation_gene_states;
DROP TABLE evaluation_results;
DROP TABLE evaluations;
DROP FUNCTION evaluations_check();
SET LOCAL ROLE telesphoros_ledger;
DROP FUNCTION evaluation_child_guard();
RESET ROLE;
ALTER TABLE reports DROP CONSTRAINT reports_id_patient_tenant_uq;
