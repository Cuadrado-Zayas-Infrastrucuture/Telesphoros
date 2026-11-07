-- compat: breaking
-- Treatment-linked documentation and durable in-app due tasks. Coordinate ledger/verifier rollout.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- Explicit clock input permits boundary verification; callers use the database transaction time.
CREATE FUNCTION patient_followups_due_state(p_date date, p_timezone text, p_at timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p_date IS NULL THEN 'closed'
    WHEN p_date < (p_at AT TIME ZONE p_timezone)::date THEN 'overdue'
    WHEN p_date = (p_at AT TIME ZONE p_timezone)::date THEN 'today' ELSE 'upcoming' END;
$$;
REVOKE ALL ON FUNCTION patient_followups_due_state(date,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION patient_followups_due_state(date,text,timestamptz) TO telesphoros_app;
CREATE TABLE patient_followups (
  seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CONSTRAINT patient_followups_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  created_by text NOT NULL CONSTRAINT patient_followups_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  version integer NOT NULL CONSTRAINT patient_followups_version CHECK (version BETWEEN 1 AND 1000000),
  medication_id uuid NOT NULL REFERENCES patient_medications(id) ON DELETE RESTRICT,
  decision_id uuid REFERENCES clinician_result_decisions(id) ON DELETE RESTRICT,
  action text NOT NULL CONSTRAINT patient_followups_action CHECK (action IN ('schedule','document','amend','reschedule','dismiss')),
  assessment jsonb,
  note_id uuid NOT NULL,
  due_date date,
  due_timezone text,
  assignee text,
  creation_request_id uuid NOT NULL,
  creation_request_hash text NOT NULL CONSTRAINT patient_followups_request_hash CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT patient_followups_version_uq UNIQUE (tenant_id, thread_id, version),
  CONSTRAINT patient_followups_request_uq UNIQUE (tenant_id, created_by, creation_request_id),
  CONSTRAINT patient_followups_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_followups_note_fk FOREIGN KEY (note_id, tenant_id) REFERENCES event_notes(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_followups_event_fk FOREIGN KEY (ledger_event_id, tenant_id) REFERENCES ledger_events(id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT patient_followups_task_shape CHECK ((due_date IS NULL AND due_timezone IS NULL AND assignee IS NULL) OR
    (due_date IS NOT NULL AND due_timezone IS NOT NULL AND length(due_timezone) BETWEEN 1 AND 100 AND assignee IS NOT NULL AND length(assignee) BETWEEN 1 AND 128)),
  CONSTRAINT patient_followups_action_shape CHECK (
    ((action IN ('document','amend')) = (assessment IS NOT NULL)) AND
    (action NOT IN ('schedule','reschedule') OR due_date IS NOT NULL) AND (action <> 'dismiss' OR due_date IS NULL)),
  CONSTRAINT patient_followups_assessment_shape CHECK (assessment IS NULL OR (
    jsonb_typeof(assessment) = 'object' AND assessment ?& ARRAY['date','timezone','response','symptoms','adherence','source'] AND
    assessment - ARRAY['date','timezone','response','symptoms','adherence','source'] = '{}'::jsonb AND
    jsonb_typeof(assessment->'timezone') = 'string' AND length(assessment->>'timezone') BETWEEN 1 AND 100 AND
    (assessment->>'date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND
    (assessment->>'response') IN ('improved','unchanged','worsened','not-assessed') AND
    (assessment->>'symptoms') IN ('reported','none-reported','not-assessed') AND
    (assessment->>'adherence') IN ('taking-reported','not-taking-reported','not-assessed') AND
    (assessment->>'source') IN ('clinician-assessed','patient-reported') AND
    NOT (assessment @> '{"timezone":null}' OR assessment @> '{"date":null}' OR assessment @> '{"response":null}' OR assessment @> '{"symptoms":null}' OR assessment @> '{"adherence":null}' OR assessment @> '{"source":null}')))
);
CREATE INDEX patient_followups_patient_idx ON patient_followups(tenant_id, patient_id, thread_id, version DESC);
CREATE INDEX patient_followups_event_idx ON patient_followups(ledger_event_id, tenant_id);
CREATE FUNCTION patient_followups_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior public.patient_followups%ROWTYPE; member text; member_version bigint;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Follow-ups must use the bound clinician and organization.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT sub, version INTO member, member_version FROM public.tenant_memberships WHERE tenant_id=NEW.tenant_id AND sub=NEW.created_by AND status='active' AND 'clinician'=ANY(roles);
  IF member IS NULL OR NOT public.membership_assert_current(member, member_version) THEN RAISE EXCEPTION 'A current clinician is required.' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('patient-followups:' || NEW.tenant_id || ':' || NEW.thread_id::text, 0));
  SELECT * INTO prior FROM public.patient_followups WHERE tenant_id=NEW.tenant_id AND thread_id=NEW.thread_id ORDER BY version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(prior.version,0)+1 THEN
    RAISE EXCEPTION 'Follow-up changed.' USING ERRCODE = 'FU001';
  END IF;
  IF prior.id IS NULL AND NEW.action NOT IN ('schedule','document') THEN RAISE EXCEPTION 'Follow-up history required.' USING ERRCODE = 'FU002'; END IF;
  IF prior.id IS NOT NULL AND (NEW.patient_id <> prior.patient_id OR NEW.medication_id <> prior.medication_id OR NEW.decision_id IS DISTINCT FROM prior.decision_id OR NEW.action='schedule') THEN
    RAISE EXCEPTION 'Follow-up context cannot change.' USING ERRCODE = 'FU002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients WHERE id=NEW.patient_id AND tenant_id=NEW.tenant_id AND deleted_at IS NULL) OR
     NOT EXISTS (SELECT 1 FROM public.patient_medications WHERE id=NEW.medication_id AND tenant_id=NEW.tenant_id AND patient_id=NEW.patient_id) OR
     (NEW.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clinician_result_decisions WHERE id=NEW.decision_id AND tenant_id=NEW.tenant_id AND patient_id=NEW.patient_id)) THEN
    RAISE EXCEPTION 'Follow-up context is unavailable.' USING ERRCODE = 'FU002';
  END IF;
  IF NEW.action IN ('reschedule','dismiss') AND prior.due_date IS NULL THEN RAISE EXCEPTION 'This reminder is closed.' USING ERRCODE = 'FU001'; END IF;
  IF NEW.action='amend' AND (prior.action NOT IN ('document','amend') OR prior.created_by <> NEW.created_by OR
     NEW.due_date IS DISTINCT FROM prior.due_date OR NEW.due_timezone IS DISTINCT FROM prior.due_timezone OR NEW.assignee IS DISTINCT FROM prior.assignee) THEN
    RAISE EXCEPTION 'Only the author can correct the latest assessment without changing its reminder.' USING ERRCODE = 'FU002';
  END IF;
  IF NEW.due_timezone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.due_timezone) THEN
    RAISE EXCEPTION 'Unknown timezone.' USING ERRCODE = 'FU002';
  END IF;
  IF NEW.assignee IS NOT NULL AND NEW.action <> 'amend' THEN
    SELECT sub, version INTO member, member_version FROM public.tenant_memberships WHERE tenant_id=NEW.tenant_id AND sub=NEW.assignee AND status='active' AND 'clinician'=ANY(roles);
    IF member IS NULL OR NOT public.membership_assert_current(member, member_version) THEN RAISE EXCEPTION 'Choose a current clinician.' USING ERRCODE = 'FU002'; END IF;
  END IF;
  IF NEW.assessment IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.assessment->>'timezone') THEN
    RAISE EXCEPTION 'Unknown assessment timezone.' USING ERRCODE = 'FU002';
  END IF;
  IF NEW.assessment IS NOT NULL AND (public.patient_followups_due_state((NEW.assessment->>'date')::date,NEW.assessment->>'timezone',clock_timestamp())='upcoming' OR
    (NEW.due_date IS NOT NULL AND NEW.due_date < (NEW.assessment->>'date')::date)) THEN
    RAISE EXCEPTION 'Check assessment and follow-up dates.' USING ERRCODE = 'FU002';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION patient_followups_check() FROM PUBLIC;
CREATE TRIGGER patient_followups_check BEFORE INSERT ON patient_followups FOR EACH ROW EXECUTE FUNCTION patient_followups_check();
CREATE CONSTRAINT TRIGGER patient_followups_has_event AFTER INSERT ON patient_followups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER patient_followups_append_only BEFORE UPDATE OR DELETE ON patient_followups FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER patient_followups_no_truncate BEFORE TRUNCATE ON patient_followups FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE patient_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_followups FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_followups_tenant ON patient_followups FOR ALL TO telesphoros_app USING (tenant_id=(SELECT public.app_tenant())) WITH CHECK (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY patient_followups_ledger ON patient_followups FOR SELECT TO telesphoros_ledger USING (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY patient_followups_verifier ON patient_followups FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON patient_followups FROM PUBLIC;
GRANT SELECT, INSERT ON patient_followups TO telesphoros_app;
GRANT SELECT ON patient_followups TO telesphoros_ledger, telesphoros_ledger_verifier;

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'result-acknowledgement', 'data-provenance', 'use-grant', 'use-grant-validation', 'use-withdrawal', 'use-restriction', 'tenant-use-terms', 'patient-demographics', 'patient-medication', 'patient-followup', 'redaction', 'checkpoint'));
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
