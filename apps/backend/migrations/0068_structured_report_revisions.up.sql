-- compat: breaking
-- New ledger record requires coordinated writer/verifier rollout. Synthetic-only API remains local.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE structured_report_revisions (
  seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  report_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  object_version text NOT NULL CHECK (length(object_version) BETWEEN 1 AND 1024),
  patient_link_decision_id uuid NOT NULL REFERENCES report_patient_decisions(id) ON DELETE RESTRICT,
  parser_version text NOT NULL CHECK (parser_version='pgx-synthetic-0.1'),
  laboratory_report jsonb NOT NULL,
  CONSTRAINT structured_report_revisions_source_uq UNIQUE (tenant_id, report_id),
  CONSTRAINT structured_report_revisions_report_fk FOREIGN KEY (report_id, tenant_id) REFERENCES reports(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT structured_report_revisions_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT structured_report_revisions_event_fk FOREIGN KEY (ledger_event_id, tenant_id) REFERENCES ledger_events(id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT structured_report_revisions_shape CHECK ((jsonb_typeof(laboratory_report)='object' AND
    octet_length(laboratory_report::text)<=262144 AND jsonb_typeof(laboratory_report->'findings')='array' AND
    jsonb_array_length(laboratory_report->'findings')<=50 AND
    laboratory_report->>'laboratoryId' ~ '^syn-[a-z0-9-]{1,76}$' AND laboratory_report->>'seriesId' ~ '^syn-[a-z0-9-]{1,76}$' AND
    laboratory_report->>'id' ~ '^syn-[a-z0-9-]{1,76}$' AND laboratory_report->>'accession' ~ '^syn-[a-z0-9-]{1,76}$' AND
    laboratory_report->>'patientId' ~ '^syn-[a-z0-9-]{1,76}$' AND
    jsonb_typeof(laboratory_report->'revision')='number' AND (laboratory_report->>'revision')::numeric BETWEEN 1 AND 1000000) IS TRUE)
);
CREATE INDEX structured_report_revisions_patient_idx ON structured_report_revisions(tenant_id,patient_id,seq);
CREATE INDEX structured_report_revisions_event_idx ON structured_report_revisions(ledger_event_id,tenant_id);
CREATE INDEX structured_report_revisions_issuer_idx ON structured_report_revisions(tenant_id,(laboratory_report->>'laboratoryId'));
CREATE FUNCTION structured_report_revision_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.reports%ROWTYPE; d public.report_patient_decisions%ROWTYPE; member text; member_version bigint;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Use the bound actor and organization.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT sub,version INTO member,member_version FROM public.tenant_memberships WHERE tenant_id=NEW.tenant_id AND sub=NEW.created_by AND status='active' AND roles && ARRAY['clinician','reviewer'];
  IF member IS NULL OR NOT public.membership_assert_current(member,member_version) THEN RAISE EXCEPTION 'A current clinician or reviewer is required.' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('structured-pgx:' || NEW.tenant_id,0));
  SELECT * INTO r FROM public.reports WHERE id=NEW.report_id AND tenant_id=NEW.tenant_id FOR SHARE;
  PERFORM 1 FROM public.patients WHERE id=NEW.patient_id AND tenant_id=NEW.tenant_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND OR r.id IS NULL OR r.deleted_at IS NOT NULL OR r.uploaded_at IS NULL OR r.type<>'structured' OR
     r.patient_id<>NEW.patient_id OR r.sha256 IS DISTINCT FROM NEW.report_sha256 OR r.object_version IS DISTINCT FROM NEW.object_version OR
     public.patient_merged_into(NEW.tenant_id,NEW.patient_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Source or patient changed.' USING ERRCODE='SR001';
  END IF;
  SELECT * INTO d FROM public.report_patient_decisions WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id ORDER BY seq DESC LIMIT 1;
  IF d.id IS DISTINCT FROM NEW.patient_link_decision_id OR d.decision IS DISTINCT FROM 'verified' OR d.patient_id<>NEW.patient_id OR
     d.report_sha256 IS DISTINCT FROM NEW.report_sha256 OR d.object_version IS DISTINCT FROM NEW.object_version THEN
    RAISE EXCEPTION 'The independent patient link changed.' USING ERRCODE='SR001';
  END IF;
  IF (SELECT count(*) FROM public.structured_report_revisions WHERE tenant_id=NEW.tenant_id AND patient_id=NEW.patient_id AND id<>NEW.id)>=100 THEN
    RAISE EXCEPTION 'The bounded registry is full.' USING ERRCODE='SR002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.structured_report_revisions s WHERE s.tenant_id=NEW.tenant_id AND s.patient_id<>NEW.patient_id AND
    s.laboratory_report->>'laboratoryId'=NEW.laboratory_report->>'laboratoryId' AND
    (s.laboratory_report->>'seriesId'=NEW.laboratory_report->>'seriesId' OR s.laboratory_report->>'accession'=NEW.laboratory_report->>'accession' OR s.laboratory_report->>'id'=NEW.laboratory_report->>'id')) THEN
    RAISE EXCEPTION 'Laboratory identity needs reconciliation.' USING ERRCODE='SR003';
  END IF;
  IF TG_WHEN='BEFORE' THEN NEW.created_at:=clock_timestamp(); END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION structured_report_revision_check() FROM PUBLIC;
CREATE TRIGGER structured_report_revision_check BEFORE INSERT ON structured_report_revisions FOR EACH ROW EXECUTE FUNCTION structured_report_revision_check();
CREATE CONSTRAINT TRIGGER structured_report_revision_current AFTER INSERT ON structured_report_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION structured_report_revision_check();
CREATE CONSTRAINT TRIGGER structured_report_revision_has_event AFTER INSERT ON structured_report_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER structured_report_revisions_append_only BEFORE UPDATE OR DELETE ON structured_report_revisions FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER structured_report_revisions_no_truncate BEFORE TRUNCATE ON structured_report_revisions FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
ALTER TABLE structured_report_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE structured_report_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY structured_report_revisions_tenant ON structured_report_revisions FOR ALL TO telesphoros_app USING (tenant_id=(SELECT public.app_tenant())) WITH CHECK (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY structured_report_revisions_ledger ON structured_report_revisions FOR SELECT TO telesphoros_ledger USING (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY structured_report_revisions_verifier ON structured_report_revisions FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON structured_report_revisions FROM PUBLIC;
GRANT SELECT,INSERT ON structured_report_revisions TO telesphoros_app;
GRANT SELECT ON structured_report_revisions TO telesphoros_ledger,telesphoros_ledger_verifier;
-- Derived from immutable, ledger-covered JSON, so a finding cannot drift from its source or lose a limitation.
CREATE VIEW structured_report_findings WITH (security_invoker=true,security_barrier=true) AS
SELECT r.id AS revision_id,r.tenant_id,r.patient_id,r.report_id,f.value->>'id' AS source_finding_id,
  f.value->>'targetId' AS target_id,f.value->>'gene' AS gene,f.value->>'orderScope' AS order_scope,
  f.value->>'coverage' AS coverage,f.value->>'analyticalState' AS analytical_state,f.value->>'interpretationState' AS interpretation_state,
  f.value->'reportedCall' AS reported_call,f.value->'laboratoryInterpretation' AS laboratory_interpretation,f.value->'limitations' AS limitations,
  f.value AS finding,r.laboratory_report->'assay' AS assay
FROM structured_report_revisions r CROSS JOIN LATERAL jsonb_array_elements(r.laboratory_report->'findings') AS f(value);
REVOKE ALL ON structured_report_findings FROM PUBLIC;
GRANT SELECT ON structured_report_findings TO telesphoros_app,telesphoros_ledger,telesphoros_ledger_verifier;

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'result-acknowledgement', 'data-provenance', 'use-grant', 'use-grant-validation', 'use-withdrawal', 'use-restriction', 'tenant-use-terms', 'patient-demographics', 'patient-medication', 'patient-followup', 'structured-report-revision', 'redaction', 'checkpoint'));
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
