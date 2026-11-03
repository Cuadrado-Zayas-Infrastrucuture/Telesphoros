-- compat: breaking
-- New ledger record types require a coordinated writer/verifier rollout. Synthetic-only API remains local.
-- Independent review of stored synthetic laboratory findings, and explicit resolution of conflicting stored sources.
-- Both tables are append-only evidence. A decision never edits a revision and never makes a finding actionable.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE structured_finding_reviews (
  seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  request_id uuid NOT NULL,
  revision_id uuid NOT NULL REFERENCES structured_report_revisions(id) ON DELETE RESTRICT,
  report_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  object_version text NOT NULL CHECK (length(object_version) BETWEEN 1 AND 1024),
  patient_link_decision_id uuid NOT NULL REFERENCES report_patient_decisions(id) ON DELETE RESTRICT,
  source_finding_id text NOT NULL CHECK (source_finding_id ~ '^syn-[a-z0-9-]{1,76}$'),
  decision text NOT NULL CHECK (decision IN ('accepted-as-evidence', 'rejected', 'held')),
  reason_code text NOT NULL CHECK (reason_code IN ('matches-source', 'does-not-match-source', 'source-unreadable', 'needs-clarification', 'source-uncertain')),
  CONSTRAINT structured_finding_reviews_request_uq UNIQUE (tenant_id, created_by, request_id),
  CONSTRAINT structured_finding_reviews_reason CHECK (
    (decision = 'accepted-as-evidence' AND reason_code = 'matches-source') OR
    (decision = 'rejected' AND reason_code IN ('does-not-match-source', 'source-unreadable')) OR
    (decision = 'held' AND reason_code IN ('needs-clarification', 'source-uncertain'))),
  CONSTRAINT structured_finding_reviews_report_fk FOREIGN KEY (report_id, tenant_id) REFERENCES reports(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT structured_finding_reviews_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT structured_finding_reviews_event_fk FOREIGN KEY (ledger_event_id, tenant_id) REFERENCES ledger_events(id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX structured_finding_reviews_revision_idx ON structured_finding_reviews(tenant_id, revision_id, source_finding_id, seq);
CREATE INDEX structured_finding_reviews_event_idx ON structured_finding_reviews(ledger_event_id, tenant_id);

CREATE TABLE structured_source_resolutions (
  seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  request_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  laboratory_id text NOT NULL CHECK (laboratory_id ~ '^syn-[a-z0-9-]{1,76}$'),
  series_id text NOT NULL CHECK (series_id ~ '^syn-[a-z0-9-]{1,76}$'),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  -- The exact conflicting set the resolver looked at, stored sorted. A later source for the series makes this resolution stale.
  revision_ids uuid[] NOT NULL CHECK (cardinality(revision_ids) BETWEEN 2 AND 100),
  outcome text NOT NULL CHECK (outcome IN ('use-revision', 'none-usable', 'keep-held')),
  chosen_revision_id uuid,
  reason_code text NOT NULL CHECK (reason_code IN ('verified-against-laboratory', 'sources-unreliable', 'cannot-establish', 'awaiting-laboratory')),
  CONSTRAINT structured_source_resolutions_request_uq UNIQUE (tenant_id, created_by, request_id),
  CONSTRAINT structured_source_resolutions_shape CHECK (
    (outcome = 'use-revision' AND reason_code = 'verified-against-laboratory' AND chosen_revision_id IS NOT NULL AND chosen_revision_id = ANY(revision_ids)) OR
    (outcome = 'none-usable' AND reason_code IN ('sources-unreliable', 'cannot-establish') AND chosen_revision_id IS NULL) OR
    (outcome = 'keep-held' AND reason_code = 'awaiting-laboratory' AND chosen_revision_id IS NULL)),
  CONSTRAINT structured_source_resolutions_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT structured_source_resolutions_event_fk FOREIGN KEY (ledger_event_id, tenant_id) REFERENCES ledger_events(id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX structured_source_resolutions_series_idx ON structured_source_resolutions(tenant_id, patient_id, laboratory_id, series_id, revision, seq);
CREATE INDEX structured_source_resolutions_event_idx ON structured_source_resolutions(ledger_event_id, tenant_id);

-- Error codes: SR001 source/patient/link changed, SR004 reviewer not independent, SR005 unknown finding,
-- SR006 revision is superseded or its conflict is not resolved in its favour, SR007 conflict set changed, SR008 not a conflict.
CREATE FUNCTION structured_finding_review_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE v public.structured_report_revisions%ROWTYPE; r public.reports%ROWTYPE; d public.report_patient_decisions%ROWTYPE;
  member text; member_version bigint; lab text; ser text; rev numeric; grp uuid[]; conflicted boolean; res_outcome text; res_chosen uuid;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Use the bound actor and organization.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT sub,version INTO member,member_version FROM public.tenant_memberships WHERE tenant_id=NEW.tenant_id AND sub=NEW.created_by AND status='active' AND roles && ARRAY['reviewer'];
  IF member IS NULL OR NOT public.membership_assert_current(member,member_version) THEN RAISE EXCEPTION 'A current reviewer is required.' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('structured-pgx:' || NEW.tenant_id,0));
  SELECT * INTO v FROM public.structured_report_revisions WHERE id=NEW.revision_id AND tenant_id=NEW.tenant_id;
  IF NOT FOUND OR v.report_id<>NEW.report_id OR v.patient_id<>NEW.patient_id OR v.report_sha256<>NEW.report_sha256 OR
     v.object_version<>NEW.object_version OR v.patient_link_decision_id<>NEW.patient_link_decision_id THEN
    RAISE EXCEPTION 'The stored revision does not match this review.' USING ERRCODE='SR001';
  END IF;
  SELECT * INTO r FROM public.reports WHERE id=v.report_id AND tenant_id=v.tenant_id FOR SHARE;
  PERFORM 1 FROM public.patients WHERE id=v.patient_id AND tenant_id=v.tenant_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND OR r.id IS NULL OR r.deleted_at IS NOT NULL OR r.uploaded_at IS NULL OR r.patient_id<>v.patient_id OR
     r.sha256 IS DISTINCT FROM v.report_sha256 OR r.object_version IS DISTINCT FROM v.object_version OR
     public.patient_merged_into(v.tenant_id,v.patient_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Source or patient changed.' USING ERRCODE='SR001';
  END IF;
  SELECT * INTO d FROM public.report_patient_decisions WHERE tenant_id=v.tenant_id AND report_id=v.report_id ORDER BY seq DESC LIMIT 1;
  IF d.id IS DISTINCT FROM NEW.patient_link_decision_id OR d.decision IS DISTINCT FROM 'verified' OR d.patient_id<>v.patient_id OR
     d.report_sha256 IS DISTINCT FROM v.report_sha256 OR d.object_version IS DISTINCT FROM v.object_version THEN
    RAISE EXCEPTION 'The independent patient link changed.' USING ERRCODE='SR001';
  END IF;
  IF NEW.created_by IN (v.created_by, r.created_by, r.upload_requested_by, r.uploaded_by) THEN
    RAISE EXCEPTION 'Findings are reviewed by someone other than the people who uploaded or saved them.' USING ERRCODE='SR004';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.laboratory_report->'findings') f WHERE f.value->>'id'=NEW.source_finding_id) THEN
    RAISE EXCEPTION 'The finding is not part of this stored revision.' USING ERRCODE='SR005';
  END IF;
  lab:=v.laboratory_report->>'laboratoryId'; ser:=v.laboratory_report->>'seriesId'; rev:=(v.laboratory_report->>'revision')::numeric;
  IF EXISTS (SELECT 1 FROM public.structured_report_revisions s WHERE s.tenant_id=v.tenant_id AND s.patient_id=v.patient_id AND
      s.laboratory_report->>'laboratoryId'=lab AND s.laboratory_report->>'seriesId'=ser AND (s.laboratory_report->>'revision')::numeric>rev) THEN
    RAISE EXCEPTION 'A later stored revision supersedes this one.' USING ERRCODE='SR006';
  END IF;
  SELECT array_agg(s.id ORDER BY s.id), (count(DISTINCT s.report_sha256)>1 OR count(DISTINCT s.laboratory_report)>1) INTO grp, conflicted
    FROM public.structured_report_revisions s WHERE s.tenant_id=v.tenant_id AND s.patient_id=v.patient_id AND
      s.laboratory_report->>'laboratoryId'=lab AND s.laboratory_report->>'seriesId'=ser AND (s.laboratory_report->>'revision')::numeric=rev;
  IF conflicted THEN
    SELECT x.outcome,x.chosen_revision_id INTO res_outcome,res_chosen FROM public.structured_source_resolutions x
      WHERE x.tenant_id=v.tenant_id AND x.patient_id=v.patient_id AND x.laboratory_id=lab AND x.series_id=ser AND x.revision=rev AND x.revision_ids=grp
      ORDER BY x.seq DESC LIMIT 1;
    IF res_outcome IS DISTINCT FROM 'use-revision' OR res_chosen IS DISTINCT FROM NEW.revision_id THEN
      RAISE EXCEPTION 'Conflicting sources must be resolved in favour of this revision first.' USING ERRCODE='SR006';
    END IF;
  END IF;
  IF TG_WHEN='BEFORE' THEN NEW.created_at:=clock_timestamp(); END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION structured_finding_review_check() FROM PUBLIC;

CREATE FUNCTION structured_source_resolution_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE member text; member_version bigint; grp uuid[]; sorted uuid[]; conflicted boolean; bad integer;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.created_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Use the bound actor and organization.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT sub,version INTO member,member_version FROM public.tenant_memberships WHERE tenant_id=NEW.tenant_id AND sub=NEW.created_by AND status='active' AND roles && ARRAY['reviewer'];
  IF member IS NULL OR NOT public.membership_assert_current(member,member_version) THEN RAISE EXCEPTION 'A current reviewer is required.' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('structured-pgx:' || NEW.tenant_id,0));
  PERFORM 1 FROM public.patients WHERE id=NEW.patient_id AND tenant_id=NEW.tenant_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND OR public.patient_merged_into(NEW.tenant_id,NEW.patient_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Source or patient changed.' USING ERRCODE='SR001';
  END IF;
  SELECT array_agg(s.id ORDER BY s.id), (count(DISTINCT s.report_sha256)>1 OR count(DISTINCT s.laboratory_report)>1) INTO grp, conflicted
    FROM public.structured_report_revisions s WHERE s.tenant_id=NEW.tenant_id AND s.patient_id=NEW.patient_id AND
      s.laboratory_report->>'laboratoryId'=NEW.laboratory_id AND s.laboratory_report->>'seriesId'=NEW.series_id AND (s.laboratory_report->>'revision')::numeric=NEW.revision;
  SELECT array_agg(x ORDER BY x) INTO sorted FROM unnest(NEW.revision_ids) x;
  IF grp IS NULL OR grp IS DISTINCT FROM sorted THEN
    RAISE EXCEPTION 'The conflicting source set changed.' USING ERRCODE='SR007';
  END IF;
  IF conflicted IS NOT TRUE THEN
    RAISE EXCEPTION 'These stored sources do not conflict.' USING ERRCODE='SR008';
  END IF;
  IF EXISTS (SELECT 1 FROM public.structured_report_revisions s WHERE s.tenant_id=NEW.tenant_id AND s.patient_id=NEW.patient_id AND
      s.laboratory_report->>'laboratoryId'=NEW.laboratory_id AND s.laboratory_report->>'seriesId'=NEW.series_id AND (s.laboratory_report->>'revision')::numeric>NEW.revision) THEN
    RAISE EXCEPTION 'A later stored revision supersedes these sources.' USING ERRCODE='SR006';
  END IF;
  SELECT count(*) INTO bad FROM public.structured_report_revisions s
    LEFT JOIN public.reports r ON r.id=s.report_id AND r.tenant_id=s.tenant_id
    LEFT JOIN LATERAL (SELECT * FROM public.report_patient_decisions WHERE tenant_id=s.tenant_id AND report_id=s.report_id ORDER BY seq DESC LIMIT 1) d ON true
    WHERE s.id=ANY(grp) AND NOT COALESCE(r.deleted_at IS NULL AND r.uploaded_at IS NOT NULL AND r.patient_id=s.patient_id AND r.sha256=s.report_sha256 AND
      r.object_version=s.object_version AND d.id=s.patient_link_decision_id AND d.decision='verified' AND d.patient_id=s.patient_id AND
      d.report_sha256=s.report_sha256 AND d.object_version=s.object_version, false);
  IF bad>0 THEN RAISE EXCEPTION 'A conflicting source or its patient link changed.' USING ERRCODE='SR001'; END IF;
  IF EXISTS (SELECT 1 FROM public.structured_report_revisions s JOIN public.reports r ON r.id=s.report_id AND r.tenant_id=s.tenant_id
      WHERE s.id=ANY(grp) AND NEW.created_by IN (s.created_by, r.created_by, r.upload_requested_by, r.uploaded_by)) THEN
    RAISE EXCEPTION 'Conflicting sources are resolved by someone other than the people who uploaded or saved them.' USING ERRCODE='SR004';
  END IF;
  IF TG_WHEN='BEFORE' THEN NEW.revision_ids:=sorted; NEW.created_at:=clock_timestamp(); END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION structured_source_resolution_check() FROM PUBLIC;

CREATE TRIGGER structured_finding_review_check BEFORE INSERT ON structured_finding_reviews FOR EACH ROW EXECUTE FUNCTION structured_finding_review_check();
CREATE CONSTRAINT TRIGGER structured_finding_review_current AFTER INSERT ON structured_finding_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION structured_finding_review_check();
CREATE CONSTRAINT TRIGGER structured_finding_review_has_event AFTER INSERT ON structured_finding_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER structured_finding_reviews_append_only BEFORE UPDATE OR DELETE ON structured_finding_reviews FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER structured_finding_reviews_no_truncate BEFORE TRUNCATE ON structured_finding_reviews FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER structured_source_resolution_check BEFORE INSERT ON structured_source_resolutions FOR EACH ROW EXECUTE FUNCTION structured_source_resolution_check();
CREATE CONSTRAINT TRIGGER structured_source_resolution_current AFTER INSERT ON structured_source_resolutions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION structured_source_resolution_check();
CREATE CONSTRAINT TRIGGER structured_source_resolution_has_event AFTER INSERT ON structured_source_resolutions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER structured_source_resolutions_append_only BEFORE UPDATE OR DELETE ON structured_source_resolutions FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER structured_source_resolutions_no_truncate BEFORE TRUNCATE ON structured_source_resolutions FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE structured_finding_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE structured_finding_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY structured_finding_reviews_tenant ON structured_finding_reviews FOR ALL TO telesphoros_app USING (tenant_id=(SELECT public.app_tenant())) WITH CHECK (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY structured_finding_reviews_ledger ON structured_finding_reviews FOR SELECT TO telesphoros_ledger USING (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY structured_finding_reviews_verifier ON structured_finding_reviews FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON structured_finding_reviews FROM PUBLIC;
GRANT SELECT,INSERT ON structured_finding_reviews TO telesphoros_app;
GRANT SELECT ON structured_finding_reviews TO telesphoros_ledger,telesphoros_ledger_verifier;
ALTER TABLE structured_source_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE structured_source_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY structured_source_resolutions_tenant ON structured_source_resolutions FOR ALL TO telesphoros_app USING (tenant_id=(SELECT public.app_tenant())) WITH CHECK (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY structured_source_resolutions_ledger ON structured_source_resolutions FOR SELECT TO telesphoros_ledger USING (tenant_id=(SELECT public.app_tenant()));
CREATE POLICY structured_source_resolutions_verifier ON structured_source_resolutions FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON structured_source_resolutions FROM PUBLIC;
GRANT SELECT,INSERT ON structured_source_resolutions TO telesphoros_app;
GRANT SELECT ON structured_source_resolutions TO telesphoros_ledger,telesphoros_ledger_verifier;

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision',
   'patient-merge-proposal', 'patient-merge-decision', 'clinician-result-decision', 'result-acknowledgement', 'data-provenance', 'use-grant', 'use-grant-validation', 'use-withdrawal', 'use-restriction', 'tenant-use-terms', 'patient-demographics', 'patient-medication', 'patient-followup', 'structured-report-revision', 'structured-finding-review', 'structured-source-resolution', 'redaction', 'checkpoint'));
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
