-- compat: breaking
-- An evaluation may now rest on a stored structured laboratory revision (032 S3) instead of an accepted PDF capture. Every existing row is a
-- 'pdf-capture' evaluation and keeps its meaning; nothing here produces a structured evaluation (that is the next slice). Widening a check is a drop and
-- re-add, hence the label: the ledger verifier must read an evaluation without a capture before any such row is written.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- A revision can be named together with its organization by a composite foreign key, as every other ledger record names its parents.
ALTER TABLE structured_report_revisions ADD CONSTRAINT structured_report_revisions_id_tenant_uq UNIQUE (id, tenant_id);

ALTER TABLE evaluations
  ADD COLUMN source_kind text NOT NULL DEFAULT 'pdf-capture',
  ADD COLUMN structured_revision_id uuid,
  ALTER COLUMN capture_id DROP NOT NULL;
-- The default stays: the API and the worker that are still running while this migrates insert evaluations without naming a source, and every one of
-- those is a PDF evaluation.

ALTER TABLE evaluations ADD CONSTRAINT evaluations_source_kind CHECK (source_kind IN ('pdf-capture', 'structured-revision'));
-- One source or the other, never both and never neither. A structured evaluation has no capture and therefore no capture acceptance; the independent
-- review it rests on is the revision's own findings review.
ALTER TABLE evaluations ADD CONSTRAINT evaluations_source_consistent CHECK (
  (source_kind = 'pdf-capture' AND capture_id IS NOT NULL AND structured_revision_id IS NULL)
  OR (source_kind = 'structured-revision' AND capture_id IS NULL AND capture_acceptance_id IS NULL AND structured_revision_id IS NOT NULL));
ALTER TABLE evaluations ADD CONSTRAINT evaluations_structured_revision_fk
  FOREIGN KEY (structured_revision_id, tenant_id) REFERENCES structured_report_revisions (id, tenant_id) ON DELETE RESTRICT;
CREATE INDEX evaluations_structured_revision_idx ON evaluations (structured_revision_id) WHERE structured_revision_id IS NOT NULL;

ALTER TABLE evaluations DROP CONSTRAINT evaluations_hold_consistent;
ALTER TABLE evaluations ADD CONSTRAINT evaluations_hold_consistent CHECK (
  (disposition = 'held' AND hold_code IS NOT NULL AND gene_inputs = '[]'::jsonb AND occurrences = '[]'::jsonb)
  OR (disposition = 'evaluated' AND hold_code IS NULL AND (source_kind = 'structured-revision' OR capture_acceptance_id IS NOT NULL)));

ALTER TABLE evaluations DROP CONSTRAINT evaluations_hold_code;
ALTER TABLE evaluations ADD CONSTRAINT evaluations_hold_code CHECK (hold_code IS NULL OR hold_code IN (
  'capture-not-accepted', 'capture-hash-mismatch', 'poppler-version-mismatch', 'reader-binding-mismatch', 'packet-invalid', 'evidence-overlap',
  'unsupported-layout', 'alignment-unsupported', 'unsupported-column-layout', 'unaccounted-text', 'mixed-frame-set', 'selector-quarantined',
  'source-limit', 'candidate-or-frame-limit', 'source-time-budget', 'worker-error',
  'findings-not-reviewed', 'source-conflict', 'unresolved-finding', 'missing-prerequisite', 'unsupported-source'));

-- An evaluation's provenance names its parent asset. A structured evaluation's parent is the stored revision (its document hash is the revision's source hash).
ALTER TABLE data_provenance DROP CONSTRAINT data_provenance_parent_kind;
ALTER TABLE data_provenance ADD CONSTRAINT data_provenance_parent_kind CHECK (
  (subject_kind = 'capture' AND parent_kind = 'report')
  OR (subject_kind = 'evaluation' AND parent_kind IN ('capture-acceptance', 'capture', 'structured-revision')));

-- The parent asset of a provenance row must exist in the organization; a structured revision is now one.
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
    WHEN 'structured-revision' THEN SELECT true INTO found FROM public.structured_report_revisions r WHERE r.id = NEW.parent_id AND r.tenant_id = NEW.tenant_id;
    ELSE found := false;
  END CASE;
  IF found IS NOT TRUE THEN
    RAISE EXCEPTION 'The parent asset of a provenance row must exist in the same organization.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;

-- A hold code belongs to the kind of source it describes. 'worker-error' is the one generic code both kinds may carry.
ALTER TABLE evaluations ADD CONSTRAINT evaluations_hold_code_kind CHECK (hold_code IS NULL
  OR hold_code = 'worker-error'
  OR (source_kind = 'pdf-capture' AND hold_code IN (
    'capture-not-accepted', 'capture-hash-mismatch', 'poppler-version-mismatch', 'reader-binding-mismatch', 'packet-invalid', 'evidence-overlap',
    'unsupported-layout', 'alignment-unsupported', 'unsupported-column-layout', 'unaccounted-text', 'mixed-frame-set', 'selector-quarantined',
    'source-limit', 'candidate-or-frame-limit', 'source-time-budget'))
  OR (source_kind = 'structured-revision' AND hold_code IN ('findings-not-reviewed', 'source-conflict', 'unresolved-finding', 'missing-prerequisite', 'unsupported-source')));

-- The capture rules apply to a PDF evaluation exactly as before. A structured evaluation must name a revision of this organization that belongs to the
-- same report and patient; whether its findings were independently reviewed is the storing service's check, re-made under the ledger lock.
CREATE OR REPLACE FUNCTION evaluations_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; a record; s record;
BEGIN
  IF NEW.source_kind = 'structured-revision' THEN
    SELECT report_id, patient_id INTO s FROM public.structured_report_revisions WHERE id = NEW.structured_revision_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR s.report_id <> NEW.report_id OR s.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'The structured revision does not belong to this report and patient.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
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
