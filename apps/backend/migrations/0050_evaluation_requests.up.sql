-- compat: breaking
-- Inactive durable evaluation admission. All objects are new; the TRUNCATE guards require the conservative breaking label under current lint.
-- No route, schedule, outbox route, consumer, model call or clinical writer is enabled by this migration.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- Like the ledger's parent keys, the jobs key belongs to its NOLOGIN owner. The migrator needs this narrow DDL privilege for the new foreign key.
SET LOCAL ROLE telesphoros_jobs;
DO $$ BEGIN EXECUTE format('GRANT REFERENCES (id) ON public.jobs TO %I', session_user); END $$;
RESET ROLE;

-- The existing membership lock is SECURITY DEFINER. With a non-superuser migration
-- owner, its identity-accessor dependencies need EXECUTE for that owner, including
-- the capability-present branch. Grant to the function owner, never a runtime role.
SET LOCAL ROLE telesphoros_capability;
DO $$ DECLARE owner_name text; BEGIN
  SELECT pg_get_userbyid(proowner) INTO owner_name FROM pg_proc WHERE oid = 'public.membership_assert_current(text,bigint)'::regprocedure;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.app_tenant_bound(), public.app_actor(), public.app_capability_version() TO %I', owner_name);
END $$;
RESET ROLE;

-- Only this narrow helper runs as the existing ledger owner. It locks/checks its OWN tenant's head; it grants the application no ledger DML.
GRANT CREATE ON SCHEMA public TO telesphoros_ledger;
SET LOCAL ROLE telesphoros_ledger;
CREATE FUNCTION evaluation_request_lock() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE t text := public.app_tenant();
BEGIN
  IF t IS NULL OR public.app_actor() IS NULL THEN
    RAISE EXCEPTION 'Evaluation admission is not authorized.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM public.ledger_heads WHERE tenant_id = t FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evaluation evidence is unavailable.' USING ERRCODE = 'ER001'; END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_incidents i WHERE (i.scope = 'global' OR i.tenant_id = t)
    AND NOT EXISTS (SELECT 1 FROM public.ledger_incident_clearances c WHERE c.incident_id = i.id)) THEN
    RAISE EXCEPTION 'Writes to the record log are stopped.' USING ERRCODE = 'LC001';
  END IF;
END $$;
REVOKE ALL ON FUNCTION evaluation_request_lock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluation_request_lock() TO telesphoros_app;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;

CREATE FUNCTION evaluation_request_authorize(p_write boolean) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE t text := public.app_tenant(); a text := public.app_actor(); v bigint;
BEGIN
  IF t IS NULL OR a IS NULL OR p_write IS NULL THEN
    RAISE EXCEPTION 'Evaluation request access is not authorized.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT version INTO v FROM public.tenant_memberships WHERE tenant_id = t AND sub = a AND status = 'active'
    AND roles && CASE WHEN p_write THEN ARRAY['clinician','reviewer']::text[] ELSE ARRAY['clinician','reviewer','reader']::text[] END;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evaluation request access is not authorized.' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_write AND NOT public.membership_assert_current(a, v) THEN
    RAISE EXCEPTION 'Evaluation request access is not authorized.' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;
REVOKE ALL ON FUNCTION evaluation_request_authorize(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluation_request_authorize(boolean) TO telesphoros_app;

-- Invoker permissions/RLS throughout. Lock order follows the decision writer: report SHARE, then ledger head, then fresh decision reads.
CREATE FUNCTION evaluation_request_basis(p_report uuid, p_capture uuid, p_acceptance uuid) RETURNS jsonb LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE t text := public.app_tenant(); r public.reports%ROWTYPE; c public.report_captures%ROWTYPE;
  a public.capture_acceptances%ROWTYPE; d public.report_patient_decisions%ROWTYPE;
BEGIN
  PERFORM public.evaluation_request_authorize(true);
  SELECT * INTO r FROM public.reports WHERE tenant_id = t AND id = p_report FOR SHARE;
  IF NOT FOUND OR r.deleted_at IS NOT NULL OR r.type <> 'lab-pdf' OR r.uploaded_at IS NULL OR r.sha256 IS NULL OR r.object_version IS NULL THEN
    RAISE EXCEPTION 'Evaluation evidence is unavailable.' USING ERRCODE = 'ER001';
  END IF;
  PERFORM public.evaluation_request_lock();
  SELECT * INTO c FROM public.report_captures WHERE tenant_id = t AND id = p_capture AND report_id = p_report;
  IF NOT FOUND OR c.pdf_sha256 IS DISTINCT FROM r.sha256 THEN
    RAISE EXCEPTION 'Evaluation evidence is unavailable.' USING ERRCODE = 'ER001';
  END IF;
  SELECT * INTO a FROM public.capture_acceptances WHERE tenant_id = t AND capture_id = p_capture ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND OR a.id IS DISTINCT FROM p_acceptance OR a.decision <> 'accepted'
    OR a.text_sha256 IS DISTINCT FROM c.text_sha256 OR a.poppler_version IS DISTINCT FROM c.poppler_version THEN
    RAISE EXCEPTION 'Evaluation evidence is unavailable.' USING ERRCODE = 'ER001';
  END IF;
  SELECT * INTO d FROM public.report_patient_decisions WHERE tenant_id = t AND report_id = p_report ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND OR d.decision <> 'verified' OR d.patient_id IS DISTINCT FROM r.patient_id
    OR d.report_sha256 IS DISTINCT FROM r.sha256 OR d.object_version IS DISTINCT FROM r.object_version THEN
    RAISE EXCEPTION 'Evaluation evidence is unavailable.' USING ERRCODE = 'ER001';
  END IF;
  RETURN jsonb_build_object('patientId',r.patient_id,'patientLinkDecisionId',d.id,'reportSha256',r.sha256,'objectVersion',r.object_version,
    'textSha256',c.text_sha256,'textStorageKey',c.text_storage_key,'popplerVersion',c.poppler_version,'captureRunner',c.runner);
END $$;
REVOKE ALL ON FUNCTION evaluation_request_basis(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluation_request_basis(uuid,uuid,uuid) TO telesphoros_app;

-- Versioned, provider-neutral manifest identity. Provider/model/prompt/decoding details belong to the pinned manifest, never queue payloads.
CREATE FUNCTION evaluation_request_profile_valid(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p) <> 'object' THEN false ELSE coalesce(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) = ARRAY['codeArtifactSha256','executionManifestSha256','knowledgeSetId','recordingsSha256','version']
    AND p->>'version' = 'evaluation-execution-profile/1'
    AND jsonb_typeof(p->'version') = 'string' AND jsonb_typeof(p->'codeArtifactSha256') = 'string'
    AND jsonb_typeof(p->'executionManifestSha256') = 'string' AND jsonb_typeof(p->'knowledgeSetId') = 'string' AND jsonb_typeof(p->'recordingsSha256') = 'string'
    AND p->>'codeArtifactSha256' ~ '^[0-9a-f]{64}$' AND p->>'executionManifestSha256' ~ '^[0-9a-f]{64}$'
    AND p->>'knowledgeSetId' ~ '^[0-9a-f]{64}$' AND p->>'recordingsSha256' ~ '^[0-9a-f]{64}$', false) END
$$;
CREATE FUNCTION evaluation_request_fingerprint(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp AS $$ SELECT encode(sha256(convert_to(p::text,'UTF8')),'hex') $$;
REVOKE ALL ON FUNCTION evaluation_request_profile_valid(jsonb), evaluation_request_fingerprint(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluation_request_profile_valid(jsonb), evaluation_request_fingerprint(jsonb) TO telesphoros_app;

CREATE TABLE evaluation_requests (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 128),
  creation_request_id uuid NOT NULL,
  fingerprint text NOT NULL DEFAULT repeat('0',64) CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  report_id uuid NOT NULL,
  capture_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  basis jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object'),
  execution_profile jsonb NOT NULL CHECK (evaluation_request_profile_valid(execution_profile)),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, requested_by, creation_request_id),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (report_id, tenant_id) REFERENCES reports(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (capture_id, tenant_id) REFERENCES report_captures(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (acceptance_id, tenant_id) REFERENCES capture_acceptances(id,tenant_id) ON DELETE RESTRICT
);
CREATE INDEX evaluation_requests_tenant_report ON evaluation_requests(tenant_id,report_id);

-- Reserved for H3's fenced clinical completion. No runtime role can INSERT here in H1.
CREATE TABLE evaluation_request_completions (
  request_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  evaluation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (request_id,tenant_id) REFERENCES evaluation_requests(id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (evaluation_id,tenant_id) REFERENCES evaluations(id,tenant_id) ON DELETE RESTRICT
);

CREATE FUNCTION evaluation_request_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE b jsonb; j public.jobs%ROWTYPE;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.requested_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Evaluation admission is not authorized.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  b := public.evaluation_request_basis(NEW.report_id,NEW.capture_id,NEW.acceptance_id);
  IF NEW.basis IS DISTINCT FROM b THEN RAISE EXCEPTION 'Evaluation binding changed.' USING ERRCODE = 'ER001'; END IF;
  SELECT * INTO j FROM public.jobs WHERE tenant_id = NEW.tenant_id AND id = NEW.job_id;
  IF NOT FOUND OR j.type <> 'evaluations.request' OR j.payload IS DISTINCT FROM jsonb_build_object('requestId',NEW.id)
    OR j.requested_by IS DISTINCT FROM NEW.requested_by OR j.idempotency_key IS DISTINCT FROM 'evaluation-request:' || NEW.id::text THEN
    RAISE EXCEPTION 'Evaluation job binding is invalid.' USING ERRCODE = 'ER001';
  END IF;
  NEW.fingerprint := public.evaluation_request_fingerprint(jsonb_build_object('reportId',NEW.report_id,'captureId',NEW.capture_id,
    'acceptanceId',NEW.acceptance_id,'basis',b,'executionProfile',NEW.execution_profile));
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION evaluation_request_check() FROM PUBLIC;
CREATE TRIGGER evaluation_request_check BEFORE INSERT ON evaluation_requests FOR EACH ROW EXECUTE FUNCTION evaluation_request_check();
CREATE TRIGGER evaluation_requests_append_only BEFORE UPDATE OR DELETE ON evaluation_requests FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluation_requests_no_truncate BEFORE TRUNCATE ON evaluation_requests FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluation_completions_append_only BEFORE UPDATE OR DELETE ON evaluation_request_completions FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluation_completions_no_truncate BEFORE TRUNCATE ON evaluation_request_completions FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE evaluation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_request_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_request_completions FORCE ROW LEVEL SECURITY;
CREATE POLICY evaluation_requests_read ON evaluation_requests FOR SELECT TO telesphoros_app USING (tenant_id = app_tenant());
CREATE POLICY evaluation_requests_insert ON evaluation_requests FOR INSERT TO telesphoros_app WITH CHECK (tenant_id = app_tenant());
CREATE POLICY evaluation_completions_read ON evaluation_request_completions FOR SELECT TO telesphoros_app USING (tenant_id = app_tenant());
REVOKE ALL ON evaluation_requests, evaluation_request_completions FROM PUBLIC;
GRANT SELECT, INSERT ON evaluation_requests TO telesphoros_app;
GRANT SELECT ON evaluation_request_completions TO telesphoros_app;
