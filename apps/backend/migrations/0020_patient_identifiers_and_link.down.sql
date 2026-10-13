-- GUARD: removes audit records and patient identifiers. See 0005 for how to allow it on purpose.
DO $$ BEGIN
  IF current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop patient-link decisions and patient identifiers: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
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
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'redaction', 'checkpoint'));
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_subject CHECK (subject_table = CASE event_type
  WHEN 'capture'          THEN 'report_captures'
  WHEN 'capture-decision' THEN 'capture_acceptances'
  WHEN 'evaluation'       THEN 'evaluations'
  WHEN 'correction'       THEN 'corrections'
  WHEN 'dispute'          THEN 'cell_disputes'
  WHEN 'dispute-decision' THEN 'cell_dispute_decisions'
  WHEN 'redaction'        THEN 'event_notes'
  WHEN 'checkpoint'       THEN 'ledger_checkpoints'
END);

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;

DROP TABLE report_patient_decisions;
DROP FUNCTION report_patient_decisions_check();
DROP TABLE patient_identifiers;
DROP FUNCTION patient_identifiers_guard();
