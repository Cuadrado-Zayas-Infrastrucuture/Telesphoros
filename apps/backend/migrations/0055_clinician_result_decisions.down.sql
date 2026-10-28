-- Spec 006 D01b down. Clinician decisions are ledger records: each has an immutable ledger event of type `clinician-result-decision`, and the
-- ledger's type CHECK restated below cannot be put back while one exists. So there is no override: a populated database is refused here with
-- a clear message, and repaired forward with a new migration. An empty one reverts.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- clinician_result_decisions has FORCE ROW LEVEL SECURITY and every policy on it is for another role, so the migrator (its owner, but not a
-- superuser and without BYPASSRLS) sees no rows, and the check below would always read "empty". The owner may lift FORCE inside this
-- transaction; it is put back straight after the check (and a refusal rolls it back with everything else).
ALTER TABLE clinician_result_decisions NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM clinician_result_decisions) THEN
    RAISE EXCEPTION 'Refusing to drop populated clinician decisions: their ledger events cannot be removed. Repair forward with a new migration.';
  END IF;
END $$;
ALTER TABLE clinician_result_decisions FORCE ROW LEVEL SECURITY;

-- The ledger forgets the type: 0021's set, restated verbatim.
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'redaction', 'checkpoint'));
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_subject CHECK (subject_table = CASE event_type
  WHEN 'capture'                THEN 'report_captures'
  WHEN 'capture-decision'       THEN 'capture_acceptances'
  WHEN 'evaluation'             THEN 'evaluations'
  WHEN 'correction'             THEN 'corrections'
  WHEN 'dispute'                THEN 'cell_disputes'
  WHEN 'dispute-decision'       THEN 'cell_dispute_decisions'
  WHEN 'patient-link-decision'  THEN 'report_patient_decisions'
  WHEN 'patient-merge-proposal' THEN 'patient_merge_proposals'
  WHEN 'patient-merge-decision' THEN 'patient_merge_decisions'
  WHEN 'redaction'              THEN 'event_notes'
  WHEN 'checkpoint'             THEN 'ledger_checkpoints'
END);

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
    WHEN 'patient_merge_proposals' THEN
      SELECT true INTO ok FROM public.patient_merge_proposals r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'patient_merge_decisions' THEN
      SELECT true INTO ok FROM public.patient_merge_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'ledger_checkpoints' THEN
      SELECT true INTO ok FROM public.ledger_checkpoints r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'event_notes' THEN
      -- A redaction event: the note exists in this tenant and is redacted by this very transaction.
      SELECT true INTO ok FROM public.event_notes r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.redacted_at IS NOT NULL;
    ELSE
      ok := false;
  END CASE;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'A ledger event must describe an existing row of the same tenant, authored by the event actor.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;

DROP TABLE clinician_result_decisions;
DROP FUNCTION clinician_result_decisions_check();
DROP FUNCTION clinician_decision_codes_valid(text, text, text[], date, boolean);

DO $$
DECLARE owner_role name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = 'public.evaluations'::regclass;
  EXECUTE format('SET LOCAL ROLE %I', owner_role);
  ALTER TABLE public.evaluations DROP CONSTRAINT evaluations_id_tenant_patient_uq;
  RESET ROLE;
  SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = 'public.evaluation_results'::regclass;
  EXECUTE format('SET LOCAL ROLE %I', owner_role);
  ALTER TABLE public.evaluation_results DROP CONSTRAINT evaluation_results_id_evaluation_tenant_uq;
  RESET ROLE;
END $$;
