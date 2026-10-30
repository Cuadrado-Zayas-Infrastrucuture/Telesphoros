-- compat: breaking
-- Spec 020 slice E1a: data provenance. One row says where one fact came from: whether the data is synthetic or real, whether the interpretation was
-- assigned by the lab or derived by the software, which document it rests on (sha-256 and object version), when that document was received, the
-- transformation that produced the fact, and its parent asset. It is written in the same transaction as the fact it describes: a report capture or an
-- evaluation (plan E7; tasks P1 to P4). A ledger record: append-only, FORCE row-level security, one event each (type `data-provenance`).
--
-- `origin` is required and has NO default, so a path that cannot name its origin fails here as well as in code. It is written by the server, never taken
-- from a request, and `real` is allowed but no code path writes it yet. Source organization, source type, context and collection location are
-- nullable and null today: nothing collects them.
--
-- Provenance links to permissions and never encodes them (P4): there is no purpose, consent or eligibility column, and a test pins the column list.
--
-- Breaking by the lint's rule: a widened ledger event-type set (0060's set, restated with one more type, run as the ledger owner as 0060 did), and the
-- TRUNCATE refusal names TRUNCATE, which an `expand` migration may not (migration-lint.ts matches the keyword). Nothing an older image reads or writes
-- changes. The composite keys the foreign keys below use were added by 0055 and are left as they are.
--
-- Facts stored before this migration have no provenance row and get none: their origin was never recorded, and a guessed one would be a false statement.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE data_provenance (
  seq                         bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                          uuid PRIMARY KEY,
  tenant_id                   text NOT NULL,
  created_by                  text NOT NULL,            -- the actor of the fact's own transaction (a worker acts for the requester, as for the evaluation)
  created_at                  timestamptz NOT NULL DEFAULT now(),
  ledger_event_id             uuid NOT NULL,
  subject_kind                text NOT NULL,            -- the fact described: a `capture` or an `evaluation`
  capture_id                  uuid,
  evaluation_id               uuid,
  origin                      text NOT NULL,            -- `synthetic` or `real`: no default, and set by the server
  interpretation              text,                     -- `lab-assigned`, `software-derived`, or null when the lab's own part is not separated
  document_sha256             text NOT NULL,            -- the originating document: the PDF
  object_version              text,                     -- the report's stored object version (a capture only)
  received_at                 timestamptz,              -- when the document was received (a capture only)
  transform_runner            text,                     -- the transformation: a capture's text runner and Poppler version,
  transform_poppler_version   text,
  transform_engine_version    text,                     -- or an evaluation's engine version and knowledge set
  transform_knowledge_set_id  text,
  parent_kind                 text NOT NULL,            -- the parent asset: the report, the capture, or the capture acceptance
  parent_id                   uuid NOT NULL,
  source_organization         text,                     -- not known yet: nothing collects the four fields that follow
  source_type                 text,
  context                     text,
  collection_location         text,
  CONSTRAINT data_provenance_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT data_provenance_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT data_provenance_subject_kind CHECK (subject_kind IN ('capture', 'evaluation')),
  CONSTRAINT data_provenance_subject_ref CHECK (
    (subject_kind = 'capture' AND capture_id IS NOT NULL AND evaluation_id IS NULL)
    OR (subject_kind = 'evaluation' AND evaluation_id IS NOT NULL AND capture_id IS NULL)),
  CONSTRAINT data_provenance_origin CHECK (origin IN ('synthetic', 'real')),
  CONSTRAINT data_provenance_interpretation CHECK (interpretation IS NULL OR interpretation IN ('lab-assigned', 'software-derived')),
  CONSTRAINT data_provenance_document_hash CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT data_provenance_context CHECK (context IS NULL OR context IN ('clinical', 'research', 'direct-to-consumer')),
  CONSTRAINT data_provenance_text_len CHECK (
    (object_version IS NULL OR length(object_version) BETWEEN 1 AND 1024)
    AND (transform_runner IS NULL OR length(transform_runner) BETWEEN 1 AND 128)
    AND (transform_poppler_version IS NULL OR length(transform_poppler_version) BETWEEN 1 AND 128)
    AND (transform_engine_version IS NULL OR length(transform_engine_version) BETWEEN 1 AND 128)
    AND (transform_knowledge_set_id IS NULL OR length(transform_knowledge_set_id) BETWEEN 1 AND 256)
    AND (source_organization IS NULL OR length(source_organization) BETWEEN 1 AND 256)
    AND (source_type IS NULL OR length(source_type) BETWEEN 1 AND 128)
    AND (collection_location IS NULL OR length(collection_location) BETWEEN 1 AND 256)),
  -- A capture was made by a text runner; an evaluation by an engine over a knowledge set. Neither carries the other's transformation.
  CONSTRAINT data_provenance_transformation CHECK (
    (subject_kind = 'capture' AND transform_runner IS NOT NULL AND transform_poppler_version IS NOT NULL
       AND transform_engine_version IS NULL AND transform_knowledge_set_id IS NULL)
    OR (subject_kind = 'evaluation' AND transform_engine_version IS NOT NULL AND transform_knowledge_set_id IS NOT NULL
       AND transform_runner IS NULL AND transform_poppler_version IS NULL)),
  CONSTRAINT data_provenance_parent_kind CHECK (
    (subject_kind = 'capture' AND parent_kind = 'report')
    OR (subject_kind = 'evaluation' AND parent_kind IN ('capture-acceptance', 'capture'))),
  -- One provenance row per fact: a second is refused, never merged.
  CONSTRAINT data_provenance_capture_uq UNIQUE (capture_id, tenant_id),
  CONSTRAINT data_provenance_evaluation_uq UNIQUE (evaluation_id, tenant_id),
  CONSTRAINT data_provenance_capture_fk FOREIGN KEY (capture_id, tenant_id)
    REFERENCES report_captures (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT data_provenance_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id)
    REFERENCES evaluations (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT data_provenance_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX data_provenance_event_idx ON data_provenance (ledger_event_id, tenant_id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. BEFORE INSERT: the row is bound to the transaction's organization and person, and its parent asset exists in the same organization.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION data_provenance_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
REVOKE ALL ON FUNCTION data_provenance_check() FROM PUBLIC;
CREATE TRIGGER data_provenance_check BEFORE INSERT ON data_provenance FOR EACH ROW EXECUTE FUNCTION data_provenance_check();

CREATE CONSTRAINT TRIGGER data_provenance_has_event AFTER INSERT ON data_provenance DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER data_provenance_append_only BEFORE UPDATE OR DELETE ON data_provenance FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER data_provenance_no_truncate BEFORE TRUNCATE ON data_provenance FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE data_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY data_provenance_tenant ON data_provenance FOR ALL TO telesphoros_app
  USING (tenant_id = (SELECT public.app_tenant())) WITH CHECK (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY data_provenance_ledger ON data_provenance FOR SELECT TO telesphoros_ledger USING (tenant_id = (SELECT public.app_tenant()));
CREATE POLICY data_provenance_verifier ON data_provenance FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON data_provenance FROM PUBLIC;
GRANT SELECT, INSERT ON data_provenance TO telesphoros_app;
GRANT SELECT ON data_provenance TO telesphoros_ledger, telesphoros_ledger_verifier;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. The ledger learns the new event type and the table it is about (0060's set, plus one).
-- ---------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'result-acknowledgement', 'data-provenance', 'redaction', 'checkpoint'));
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
