-- Refuse to drop structured evaluations, including under the non-superuser migrator. Repair forward.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE evaluations NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evaluations WHERE source_kind <> 'pdf-capture') THEN
    RAISE EXCEPTION 'Refusing to drop evaluations that rest on a structured revision. Repair forward.';
  END IF;
END $$;
ALTER TABLE evaluations FORCE ROW LEVEL SECURITY;

ALTER TABLE data_provenance DROP CONSTRAINT data_provenance_parent_kind;
ALTER TABLE data_provenance ADD CONSTRAINT data_provenance_parent_kind CHECK (
  (subject_kind = 'capture' AND parent_kind = 'report')
  OR (subject_kind = 'evaluation' AND parent_kind IN ('capture-acceptance', 'capture')));

ALTER TABLE evaluations DROP CONSTRAINT evaluations_hold_code_kind;
ALTER TABLE evaluations DROP CONSTRAINT evaluations_hold_code;
ALTER TABLE evaluations ADD CONSTRAINT evaluations_hold_code CHECK (hold_code IS NULL OR hold_code IN (
  'capture-not-accepted', 'capture-hash-mismatch', 'poppler-version-mismatch', 'reader-binding-mismatch', 'packet-invalid', 'evidence-overlap',
  'unsupported-layout', 'alignment-unsupported', 'unsupported-column-layout', 'unaccounted-text', 'mixed-frame-set', 'selector-quarantined',
  'source-limit', 'candidate-or-frame-limit', 'source-time-budget', 'worker-error'));
ALTER TABLE evaluations DROP CONSTRAINT evaluations_hold_consistent;
ALTER TABLE evaluations ADD CONSTRAINT evaluations_hold_consistent CHECK (
  (disposition = 'held' AND hold_code IS NOT NULL AND gene_inputs = '[]'::jsonb AND occurrences = '[]'::jsonb)
  OR (disposition = 'evaluated' AND hold_code IS NULL AND capture_acceptance_id IS NOT NULL));

CREATE OR REPLACE FUNCTION data_provenance_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  found boolean;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A provenance row must be by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  CASE NEW.parent_kind
    WHEN 'report'             THEN SELECT true INTO found FROM public.reports r WHERE r.id = NEW.parent_id AND r.tenant_id = NEW.tenant_id;
    WHEN 'capture'            THEN SELECT true INTO found FROM public.report_captures r WHERE r.id = NEW.parent_id AND r.tenant_id = NEW.tenant_id;
    WHEN 'capture-acceptance' THEN SELECT true INTO found FROM public.capture_acceptances r WHERE r.id = NEW.parent_id AND r.tenant_id = NEW.tenant_id;
    ELSE found := false;
  END CASE;
  IF found IS NOT TRUE THEN
    RAISE EXCEPTION 'The parent asset of a provenance row must exist in the same organization.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION evaluations_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; a record;
BEGIN
  SELECT report_id INTO c FROM public.report_captures WHERE id = NEW.capture_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR c.report_id <> NEW.report_id THEN
    RAISE EXCEPTION 'The capture does not belong to this report.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.capture_acceptance_id IS NOT NULL THEN
    SELECT decision, capture_id, seq INTO a FROM public.capture_acceptances WHERE id = NEW.capture_acceptance_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR a.capture_id <> NEW.capture_id THEN
      RAISE EXCEPTION 'The acceptance does not belong to this capture.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.disposition = 'evaluated' AND (a.decision <> 'accepted' OR EXISTS (
         SELECT 1 FROM public.capture_acceptances later WHERE later.capture_id = NEW.capture_id AND later.tenant_id = NEW.tenant_id AND later.seq > a.seq)) THEN
      RAISE EXCEPTION 'An evaluation relies on the latest decision about its capture, and it must be an acceptance.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP INDEX evaluations_structured_revision_idx;
ALTER TABLE evaluations DROP CONSTRAINT evaluations_structured_revision_fk;
ALTER TABLE evaluations DROP CONSTRAINT evaluations_source_consistent;
ALTER TABLE evaluations DROP CONSTRAINT evaluations_source_kind;
ALTER TABLE evaluations ALTER COLUMN capture_id SET NOT NULL;
ALTER TABLE evaluations DROP COLUMN structured_revision_id, DROP COLUMN source_kind;
ALTER TABLE structured_report_revisions DROP CONSTRAINT structured_report_revisions_id_tenant_uq;
