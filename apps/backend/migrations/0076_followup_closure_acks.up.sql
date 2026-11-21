-- compat: breaking
-- Spec 045 (audit P0-C): an acknowledgement that a reminder's assignee saw a colleague close it. One row per dismiss version written by
-- someone other than the previous version's assignee, recorded by that assignee. A ledger record: append-only, FORCE row-level security, one
-- event each (type `patient-followup-closure-ack`). Who may dismiss, the required note and needs_reassignment are unchanged (0067).
--
-- Breaking: a widened ledger event-type set. The ledger part restates the set of the newest migration that restated it (0069) with one more
-- type, run as the ledger owner as 0069 did.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE patient_followup_closure_acks (
  seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CONSTRAINT patient_followup_closure_acks_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  created_by text NOT NULL CONSTRAINT patient_followup_closure_acks_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  followup_id uuid NOT NULL REFERENCES patient_followups(id) ON DELETE RESTRICT, -- the dismiss version acknowledged
  thread_id uuid NOT NULL,   -- copied from that version by the trigger, never taken from the request
  patient_id uuid NOT NULL,  -- likewise
  creation_request_id uuid NOT NULL,
  creation_request_hash text NOT NULL CONSTRAINT patient_followup_closure_acks_request_hash CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT patient_followup_closure_acks_request_uq UNIQUE (tenant_id, created_by, creation_request_id),
  CONSTRAINT patient_followup_closure_acks_once_uq UNIQUE (tenant_id, followup_id),
  CONSTRAINT patient_followup_closure_acks_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_followup_closure_acks_event_fk FOREIGN KEY (ledger_event_id, tenant_id) REFERENCES ledger_events(id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX patient_followup_closure_acks_event_idx ON patient_followup_closure_acks(ledger_event_id, tenant_id);

-- BEFORE INSERT: bound to the transaction's organization and person, a current clinician, and the assignee of the version before a dismiss
-- that someone else wrote. The route checks first to give clear errors; this is the guarantee.
CREATE FUNCTION patient_followup_closure_acks_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE closing public.patient_followups%ROWTYPE; prior public.patient_followups%ROWTYPE; member text; member_version bigint;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'An acknowledgement must be by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT sub, version INTO member, member_version FROM public.tenant_memberships WHERE tenant_id=NEW.tenant_id AND sub=NEW.created_by AND status='active' AND 'clinician'=ANY(roles);
  IF member IS NULL OR NOT public.membership_assert_current(member, member_version) THEN RAISE EXCEPTION 'A current clinician is required.' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO closing FROM public.patient_followups WHERE id=NEW.followup_id AND tenant_id=NEW.tenant_id;
  IF closing.id IS NULL OR closing.action <> 'dismiss' THEN RAISE EXCEPTION 'Only a closed reminder can be acknowledged.' USING ERRCODE = 'FU002'; END IF;
  IF closing.created_by = NEW.created_by THEN RAISE EXCEPTION 'You closed this reminder yourself.' USING ERRCODE = 'FU002'; END IF;
  SELECT * INTO prior FROM public.patient_followups WHERE tenant_id=NEW.tenant_id AND thread_id=closing.thread_id AND version=closing.version-1;
  IF prior.assignee IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'Only the clinician the reminder was assigned to can acknowledge its closure.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.thread_id := closing.thread_id;
  NEW.patient_id := closing.patient_id;
  NEW.created_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION patient_followup_closure_acks_check() FROM PUBLIC;
CREATE TRIGGER patient_followup_closure_acks_check BEFORE INSERT ON patient_followup_closure_acks FOR EACH ROW EXECUTE FUNCTION patient_followup_closure_acks_check();
CREATE CONSTRAINT TRIGGER patient_followup_closure_acks_has_event AFTER INSERT ON patient_followup_closure_acks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER patient_followup_closure_acks_append_only BEFORE UPDATE OR DELETE ON patient_followup_closure_acks FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER patient_followup_closure_acks_no_truncate BEFORE TRUNCATE ON patient_followup_closure_acks FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE patient_followup_closure_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_followup_closure_acks FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_followup_closure_acks_tenant ON patient_followup_closure_acks FOR ALL TO telesphoros_app USING (tenant_id=(SELECT public.app_tenant())) WITH CHECK (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY patient_followup_closure_acks_ledger ON patient_followup_closure_acks FOR SELECT TO telesphoros_ledger USING (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY patient_followup_closure_acks_verifier ON patient_followup_closure_acks FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON patient_followup_closure_acks FROM PUBLIC;
GRANT SELECT, INSERT ON patient_followup_closure_acks TO telesphoros_app;
GRANT SELECT ON patient_followup_closure_acks TO telesphoros_ledger, telesphoros_ledger_verifier;

-- The ledger learns the new event type and the table it is about (0069's set, plus one).
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'result-acknowledgement', 'data-provenance', 'use-grant', 'use-grant-validation', 'use-withdrawal', 'use-restriction', 'tenant-use-terms', 'patient-demographics', 'patient-medication', 'patient-followup', 'structured-report-revision', 'structured-finding-review', 'structured-source-resolution', 'patient-followup-closure-ack', 'redaction', 'checkpoint'));
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_subject CHECK (subject_table = CASE event_type
  WHEN 'capture'                   THEN 'report_captures'
  WHEN 'capture-decision'          THEN 'capture_acceptances'
  WHEN 'evaluation'                THEN 'evaluations'
  WHEN 'correction'                THEN 'corrections'
  WHEN 'dispute'                   THEN 'cell_disputes'
  WHEN 'dispute-decision'          THEN 'cell_dispute_decisions'
  WHEN 'patient-link-decision'     THEN 'report_patient_decisions'
  WHEN 'patient-merge-proposal'    THEN 'patient_merge_proposals'
  WHEN 'patient-merge-decision'    THEN 'patient_merge_decisions'
  WHEN 'clinician-result-decision' THEN 'clinician_result_decisions'
  WHEN 'result-acknowledgement'    THEN 'result_acknowledgements'
  WHEN 'data-provenance'           THEN 'data_provenance'
  WHEN 'use-grant'                 THEN 'use_grants'
  WHEN 'use-grant-validation'      THEN 'use_grant_validations'
  WHEN 'use-withdrawal'            THEN 'use_withdrawals'
  WHEN 'use-restriction'           THEN 'use_restrictions'
  WHEN 'tenant-use-terms'          THEN 'tenant_use_terms'
  WHEN 'patient-demographics'      THEN 'patient_demographics'
  WHEN 'patient-medication'       THEN 'patient_medications'
  WHEN 'patient-followup' THEN 'patient_followups'
  WHEN 'structured-report-revision' THEN 'structured_report_revisions'
  WHEN 'structured-finding-review' THEN 'structured_finding_reviews'
  WHEN 'structured-source-resolution' THEN 'structured_source_resolutions'
  WHEN 'patient-followup-closure-ack' THEN 'patient_followup_closure_acks'
  WHEN 'redaction'                 THEN 'event_notes'
  WHEN 'checkpoint'                THEN 'ledger_checkpoints'
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
    WHEN 'clinician_result_decisions' THEN
      SELECT true INTO ok FROM public.clinician_result_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'result_acknowledgements' THEN
      SELECT true INTO ok FROM public.result_acknowledgements r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'data_provenance' THEN
      SELECT true INTO ok FROM public.data_provenance r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'use_grants' THEN
      SELECT true INTO ok FROM public.use_grants r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'use_grant_validations' THEN
      SELECT true INTO ok FROM public.use_grant_validations r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'use_withdrawals' THEN
      SELECT true INTO ok FROM public.use_withdrawals r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'use_restrictions' THEN
      SELECT true INTO ok FROM public.use_restrictions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'tenant_use_terms' THEN
      SELECT true INTO ok FROM public.tenant_use_terms r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'patient_demographics' THEN
      SELECT true INTO ok FROM public.patient_demographics r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'patient_medications' THEN
      SELECT true INTO ok FROM public.patient_medications r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'patient_followups' THEN
      SELECT true INTO ok FROM public.patient_followups r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'structured_report_revisions' THEN
      SELECT true INTO ok FROM public.structured_report_revisions r WHERE r.id=NEW.subject_id AND r.tenant_id=NEW.tenant_id AND r.ledger_event_id=NEW.id AND r.created_by=NEW.actor_sub;
    WHEN 'structured_finding_reviews' THEN
      SELECT true INTO ok FROM public.structured_finding_reviews r WHERE r.id=NEW.subject_id AND r.tenant_id=NEW.tenant_id AND r.ledger_event_id=NEW.id AND r.created_by=NEW.actor_sub;
    WHEN 'structured_source_resolutions' THEN
      SELECT true INTO ok FROM public.structured_source_resolutions r WHERE r.id=NEW.subject_id AND r.tenant_id=NEW.tenant_id AND r.ledger_event_id=NEW.id AND r.created_by=NEW.actor_sub;
    WHEN 'patient_followup_closure_acks' THEN
      SELECT true INTO ok FROM public.patient_followup_closure_acks r WHERE r.id=NEW.subject_id AND r.tenant_id=NEW.tenant_id AND r.ledger_event_id=NEW.id AND r.created_by=NEW.actor_sub;
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
