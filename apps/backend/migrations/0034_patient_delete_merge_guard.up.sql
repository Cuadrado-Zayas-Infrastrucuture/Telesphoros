-- compat: expand
-- Security audit 2026-10-19, candidate H3: a patient could be soft-deleted while a merge into it was being approved, leaving a merge in force into a patient
-- that is gone (its aliases hidden behind it, and the merge impossible to undo). The delete was guarded only by two earlier reads in the service, and the
-- merge decision was checked at COMMIT without holding the patient rows, so the two could interleave. Two additions, both new objects, nothing redefined:
--
-- 1. A deferred constraint trigger on patient_merge_decisions that runs BEFORE the graph rule at commit (triggers of one event fire in name order, and
--    "a_hold" sorts before "graph"). It takes FOR SHARE row locks on both patients of an approved merge, held to the end of the transaction. A delete of either
--    patient then waits for the approval to commit, and a delete already in flight is waited for here, so the graph rule that runs next sees it ('patient-gone').
-- 2. A BEFORE UPDATE trigger on patients that refuses to soft-delete a patient other patients were merged into (SQLSTATE PM002). Row triggers run after the
--    row lock is taken, so a delete that waited for an approval re-reads the committed merge and is refused.
-- An older image that deletes such a patient now gets PM002 where it used to corrupt the merge; it reports that as a server error rather than a 409.
CREATE FUNCTION patient_merge_decisions_hold() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  p record;
BEGIN
  IF NEW.decision <> 'approved' THEN RETURN NULL; END IF;
  SELECT kind, source_patient_id, target_patient_id INTO p FROM public.patient_merge_proposals WHERE id = NEW.proposal_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR p.kind <> 'merge' THEN RETURN NULL; END IF;
  -- Ordered by id so two approvals touching the same pair take the locks in the same order. FOR SHARE blocks a concurrent update of the row, not a read.
  PERFORM 1 FROM public.patients WHERE tenant_id = NEW.tenant_id AND id IN (p.source_patient_id, p.target_patient_id) ORDER BY id FOR SHARE;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER patient_merge_decisions_a_hold AFTER INSERT ON patient_merge_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION patient_merge_decisions_hold();

CREATE FUNCTION patients_guard_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM public.patient_alias_edges(NEW.tenant_id) WHERE target_patient_id = NEW.id) THEN
    RAISE EXCEPTION 'patient-has-merged-records' USING ERRCODE = 'PM002';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER patients_guard_delete BEFORE UPDATE OF deleted_at ON patients
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION patients_guard_delete();
