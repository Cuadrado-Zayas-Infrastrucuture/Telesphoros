-- compat: breaking
-- Spec 019 slice D02a: result acknowledgements. One row says that a clinician reviewed one result row (the result version: evaluation results are
-- immutable, so a correction or re-evaluation makes new rows) in the basis shown, for one review task. A ledger record: append-only, FORCE row-level
-- security, one event each (type `result-acknowledgement`). It records that a review was made, not what it concluded (spec 006 decisions do that),
-- and never that anything was read, ordered, dispensed or taken. See specs/019-presentation-events/plan.md, slice D02a, and the tasks' A1 to A6.
--
-- Breaking: a widened ledger event-type set. The ledger part restates the set of the newest migration that restated it (0055) with one more type,
-- run as the ledger owner as 0055 did. The composite keys the foreign keys below use were added by 0055 and are left as they are.
--
-- The basis categories in result_acknowledgement_basis_valid() are the D01b basis (BASIS_SQL in storage/postgres/clinician-decisions.ts), in the
-- order it reports them. They must equal CDR_BASIS in packages/shared-types/src/clinician-decisions.ts; a test compares them.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. A stored basis is the D01b basis as reported: known categories, each once, in the reported order, and `active` only on its own.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION result_acknowledgement_basis_valid(p_basis text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  WITH v AS (
    SELECT ARRAY['active', 'retracted', 'superseded', 'quarantined', 'disputed', 'not-current']::text[] AS categories
  ), p AS (
    SELECT array_position(v.categories, u.b) AS pos, u.o FROM v, unnest(p_basis) WITH ORDINALITY AS u(b, o)
  )
  SELECT p_basis IS NOT NULL AND cardinality(p_basis) BETWEEN 1 AND 6
     AND NOT EXISTS (SELECT 1 FROM p WHERE p.pos IS NULL)
     AND NOT EXISTS (SELECT 1 FROM p a JOIN p b ON b.o = a.o + 1 WHERE b.pos <= a.pos)
     AND (p_basis = ARRAY['active']::text[] OR NOT ('active' = ANY (p_basis)))
$$;
REVOKE ALL ON FUNCTION result_acknowledgement_basis_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION result_acknowledgement_basis_valid(text[]) TO telesphoros_app, telesphoros_ledger, telesphoros_ledger_verifier;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. The table.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE result_acknowledgements (
  seq                   bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                    uuid PRIMARY KEY,
  tenant_id             text NOT NULL,
  result_id             uuid NOT NULL,            -- the result version reviewed (A2)
  evaluation_id         uuid NOT NULL,
  patient_id            uuid NOT NULL,
  created_by            text NOT NULL,            -- the clinician who reviewed it and entered the review
  author_roles          text[] NOT NULL,          -- copied by the trigger from the live membership row, never from the request
  membership_version    bigint NOT NULL,
  kind                  text NOT NULL,            -- A3: `review`, or `retraction-reviewed` for a retracted basis
  review_task           text NOT NULL,            -- A5: a closed vocabulary; `result-review` is the only task in v1
  basis                 text[] NOT NULL,          -- the basis displayed, equal to the server's at commit (A4)
  basis_rule            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(), -- the recorded time: every timeliness measure uses this
  ledger_event_id       uuid NOT NULL,
  creation_request_id   uuid NOT NULL,
  creation_request_hash text NOT NULL,
  CONSTRAINT result_acknowledgements_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT result_acknowledgements_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT result_acknowledgements_created_by_human CHECK (created_by !~ '^system:'),
  CONSTRAINT result_acknowledgements_author_roles CHECK ('clinician' = ANY (author_roles)),
  CONSTRAINT result_acknowledgements_kind CHECK (kind IN ('review', 'retraction-reviewed')),
  CONSTRAINT result_acknowledgements_review_task CHECK (review_task IN ('result-review')),
  CONSTRAINT result_acknowledgements_basis CHECK (result_acknowledgement_basis_valid(basis)),
  -- A3: a generic review is never stored against a retracted basis, and "retraction reviewed" only against one.
  CONSTRAINT result_acknowledgements_kind_basis CHECK ((kind = 'retraction-reviewed') = ('retracted' = ANY (basis))),
  CONSTRAINT result_acknowledgements_basis_rule CHECK (basis_rule = 'cdr-basis-v1'),
  CONSTRAINT result_acknowledgements_request_hash CHECK (creation_request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT result_acknowledgements_creation_request_uq UNIQUE (tenant_id, created_by, creation_request_id),
  -- A5: one acknowledgement per clinician, result version, review task and kind. A second request for the same key is refused, never merged.
  CONSTRAINT result_acknowledgements_once_uq UNIQUE (tenant_id, created_by, result_id, review_task, kind),
  CONSTRAINT result_acknowledgements_result_fk FOREIGN KEY (result_id, evaluation_id, tenant_id)
    REFERENCES evaluation_results (id, evaluation_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT result_acknowledgements_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id, patient_id)
    REFERENCES evaluations (id, tenant_id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT result_acknowledgements_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX result_acknowledgements_result_idx ON result_acknowledgements (tenant_id, result_id, seq);
CREATE INDEX result_acknowledgements_evaluation_idx ON result_acknowledgements (evaluation_id, tenant_id, patient_id);
CREATE INDEX result_acknowledgements_event_idx ON result_acknowledgements (ledger_event_id, tenant_id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. BEFORE INSERT: the row is bound to the transaction's organization and person, and the author is a clinician by the LIVE membership row (whose
--    roles and version are copied here, never taken from the request). The route checks the role first to give a clear error; this is the guarantee.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION result_acknowledgements_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m record;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'A result acknowledgement must be by the person and organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT roles, version INTO m FROM public.tenant_memberships
   WHERE tenant_id = NEW.tenant_id AND sub = NEW.created_by AND status = 'active' AND 'clinician' = ANY (roles);
  IF NOT FOUND OR NOT public.membership_assert_current(NEW.created_by, m.version) THEN
    RAISE EXCEPTION 'Only a current clinician of the organization may acknowledge a result.' USING ERRCODE = 'RA001';
  END IF;
  NEW.author_roles := m.roles;
  NEW.membership_version := m.version;
  NEW.created_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION result_acknowledgements_check() FROM PUBLIC;
CREATE TRIGGER result_acknowledgements_check BEFORE INSERT ON result_acknowledgements FOR EACH ROW EXECUTE FUNCTION result_acknowledgements_check();

CREATE CONSTRAINT TRIGGER result_acknowledgements_has_event AFTER INSERT ON result_acknowledgements DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER result_acknowledgements_append_only BEFORE UPDATE OR DELETE ON result_acknowledgements FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER result_acknowledgements_no_truncate BEFORE TRUNCATE ON result_acknowledgements FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE result_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_acknowledgements FORCE ROW LEVEL SECURITY;
CREATE POLICY result_acknowledgements_tenant ON result_acknowledgements FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY result_acknowledgements_ledger ON result_acknowledgements FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY result_acknowledgements_verifier ON result_acknowledgements FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON result_acknowledgements FROM PUBLIC;
GRANT SELECT, INSERT ON result_acknowledgements TO telesphoros_app;
GRANT SELECT ON result_acknowledgements TO telesphoros_ledger, telesphoros_ledger_verifier;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. The ledger learns the new event type and the table it is about (0055's set, plus one).
-- ---------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'result-acknowledgement', 'redaction', 'checkpoint'));
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
