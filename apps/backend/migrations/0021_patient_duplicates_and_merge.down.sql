-- GUARD: removes audit records (merge proposals and decisions) and duplicate flags. See 0005 for how to allow it on purpose.
DO $$ BEGIN
  IF current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop patient merge records and duplicate flags: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

CREATE OR REPLACE FUNCTION ledger_event_row_exists() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ok boolean;
BEGIN
  CASE NEW.subject_table
    WHEN 'report_captures' THEN
      SELECT true INTO ok FROM public.report_captures r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'capture_acceptances' THEN
      SELECT true INTO ok FROM public.capture_acceptances r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'evaluations' THEN
      SELECT true INTO ok FROM public.evaluations r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'corrections' THEN
      SELECT true INTO ok FROM public.corrections r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'cell_disputes' THEN
      SELECT true INTO ok FROM public.cell_disputes r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'cell_dispute_decisions' THEN
      SELECT true INTO ok FROM public.cell_dispute_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'report_patient_decisions' THEN
      SELECT true INTO ok FROM public.report_patient_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'ledger_checkpoints' THEN
      SELECT true INTO ok FROM public.ledger_checkpoints r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'event_notes' THEN
      SELECT true INTO ok FROM public.event_notes r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.redacted_at IS NOT NULL;
    ELSE
      ok := false;
  END CASE;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'A ledger event must describe an existing row of the same tenant, authored by the event actor.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision', 'redaction', 'checkpoint'));
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_subject CHECK (subject_table = CASE event_type
  WHEN 'capture'               THEN 'report_captures'
  WHEN 'capture-decision'      THEN 'capture_acceptances'
  WHEN 'evaluation'            THEN 'evaluations'
  WHEN 'correction'            THEN 'corrections'
  WHEN 'dispute'               THEN 'cell_disputes'
  WHEN 'dispute-decision'      THEN 'cell_dispute_decisions'
  WHEN 'patient-link-decision' THEN 'report_patient_decisions'
  WHEN 'redaction'             THEN 'event_notes'
  WHEN 'checkpoint'            THEN 'ledger_checkpoints'
END);

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;

-- Back to 0020: an identifier match must name an identifier of the decision's own patient. A decision that matched through a merged patient's
-- identifier cannot be kept under that rule, so reverting such a database fails here; this is for disposable databases only.
CREATE OR REPLACE FUNCTION report_patient_decisions_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  r record;
  i record;
BEGIN
  SELECT created_by, upload_requested_by, uploaded_by, patient_id, sha256, object_version, uploaded_at, deleted_at INTO r
    FROM public.reports WHERE id = NEW.report_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR r.deleted_at IS NOT NULL OR r.uploaded_at IS NULL OR r.sha256 IS DISTINCT FROM NEW.report_sha256
     OR r.object_version IS DISTINCT FROM NEW.object_version OR r.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'A decision must be about the report''s current file and patient.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.created_by IN (r.created_by, r.upload_requested_by, r.uploaded_by) THEN
    RAISE EXCEPTION 'A report''s link is decided by someone other than the people who registered or uploaded it.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.method = 'identifier-match' THEN
    SELECT status, patient_id INTO i FROM public.patient_identifiers WHERE id = NEW.identifier_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR i.status <> 'active' OR i.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'A match must name an active identifier of this patient.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE report_patient_decisions DROP CONSTRAINT report_patient_decisions_identifier_fk;
ALTER TABLE report_patient_decisions ADD CONSTRAINT report_patient_decisions_identifier_fk
  FOREIGN KEY (identifier_id, tenant_id, patient_id) REFERENCES patient_identifiers (id, tenant_id, patient_id) ON DELETE RESTRICT;
ALTER TABLE patient_identifiers DROP CONSTRAINT patient_identifiers_id_tenant_uq;

DROP TABLE patient_merge_decisions;
DROP TABLE patient_merge_proposals;
DROP TABLE patient_duplicate_flags;
DROP FUNCTION patient_merge_decisions_check();
DROP FUNCTION patient_merge_decisions_graph();
DROP FUNCTION patient_merge_refusal(text, text, uuid, uuid, uuid);
DROP FUNCTION patient_group_ids(text, uuid);
DROP FUNCTION patient_merged_into(text, uuid);
DROP FUNCTION patient_alias_edges(text, uuid);
