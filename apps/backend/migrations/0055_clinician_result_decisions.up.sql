-- compat: breaking
-- Spec 006 slice D01b: clinician result decisions. One row is one entry in a result's shared decision history: a clinician's decision, an amendment
-- of how that decision was documented, or the withdrawal of an entry made in error. A ledger record: append-only, FORCE row-level security, one
-- event each (type `clinician-result-decision`). A decision records what the clinician intends; nothing here says a recommendation was presented,
-- ordered, dispensed or taken. See specs/006-clinician-decision-records/data-model.md section 2.
--
-- Breaking: two UNIQUE keys on existing tables (each a superset of the primary key, so no existing row can violate it) and a widened ledger
-- event-type set. The ledger part restates 0021's constraints and function with one more type, run as the ledger owner as 0021 did.
--
-- The detail-code lists in clinician_decision_codes_valid() are vocabulary `cdr-v1` (founder decision D6, 2026-10-28: 13 codes). They
-- must equal CDR_CHANGE_CODES / CDR_REASON_CODES in packages/shared-types/src/clinician-decisions.ts; a test compares them.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Keys the composite foreign keys below point at, added as each table's own owner (as 0023 does).
-- ---------------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE owner_role name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = 'public.evaluation_results'::regclass;
  EXECUTE format('SET LOCAL ROLE %I', owner_role);
  ALTER TABLE public.evaluation_results ADD CONSTRAINT evaluation_results_id_evaluation_tenant_uq UNIQUE (id, evaluation_id, tenant_id);
  RESET ROLE;
  SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = 'public.evaluations'::regclass;
  EXECUTE format('SET LOCAL ROLE %I', owner_role);
  ALTER TABLE public.evaluations ADD CONSTRAINT evaluations_id_tenant_patient_uq UNIQUE (id, tenant_id, patient_id);
  RESET ROLE;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Which codes a response allows and requires (vocabulary cdr-v1). The same rule as cdrRuleViolation() in shared-types, so a direct
--    insert cannot store a combination the API refuses.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION clinician_decision_codes_valid(p_kind text, p_response text, p_codes text[], p_review_by date, p_has_note boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  WITH v AS (
    SELECT ARRAY['change-drug', 'change-dose', 'change-monitoring', 'change-other']::text[] AS change_codes,
           ARRAY['not-applicable', 'drug-interaction', 'clinical-context', 'disagree-with-guideline', 'patient-preference', 'access',
                 'information-needed', 'report-doubt', 'other']::text[] AS reason_codes
  ), c AS (
    SELECT (SELECT count(*) FROM unnest(p_codes) x WHERE x = ANY (v.change_codes)) AS changes,
           (SELECT count(*) FROM unnest(p_codes) x WHERE x = ANY (v.reason_codes)) AS reasons,
           (SELECT count(DISTINCT x) FROM unnest(p_codes) x) AS distinct_codes,
           v.change_codes, v.reason_codes
      FROM v
  )
  SELECT p_codes IS NOT NULL AND cardinality(p_codes) <= 8
     AND c.distinct_codes = cardinality(p_codes)
     AND p_codes <@ (c.change_codes || c.reason_codes)
     AND CASE
           WHEN p_kind = 'entered-in-error' THEN p_response IS NULL AND cardinality(p_codes) = 0 AND p_review_by IS NULL
           WHEN p_response IS NULL THEN false
           WHEN p_response = 'accepted' THEN cardinality(p_codes) = 0
           WHEN p_response = 'modified' THEN c.changes >= 1
           ELSE c.changes = 0 AND c.reasons >= 1
         END
     AND (p_review_by IS NULL OR p_response = 'deferred')
     AND (p_has_note OR NOT (p_codes && ARRAY['change-other', 'other']::text[]))
    FROM c
$$;
REVOKE ALL ON FUNCTION clinician_decision_codes_valid(text, text, text[], date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinician_decision_codes_valid(text, text, text[], date, boolean) TO telesphoros_app, telesphoros_ledger, telesphoros_ledger_verifier;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. The table.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE clinician_result_decisions (
  seq                   bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                    uuid PRIMARY KEY,
  tenant_id             text NOT NULL,
  result_id             uuid NOT NULL,
  evaluation_id         uuid NOT NULL,
  patient_id            uuid NOT NULL,
  created_by            text NOT NULL,            -- the clinician: decision-maker and the person who entered it (D2)
  author_roles          text[] NOT NULL,          -- copied by the trigger from the live membership row, never from the request
  membership_version    bigint NOT NULL,
  entry_kind            text NOT NULL,
  previous_entry_id     uuid,
  response              text,
  detail_codes          text[] NOT NULL DEFAULT '{}',
  review_by             date,
  note_id               uuid,
  vocabulary_version    text NOT NULL,
  occurred_at           timestamptz NOT NULL,     -- clinical time as reported (or, when not given, the recorded time)
  occurred_at_source    text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(), -- the recorded time: every timeliness measure uses this
  eligibility_policy    text NOT NULL,
  ledger_event_id       uuid NOT NULL,
  creation_request_id   uuid NOT NULL,
  creation_request_hash text NOT NULL,
  CONSTRAINT clinician_result_decisions_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT clinician_result_decisions_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT clinician_result_decisions_created_by_human CHECK (created_by !~ '^system:'),
  CONSTRAINT clinician_result_decisions_author_roles CHECK ('clinician' = ANY (author_roles)),
  CONSTRAINT clinician_result_decisions_entry_kind CHECK (entry_kind IN ('decision', 'amendment', 'entered-in-error')),
  CONSTRAINT clinician_result_decisions_chain_shape CHECK (entry_kind = 'decision' OR previous_entry_id IS NOT NULL),
  CONSTRAINT clinician_result_decisions_response CHECK (
    response IS NULL OR response IN ('accepted', 'modified', 'rejected', 'deferred', 'clarification-requested')),
  CONSTRAINT clinician_result_decisions_codes CHECK (
    clinician_decision_codes_valid(entry_kind, response, detail_codes, review_by, note_id IS NOT NULL)),
  CONSTRAINT clinician_result_decisions_vocabulary CHECK (vocabulary_version = 'cdr-v1'),
  CONSTRAINT clinician_result_decisions_policy CHECK (eligibility_policy = 'cdr-eligibility-v1'),
  CONSTRAINT clinician_result_decisions_occurred_source CHECK (
    (occurred_at_source = 'recorded' AND occurred_at = created_at) OR occurred_at_source = 'reported'),
  CONSTRAINT clinician_result_decisions_occurred_at CHECK (occurred_at <= created_at),
  CONSTRAINT clinician_result_decisions_request_hash CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT clinician_result_decisions_creation_request_uq UNIQUE (tenant_id, created_by, creation_request_id),
  CONSTRAINT clinician_result_decisions_id_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT clinician_result_decisions_id_result_tenant_uq UNIQUE (id, result_id, tenant_id),
  CONSTRAINT clinician_result_decisions_result_fk FOREIGN KEY (result_id, evaluation_id, tenant_id)
    REFERENCES evaluation_results (id, evaluation_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT clinician_result_decisions_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id, patient_id)
    REFERENCES evaluations (id, tenant_id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT clinician_result_decisions_previous_fk FOREIGN KEY (previous_entry_id, result_id, tenant_id)
    REFERENCES clinician_result_decisions (id, result_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT clinician_result_decisions_note_fk FOREIGN KEY (note_id, tenant_id) REFERENCES event_notes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT clinician_result_decisions_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
-- Each result's history is one line: one first entry, and at most one successor per entry. Two writers on one head cannot both commit.
CREATE UNIQUE INDEX clinician_result_decisions_first_uq ON clinician_result_decisions (tenant_id, result_id) WHERE previous_entry_id IS NULL;
CREATE UNIQUE INDEX clinician_result_decisions_successor_uq ON clinician_result_decisions (previous_entry_id) WHERE previous_entry_id IS NOT NULL;
CREATE INDEX clinician_result_decisions_result_idx ON clinician_result_decisions (tenant_id, result_id, seq);
CREATE INDEX clinician_result_decisions_evaluation_idx ON clinician_result_decisions (evaluation_id, tenant_id, patient_id);
CREATE INDEX clinician_result_decisions_note_idx ON clinician_result_decisions (note_id, tenant_id) WHERE note_id IS NOT NULL;
CREATE INDEX clinician_result_decisions_event_idx ON clinician_result_decisions (ledger_event_id, tenant_id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. BEFORE INSERT: the row is bound to the transaction's organization and person; the author is a clinician by the LIVE membership row (whose
--    roles and version are copied here, never taken from the request); an amendment or withdrawal is the previous entry's author's; and the
--    clinical time lies between the evaluation and now. The service checks first to give clear errors; this is the guarantee.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION clinician_result_decisions_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m record;
  p record;
  evaluated_at timestamptz;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A clinician decision must be by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT roles, version INTO m FROM public.tenant_memberships
   WHERE tenant_id = NEW.tenant_id AND sub = NEW.created_by AND status = 'active' AND 'clinician' = ANY (roles);
  IF NOT FOUND OR NOT public.membership_assert_current(NEW.created_by, m.version) THEN
    RAISE EXCEPTION 'Only a current clinician of the organization may record a clinician decision.' USING ERRCODE = 'CD001';
  END IF;
  NEW.author_roles := m.roles;
  NEW.membership_version := m.version;
  IF NEW.previous_entry_id IS NOT NULL AND NEW.entry_kind <> 'decision' THEN
    SELECT created_by, entry_kind INTO p FROM public.clinician_result_decisions
     WHERE id = NEW.previous_entry_id AND tenant_id = NEW.tenant_id AND result_id = NEW.result_id;
    IF NOT FOUND OR p.created_by <> NEW.created_by THEN
      RAISE EXCEPTION 'Only the author of an entry may amend or withdraw it.' USING ERRCODE = 'CD002';
    END IF;
    IF NEW.entry_kind = 'entered-in-error' AND p.entry_kind = 'entered-in-error' THEN
      RAISE EXCEPTION 'A withdrawal cannot be withdrawn.' USING ERRCODE = 'CD003';
    END IF;
  END IF;
  SELECT created_at INTO evaluated_at FROM public.evaluations WHERE id = NEW.evaluation_id AND tenant_id = NEW.tenant_id;
  NEW.created_at := now();
  IF NEW.occurred_at IS NULL THEN
    NEW.occurred_at := NEW.created_at;
    NEW.occurred_at_source := 'recorded';
  ELSE
    NEW.occurred_at_source := 'reported';
  END IF;
  IF evaluated_at IS NULL OR NEW.occurred_at < evaluated_at OR NEW.occurred_at > NEW.created_at THEN
    RAISE EXCEPTION 'A decision''s time must lie between its evaluation and now.' USING ERRCODE = 'CD004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clinician_result_decisions_check() FROM PUBLIC;
CREATE TRIGGER clinician_result_decisions_check BEFORE INSERT ON clinician_result_decisions FOR EACH ROW EXECUTE FUNCTION clinician_result_decisions_check();

CREATE CONSTRAINT TRIGGER clinician_result_decisions_has_event AFTER INSERT ON clinician_result_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER clinician_result_decisions_append_only BEFORE UPDATE OR DELETE ON clinician_result_decisions FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER clinician_result_decisions_no_truncate BEFORE TRUNCATE ON clinician_result_decisions FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE clinician_result_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinician_result_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY clinician_result_decisions_tenant ON clinician_result_decisions FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY clinician_result_decisions_ledger ON clinician_result_decisions FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY clinician_result_decisions_verifier ON clinician_result_decisions FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON clinician_result_decisions FROM PUBLIC;
GRANT SELECT, INSERT ON clinician_result_decisions TO telesphoros_app;
GRANT SELECT ON clinician_result_decisions TO telesphoros_ledger, telesphoros_ledger_verifier;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. The ledger learns the new event type and the table it is about (0021's set, plus one).
-- ---------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'redaction', 'checkpoint'));
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
