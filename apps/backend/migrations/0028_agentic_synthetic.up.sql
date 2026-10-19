-- Inactive synthetic fixture schema. No grants, sources, jobs, schedules or routes are seeded.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs;
GRANT EXECUTE ON FUNCTION public.membership_assert_current(text, bigint) TO telesphoros_jobs;
SET LOCAL ROLE telesphoros_jobs;

CREATE TABLE public.agentic_synthetic_capacity (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  tenant_day_units bigint NOT NULL CHECK (tenant_day_units = 5000000),
  fleet_month_units bigint NOT NULL CHECK (fleet_month_units = 300000000)
);

CREATE TABLE public.agentic_synthetic_grants (
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  grant_id uuid NOT NULL,
  requester_ref text NOT NULL CHECK (length(requester_ref) BETWEEN 1 AND 128),
  generation bigint NOT NULL CHECK (generation > 0),
  purpose text NOT NULL CHECK (purpose = 'business-assistance'),
  capabilities text[] NOT NULL CHECK (capabilities @> ARRAY['business.sop.read','business.sop.draft']::text[]
    AND capabilities <@ ARRAY['business.sop.read','business.sop.draft']::text[]),
  enabled boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, grant_id)
);

CREATE TABLE public.agentic_synthetic_sources (
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  body text NOT NULL CHECK (octet_length(body) <= 16384),
  eligible boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, source_id, source_version)
);

CREATE TABLE public.agentic_synthetic_grant_sources (
  tenant_id text NOT NULL,
  grant_id uuid NOT NULL,
  source_id text NOT NULL,
  source_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, grant_id, source_id, source_version),
  FOREIGN KEY (tenant_id, grant_id) REFERENCES public.agentic_synthetic_grants(tenant_id, grant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_id, source_version) REFERENCES public.agentic_synthetic_sources(tenant_id, source_id, source_version) ON DELETE RESTRICT
);

CREATE TABLE public.agentic_synthetic_runs (
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL DEFAULT gen_random_uuid(),
  requester_ref text NOT NULL CHECK (length(requester_ref) BETWEEN 1 AND 128),
  task_key text NOT NULL CHECK (task_key = 'business.sop-draft.v1'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:/_-]{1,96}$'),
  request_json jsonb NOT NULL CHECK (jsonb_typeof(request_json) = 'object' AND pg_column_size(request_json) <= 4096),
  request_tuple_preimage text NOT NULL CHECK (octet_length(request_tuple_preimage) <= 4096),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^sha256:[0-9a-f]{64}$'),
  grant_id uuid NOT NULL,
  grant_generation bigint NOT NULL CHECK (grant_generation > 0),
  membership_version bigint NOT NULL CHECK (membership_version > 0),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'array' AND pg_column_size(source_snapshot) <= 2048),
  evidence_tuple_preimage text NOT NULL CHECK (octet_length(evidence_tuple_preimage) <= 2048),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('admitted','queued','running','reviewing','repair-pending','release-pending','released','held','failed','cancelled','expired')),
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  claim_id uuid,
  -- The exact existing-queue claim instance the stamp was minted for (jobs.started_at).
  claim_started_at timestamptz,
  job_id uuid UNIQUE REFERENCES public.jobs(id) ON DELETE RESTRICT,
  admitted_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  last_guarded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (run_id),
  UNIQUE (tenant_id, requester_ref, task_key, idempotency_key),
  FOREIGN KEY (tenant_id, grant_id) REFERENCES public.agentic_synthetic_grants(tenant_id, grant_id) ON DELETE RESTRICT,
  CHECK (deadline_at = admitted_at + interval '120 seconds')
);
CREATE INDEX agentic_synthetic_runs_job_idx ON public.agentic_synthetic_runs(job_id);

CREATE TABLE public.agentic_synthetic_reservations (
  tenant_id text NOT NULL,
  run_id uuid NOT NULL,
  original_day date NOT NULL,
  original_month date NOT NULL,
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens = 28160),
  reserved_cost bigint NOT NULL CHECK (reserved_cost = 250000),
  observed_input bigint NOT NULL DEFAULT 0 CHECK (observed_input BETWEEN 0 AND 24576),
  observed_generated bigint NOT NULL DEFAULT 0 CHECK (observed_generated BETWEEN 0 AND 3584),
  usage_state text NOT NULL CHECK (usage_state IN ('known','unknown')),
  in_flight boolean NOT NULL DEFAULT true,
  settled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.agentic_synthetic_runs(tenant_id, run_id) ON DELETE RESTRICT,
  CHECK (NOT settled OR usage_state = 'known')
);

CREATE TABLE public.agentic_synthetic_buckets (
  scope text NOT NULL CHECK (scope IN ('tenant','fleet')),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 128),
  period_kind text NOT NULL CHECK (period_kind IN ('day','month')),
  period_start date NOT NULL,
  limit_units bigint NOT NULL CHECK (limit_units > 0),
  reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  consumed_units bigint NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  PRIMARY KEY (scope, scope_key, period_kind, period_start),
  CHECK ((scope = 'tenant' AND period_kind = 'day' AND limit_units = 5000000) OR
         (scope = 'fleet' AND scope_key = 'fleet' AND period_kind = 'month' AND limit_units = 300000000)),
  CHECK (reserved_units + consumed_units <= limit_units)
);

CREATE TABLE public.agentic_synthetic_invocations (
  tenant_id text NOT NULL,
  run_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('draft','director')),
  ordinal integer NOT NULL CHECK (ordinal IN (1,2)),
  invocation_id uuid NOT NULL UNIQUE,
  input_digest text NOT NULL CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  candidate_digest text CHECK (candidate_digest IS NULL OR candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  dispatch_started_at timestamptz NOT NULL,
  observation jsonb CHECK (observation IS NULL OR (jsonb_typeof(observation) = 'object' AND pg_column_size(observation) <= 512)),
  usage_state text NOT NULL CHECK (usage_state IN ('known','unknown')),
  artifact jsonb CHECK (artifact IS NULL OR (jsonb_typeof(artifact) = 'object' AND pg_column_size(artifact) <= 16384)),
  PRIMARY KEY (tenant_id, run_id, role, ordinal),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.agentic_synthetic_runs(tenant_id, run_id) ON DELETE RESTRICT
);

CREATE TABLE public.agentic_synthetic_outcomes (
  tenant_id text NOT NULL,
  run_id uuid NOT NULL,
  simulation_receipt_ref text UNIQUE,
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 16384),
  outcome_digest text NOT NULL CHECK (outcome_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.agentic_synthetic_runs(tenant_id, run_id) ON DELETE RESTRICT
);

CREATE TABLE public.agentic_synthetic_audit (
  tenant_id text NOT NULL,
  run_id uuid NOT NULL,
  event_sequence bigint NOT NULL CHECK (event_sequence >= 0),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  artifact_digest text CHECK (artifact_digest IS NULL OR artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  fence bigint NOT NULL CHECK (fence >= 0),
  reserved_units bigint NOT NULL CHECK (reserved_units >= 0),
  observed_units bigint NOT NULL CHECK (observed_units >= 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id, event_sequence),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.agentic_synthetic_runs(tenant_id, run_id) ON DELETE RESTRICT
);

CREATE FUNCTION public.agentic_synthetic_source_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.digest <> 'sha256:' || encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'Synthetic source digest mismatch.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.source_id, NEW.source_version, NEW.digest, NEW.body)
    IS DISTINCT FROM (OLD.tenant_id, OLD.source_id, OLD.source_version, OLD.digest, OLD.body) THEN
    RAISE EXCEPTION 'Synthetic source identity is immutable.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.eligible AND NOT OLD.eligible THEN
    RAISE EXCEPTION 'Synthetic source eligibility cannot be restored.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.agentic_synthetic_source_guard() FROM PUBLIC;
CREATE TRIGGER agentic_synthetic_source_guard BEFORE INSERT OR UPDATE ON public.agentic_synthetic_sources
FOR EACH ROW EXECUTE FUNCTION public.agentic_synthetic_source_guard();

CREATE FUNCTION public.agentic_synthetic_refuse_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Synthetic record is immutable.' USING ERRCODE = 'integrity_constraint_violation';
END $$;
REVOKE ALL ON FUNCTION public.agentic_synthetic_refuse_mutation() FROM PUBLIC;
CREATE TRIGGER agentic_synthetic_source_immutable_delete BEFORE DELETE ON public.agentic_synthetic_sources
FOR EACH ROW EXECUTE FUNCTION public.agentic_synthetic_refuse_mutation();
CREATE TRIGGER agentic_synthetic_source_no_truncate BEFORE TRUNCATE ON public.agentic_synthetic_sources
FOR EACH STATEMENT EXECUTE FUNCTION public.agentic_synthetic_refuse_mutation();
CREATE TRIGGER agentic_synthetic_outcome_immutable BEFORE UPDATE OR DELETE ON public.agentic_synthetic_outcomes
FOR EACH ROW EXECUTE FUNCTION public.agentic_synthetic_refuse_mutation();
CREATE TRIGGER agentic_synthetic_outcome_no_truncate BEFORE TRUNCATE ON public.agentic_synthetic_outcomes
FOR EACH STATEMENT EXECUTE FUNCTION public.agentic_synthetic_refuse_mutation();
CREATE TRIGGER agentic_synthetic_audit_immutable BEFORE UPDATE OR DELETE ON public.agentic_synthetic_audit
FOR EACH ROW EXECUTE FUNCTION public.agentic_synthetic_refuse_mutation();
CREATE TRIGGER agentic_synthetic_audit_no_truncate BEFORE TRUNCATE ON public.agentic_synthetic_audit
FOR EACH STATEMENT EXECUTE FUNCTION public.agentic_synthetic_refuse_mutation();

-- A begin row is a durable potential-dispatch marker. Only one unknown -> known
-- observation may fill it; a later mutation cannot rewrite the actor evidence.
CREATE FUNCTION public.agentic_synthetic_invocation_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.usage_state <> 'unknown' OR NEW.observation IS NOT NULL OR NEW.artifact IS NOT NULL
      OR NEW.candidate_digest IS NOT NULL OR NEW.evidence_digest IS NOT NULL THEN
      RAISE EXCEPTION 'Synthetic invocation must begin unknown.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF (NEW.tenant_id, NEW.run_id, NEW.role, NEW.ordinal, NEW.invocation_id, NEW.input_digest,
        NEW.dispatch_started_at) IS DISTINCT FROM
       (OLD.tenant_id, OLD.run_id, OLD.role, OLD.ordinal, OLD.invocation_id, OLD.input_digest,
        OLD.dispatch_started_at)
      OR OLD.usage_state <> 'unknown' OR OLD.observation IS NOT NULL OR OLD.artifact IS NOT NULL
      OR NEW.usage_state <> 'known' OR NEW.observation IS NULL THEN
      RAISE EXCEPTION 'Synthetic invocation evidence is immutable.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.artifact IS NULL AND (NEW.candidate_digest IS NOT NULL OR NEW.evidence_digest IS NOT NULL) THEN
      RAISE EXCEPTION 'Synthetic invocation digest needs artifact.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.agentic_synthetic_invocation_guard() FROM PUBLIC;
CREATE TRIGGER agentic_synthetic_invocation_guard BEFORE INSERT OR UPDATE ON public.agentic_synthetic_invocations
FOR EACH ROW EXECUTE FUNCTION public.agentic_synthetic_invocation_guard();
CREATE TRIGGER agentic_synthetic_invocation_no_delete BEFORE DELETE ON public.agentic_synthetic_invocations
FOR EACH ROW EXECUTE FUNCTION public.agentic_synthetic_refuse_mutation();
CREATE TRIGGER agentic_synthetic_invocation_no_truncate BEFORE TRUNCATE ON public.agentic_synthetic_invocations
FOR EACH STATEMENT EXECUTE FUNCTION public.agentic_synthetic_refuse_mutation();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['agentic_synthetic_grants','agentic_synthetic_sources',
    'agentic_synthetic_grant_sources','agentic_synthetic_runs','agentic_synthetic_reservations',
    'agentic_synthetic_invocations','agentic_synthetic_outcomes','agentic_synthetic_audit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO telesphoros_jobs USING (true) WITH CHECK (true)',
      table_name || '_owner', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
  END LOOP;
END $$;
REVOKE ALL ON public.agentic_synthetic_capacity, public.agentic_synthetic_buckets FROM PUBLIC;

-- Test-fixture admission only. The application transaction supplies the existing
-- trusted tenant/actor binding; custom GUCs are not an unforgeable SQL identity.
-- No table, grant, source, capacity row or job is seeded by this migration.
CREATE FUNCTION public.agentic_synthetic_admit(p_input jsonb, p_caller jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
  v_actor text := nullif(current_setting('app.current_actor', true), '');
  v_grant_id uuid;
  v_grant_generation bigint;
  v_membership_version bigint;
  v_cap record;
  v_existing public.agentic_synthetic_runs%ROWTYPE;
  v_grant record;
  v_source record;
  v_seen text[] := ARRAY[]::text[];
  v_snapshot jsonb := '[]'::jsonb;
  v_evidence_preimage text := '[';
  v_source_count integer := 0;
  v_total_bytes integer := 0;
  v_request_preimage text;
  v_request_digest text;
  v_evidence_digest text;
  v_profile_digest text := 'sha256:' || encode(sha256(convert_to(
    'synthetic.sop.profile.v1:retrieval,draft,verification,director:120000:4:28160:250000:1:2', 'UTF8')), 'hex');
  v_now timestamptz;
  v_day date;
  v_month date;
  v_tenant_bucket record;
  v_fleet_bucket record;
  v_run_id uuid;
  v_job_id uuid;
  v_job_created boolean;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR p_caller IS NULL OR jsonb_typeof(p_caller) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_input)) <> 5
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) AS k
      WHERE k NOT IN ('schemaVersion','taskKey','locale','question','idempotencyKey'))
    OR jsonb_typeof(p_input->'schemaVersion') IS DISTINCT FROM 'string'
    OR p_input->>'schemaVersion' IS DISTINCT FROM 'agentic.request.v1'
    OR jsonb_typeof(p_input->'taskKey') IS DISTINCT FROM 'string'
    OR p_input->>'taskKey' IS DISTINCT FROM 'business.sop-draft.v1'
    OR jsonb_typeof(p_input->'locale') IS DISTINCT FROM 'string'
    OR p_input->>'locale' IS NULL
    OR p_input->>'locale' NOT IN ('en','es')
    OR jsonb_typeof(p_input->'question') IS DISTINCT FROM 'string'
    OR char_length(p_input->>'question') > 512 OR octet_length(p_input->>'question') > 2048
    OR jsonb_typeof(p_input->'idempotencyKey') IS DISTINCT FROM 'string'
    OR p_input->>'idempotencyKey' IS NULL
    OR (p_input->>'idempotencyKey') !~ '^[A-Za-z0-9:/_-]{1,96}$'
    OR (SELECT count(*) FROM jsonb_object_keys(p_caller)) <> 5
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_caller) AS k
      WHERE k NOT IN ('tenantId','requesterRef','membershipVersion','grantId','grantGeneration'))
    OR jsonb_typeof(p_caller->'tenantId') IS DISTINCT FROM 'string'
    OR length(p_caller->>'tenantId') NOT BETWEEN 1 AND 128
    OR jsonb_typeof(p_caller->'requesterRef') IS DISTINCT FROM 'string'
    OR length(p_caller->>'requesterRef') NOT BETWEEN 1 AND 128
    OR jsonb_typeof(p_caller->'membershipVersion') IS DISTINCT FROM 'string'
    OR p_caller->>'membershipVersion' IS NULL
    OR (p_caller->>'membershipVersion') !~ '^[1-9][0-9]{0,17}$'
    OR jsonb_typeof(p_caller->'grantGeneration') IS DISTINCT FROM 'string'
    OR p_caller->>'grantGeneration' IS NULL
    OR (p_caller->>'grantGeneration') !~ '^[1-9][0-9]{0,17}$'
    OR jsonb_typeof(p_caller->'grantId') IS DISTINCT FROM 'string'
    OR p_caller->>'grantId' IS NULL
    OR (p_caller->>'grantId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  IF v_tenant IS NULL OR v_actor IS NULL OR v_tenant <> p_caller->>'tenantId'
    OR v_actor <> p_caller->>'requesterRef' THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  v_grant_id := (p_caller->>'grantId')::uuid;
  v_grant_generation := (p_caller->>'grantGeneration')::bigint;
  v_membership_version := (p_caller->>'membershipVersion')::bigint;
  v_request_preimage := array_to_json(ARRAY[p_input->>'schemaVersion', p_input->>'taskKey',
    p_input->>'locale', p_input->>'question'])::text;
  v_request_digest := 'sha256:' || encode(sha256(convert_to(v_request_preimage, 'UTF8')), 'hex');

  -- The singleton serializes this inactive feature's aggregate accounting.
  SELECT * INTO v_cap FROM public.agentic_synthetic_capacity WHERE singleton = 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','refused','code','CAPACITY_REFUSED'); END IF;
  SELECT * INTO v_existing FROM public.agentic_synthetic_runs
    WHERE tenant_id = v_tenant AND requester_ref = v_actor AND task_key = 'business.sop-draft.v1'
      AND idempotency_key = p_input->>'idempotencyKey' FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT public.agentic_synthetic_tenant_active(v_tenant) THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  SELECT * INTO v_grant FROM public.agentic_synthetic_grants
    WHERE tenant_id = v_tenant AND grant_id = v_grant_id FOR SHARE;
  IF NOT FOUND OR v_grant.requester_ref <> v_actor OR v_grant.generation <> v_grant_generation
    OR NOT v_grant.enabled OR v_grant.expires_at <= v_now
    OR v_grant.purpose <> 'business-assistance'
    OR NOT (v_grant.capabilities @> ARRAY['business.sop.read','business.sop.draft']::text[]) THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  IF NOT public.membership_assert_current(v_actor, v_membership_version) THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  FOR v_source IN
    SELECT s.source_id, s.source_version, s.digest, s.body
      FROM public.agentic_synthetic_grant_sources l
      JOIN public.agentic_synthetic_sources s ON (s.tenant_id, s.source_id, s.source_version) =
        (l.tenant_id, l.source_id, l.source_version)
     WHERE l.tenant_id = v_tenant AND l.grant_id = v_grant_id AND l.enabled AND s.eligible
     ORDER BY s.source_id, s.source_version FOR SHARE OF l, s
  LOOP
    v_source_count := v_source_count + 1;
    v_total_bytes := v_total_bytes + octet_length(v_source.body);
    IF v_source_count > 4 OR v_total_bytes > 16384 OR v_source.source_id = ANY(v_seen)
      OR v_source.digest <> 'sha256:' || encode(sha256(convert_to(v_source.body, 'UTF8')), 'hex') THEN
      RETURN jsonb_build_object('kind','refused','code','SOURCE_UNAVAILABLE');
    END IF;
    v_seen := v_seen || v_source.source_id;
    v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object('id',v_source.source_id,
      'version',v_source.source_version,'digest',v_source.digest));
    IF v_source_count > 1 THEN v_evidence_preimage := v_evidence_preimage || ','; END IF;
    v_evidence_preimage := v_evidence_preimage ||
      array_to_json(ARRAY[v_source.source_id,v_source.source_version,v_source.digest])::text;
  END LOOP;
  IF v_source_count = 0 THEN RETURN jsonb_build_object('kind','refused','code','SOURCE_UNAVAILABLE'); END IF;
  v_evidence_preimage := v_evidence_preimage || ']';
  IF octet_length(v_evidence_preimage) > 2048 OR pg_column_size(v_snapshot) > 2048 THEN
    RETURN jsonb_build_object('kind','refused','code','SOURCE_UNAVAILABLE');
  END IF;
  v_evidence_digest := 'sha256:' || encode(sha256(convert_to(v_evidence_preimage, 'UTF8')), 'hex');

  -- Repeats need current authority first; a changed tuple never reveals the old outcome.
  IF v_existing.run_id IS NOT NULL THEN
    IF v_existing.request_tuple_preimage <> v_request_preimage
      OR v_existing.request_digest <> v_request_digest OR v_existing.request_json <> p_input
      OR v_existing.profile_digest <> v_profile_digest OR v_existing.grant_id <> v_grant_id
      OR v_existing.grant_generation <> v_grant_generation
      OR v_existing.membership_version <> v_membership_version
      OR v_existing.source_snapshot <> v_snapshot
      OR v_existing.evidence_tuple_preimage <> v_evidence_preimage
      OR v_existing.evidence_digest <> v_evidence_digest OR v_existing.job_id IS NULL THEN
      RETURN jsonb_build_object('kind','refused','code','IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('schemaVersion','synthetic.durable.v1',
      'kind','existing','runId',v_existing.run_id,'jobId',v_existing.job_id,'state',v_existing.state,
      'sequence',v_existing.sequence::text,'deadlineAt',to_char(v_existing.deadline_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END IF;

  -- Check after all required locks and before writes; no refusal below this line
  -- may leave a partially admitted run, reservation, bucket or queue job.
  v_now := clock_timestamp();
  IF v_grant.expires_at <= v_now THEN RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED'); END IF;
  IF (SELECT count(*) FROM public.agentic_synthetic_reservations
       WHERE tenant_id = v_tenant AND in_flight) >= 1
    OR (SELECT count(*) FROM public.agentic_synthetic_reservations WHERE in_flight) >= 2 THEN
    RETURN jsonb_build_object('kind','refused','code','CAPACITY_REFUSED');
  END IF;
  v_day := (v_now AT TIME ZONE 'UTC')::date;
  v_month := date_trunc('month', v_now AT TIME ZONE 'UTC')::date;
  SELECT * INTO v_tenant_bucket FROM public.agentic_synthetic_buckets
    WHERE scope = 'tenant' AND scope_key = v_tenant AND period_kind = 'day' AND period_start = v_day FOR UPDATE;
  SELECT * INTO v_fleet_bucket FROM public.agentic_synthetic_buckets
    WHERE scope = 'fleet' AND scope_key = 'fleet' AND period_kind = 'month' AND period_start = v_month FOR UPDATE;
  IF (v_tenant_bucket.scope IS NOT NULL AND
      v_tenant_bucket.reserved_units + v_tenant_bucket.consumed_units + 250000 > v_cap.tenant_day_units)
    OR (v_fleet_bucket.scope IS NOT NULL AND
      v_fleet_bucket.reserved_units + v_fleet_bucket.consumed_units + 250000 > v_cap.fleet_month_units) THEN
    RETURN jsonb_build_object('kind','refused','code','BUDGET_REFUSED');
  END IF;
  INSERT INTO public.agentic_synthetic_buckets(scope,scope_key,period_kind,period_start,limit_units)
    VALUES ('tenant',v_tenant,'day',v_day,v_cap.tenant_day_units),
           ('fleet','fleet','month',v_month,v_cap.fleet_month_units)
    ON CONFLICT DO NOTHING;
  UPDATE public.agentic_synthetic_buckets SET reserved_units = reserved_units + 250000
    WHERE (scope,scope_key,period_kind,period_start) IN
      (('tenant',v_tenant,'day',v_day),('fleet','fleet','month',v_month));
  v_run_id := gen_random_uuid();
  SELECT e.job_id, e.created INTO v_job_id, v_job_created
    FROM public.job_enqueue('test.agentic-synthetic',jsonb_build_object('runId',v_run_id),
      'syn-' || v_run_id::text,v_now,1) e;
  IF v_job_id IS NULL OR NOT v_job_created THEN
    RAISE EXCEPTION 'Synthetic enqueue invariant failed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO public.agentic_synthetic_runs(tenant_id,run_id,requester_ref,task_key,idempotency_key,
    request_json,request_tuple_preimage,request_digest,profile_digest,grant_id,grant_generation,
    membership_version,source_snapshot,evidence_tuple_preimage,evidence_digest,state,sequence,fence,
    job_id,admitted_at,deadline_at,last_guarded_at)
  VALUES (v_tenant,v_run_id,v_actor,'business.sop-draft.v1',p_input->>'idempotencyKey',p_input,
    v_request_preimage,v_request_digest,v_profile_digest,v_grant_id,v_grant_generation,
    v_membership_version,v_snapshot,v_evidence_preimage,v_evidence_digest,'queued',1,0,
    v_job_id,v_now,v_now + interval '120 seconds',v_now);
  INSERT INTO public.agentic_synthetic_reservations(tenant_id,run_id,original_day,original_month,
    reserved_tokens,reserved_cost,usage_state,in_flight,settled)
  VALUES (v_tenant,v_run_id,v_day,v_month,28160,250000,'known',true,false);
  INSERT INTO public.agentic_synthetic_audit(tenant_id,run_id,event_sequence,code,fence,reserved_units,observed_units)
  VALUES (v_tenant,v_run_id,1,'ADMITTED',0,250000,0);
  RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('schemaVersion','synthetic.durable.v1',
    'kind','new','runId',v_run_id,'jobId',v_job_id,'state','queued','sequence','1',
    'deadlineAt',to_char((v_now + interval '120 seconds') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END $$;
REVOKE ALL ON FUNCTION public.agentic_synthetic_admit(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agentic_synthetic_admit(jsonb, jsonb) TO telesphoros_app;

-- ---------------------------------------------------------------------------
-- Claim-through-terminal lifecycle. Lock order for every function below:
--   capacity -> queue row -> run -> reservation/buckets -> grant -> membership -> sources.
-- Helpers are invoker-rights, owned by the NOLOGIN jobs role, with EXECUTE revoked from
-- PUBLIC: only the SECURITY DEFINER entry points (also owned by that role) can call them.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.agentic_synthetic_ts(p timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

CREATE FUNCTION public.agentic_synthetic_refusal(p_code text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('kind','refused','code',p_code)
$$;

CREATE FUNCTION public.agentic_synthetic_sha(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'sha256:' || encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

-- Exact key set of a JSON object; never evaluates key functions on a non-object.
CREATE FUNCTION public.agentic_synthetic_keys(p jsonb, p_required text[], p_optional text[] DEFAULT ARRAY[]::text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT (k = ANY(p_required || p_optional)))
    AND NOT EXISTS (SELECT 1 FROM unnest(p_required) r WHERE NOT (p ? r));
END $$;

CREATE FUNCTION public.agentic_synthetic_stamp_ok(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p)) <> 6 OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k
      WHERE k NOT IN ('jobId','runId','workerId','queueAttempt','claimId','fence')) THEN RETURN false; END IF;
  RETURN jsonb_typeof(p->'jobId') = 'string' AND (p->>'jobId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(p->'runId') = 'string' AND (p->>'runId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(p->'claimId') = 'string' AND (p->>'claimId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(p->'workerId') = 'string' AND length(p->>'workerId') BETWEEN 1 AND 128
    AND jsonb_typeof(p->'queueAttempt') = 'number' AND (p->>'queueAttempt') ~ '^[1-9][0-9]{0,8}$'
    AND jsonb_typeof(p->'fence') = 'string' AND (p->>'fence') ~ '^[1-9][0-9]{0,17}$';
END $$;

CREATE FUNCTION public.agentic_synthetic_expected_ok(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p)) <> 2
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('sequence','state')) THEN RETURN false; END IF;
  RETURN jsonb_typeof(p->'sequence') = 'string' AND (p->>'sequence') ~ '^(0|[1-9][0-9]{0,17})$'
    AND jsonb_typeof(p->'state') = 'string'
    AND (p->>'state') IN ('admitted','queued','running','reviewing','repair-pending','release-pending',
      'released','held','failed','cancelled','expired');
END $$;

CREATE FUNCTION public.agentic_synthetic_caller_ok(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p)) <> 5 OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k
      WHERE k NOT IN ('tenantId','requesterRef','membershipVersion','grantId','grantGeneration')) THEN RETURN false; END IF;
  RETURN jsonb_typeof(p->'tenantId') = 'string' AND length(p->>'tenantId') BETWEEN 1 AND 128
    AND jsonb_typeof(p->'requesterRef') = 'string' AND length(p->>'requesterRef') BETWEEN 1 AND 128
    AND jsonb_typeof(p->'membershipVersion') = 'string' AND (p->>'membershipVersion') ~ '^[1-9][0-9]{0,17}$'
    AND jsonb_typeof(p->'grantGeneration') = 'string' AND (p->>'grantGeneration') ~ '^[1-9][0-9]{0,17}$'
    AND jsonb_typeof(p->'grantId') = 'string'
    AND (p->>'grantId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
END $$;

-- The existing membership boundary reads the tenant from the transaction GUC. Worker calls
-- carry no tenant, so bind it from the locked run row for exactly this call, then restore it.
CREATE FUNCTION public.agentic_synthetic_member_current(p_tenant text, p_sub text, p_version bigint) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_old text := current_setting('app.current_tenant_id', true);
  v_ok boolean;
BEGIN
  PERFORM set_config('app.current_tenant_id', p_tenant, true);
  v_ok := public.membership_assert_current(p_sub, p_version);
  PERFORM set_config('app.current_tenant_id', coalesce(v_old, ''), true);
  RETURN coalesce(v_ok, false);
END $$;

-- Current authority for an already locked run: tenant, captured grant generation, captured
-- membership version and every snapshot source/link, in the documented lock order. The source
-- tuple is recomputed from the current rows and must equal the stored evidence preimage.
CREATE FUNCTION public.agentic_synthetic_authority(p_tenant text, p_run uuid) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_grant record;
  v_entry jsonb;
  v_source record;
  v_preimage text := '[';
  v_count integer := 0;
  v_now timestamptz;
BEGIN
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE tenant_id = p_tenant AND run_id = p_run;
  IF NOT FOUND THEN RETURN 'NOT_AUTHORIZED'; END IF;
  IF NOT public.agentic_synthetic_tenant_active(p_tenant) THEN RETURN 'NOT_AUTHORIZED'; END IF;
  SELECT * INTO v_grant FROM public.agentic_synthetic_grants
    WHERE tenant_id = p_tenant AND grant_id = v_run.grant_id FOR SHARE;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_grant.requester_ref <> v_run.requester_ref OR v_grant.generation <> v_run.grant_generation
    OR NOT v_grant.enabled OR v_grant.expires_at <= v_now OR v_grant.purpose <> 'business-assistance'
    OR NOT (v_grant.capabilities @> ARRAY['business.sop.read','business.sop.draft']::text[]) THEN
    RETURN 'NOT_AUTHORIZED';
  END IF;
  IF NOT public.agentic_synthetic_member_current(p_tenant, v_run.requester_ref, v_run.membership_version) THEN
    RETURN 'NOT_AUTHORIZED';
  END IF;
  FOR v_entry IN SELECT e FROM jsonb_array_elements(v_run.source_snapshot) e LOOP
    SELECT s.source_id, s.source_version, s.digest, s.body, s.eligible, l.enabled INTO v_source
      FROM public.agentic_synthetic_grant_sources l
      JOIN public.agentic_synthetic_sources s ON (s.tenant_id, s.source_id, s.source_version) =
        (l.tenant_id, l.source_id, l.source_version)
     WHERE l.tenant_id = p_tenant AND l.grant_id = v_run.grant_id
       AND l.source_id = v_entry->>'id' AND l.source_version = v_entry->>'version'
       FOR SHARE OF l, s;
    IF NOT FOUND OR NOT v_source.eligible OR NOT v_source.enabled OR v_source.digest <> v_entry->>'digest'
      OR v_source.digest <> public.agentic_synthetic_sha(v_source.body) THEN
      RETURN 'SOURCE_UNAVAILABLE';
    END IF;
    v_count := v_count + 1;
    IF v_count > 1 THEN v_preimage := v_preimage || ','; END IF;
    v_preimage := v_preimage || array_to_json(ARRAY[v_source.source_id, v_source.source_version, v_source.digest])::text;
  END LOOP;
  v_preimage := v_preimage || ']';
  IF v_count = 0 OR v_preimage <> v_run.evidence_tuple_preimage
    OR public.agentic_synthetic_sha(v_preimage) <> v_run.evidence_digest THEN
    RETURN 'SOURCE_UNAVAILABLE';
  END IF;
  RETURN NULL;
END $$;

-- Queue row then run row. Exact job/run/tenant/requester/type/worker/attempt/lease/claim/fence
-- binding, and the original deadline after locks (clock_timestamp, never transaction start).
CREATE FUNCTION public.agentic_synthetic_claim_guard(p_stamp jsonb) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_job record;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_now timestamptz;
  v_terminal boolean;
BEGIN
  SELECT j.id, j.tenant_id, j.type, j.payload, j.state, j.attempts, j.locked_by, j.lease_until, j.requested_by, j.started_at
    INTO v_job FROM public.jobs j WHERE j.id = (p_stamp->>'jobId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_job.type <> 'test.agentic-synthetic' OR v_job.state <> 'running'
    OR v_job.locked_by IS DISTINCT FROM p_stamp->>'workerId'
    OR v_job.attempts <> (p_stamp->>'queueAttempt')::integer
    OR v_job.payload IS DISTINCT FROM jsonb_build_object('runId', p_stamp->>'runId') THEN
    RETURN 'STALE_CLAIM';
  END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs
   WHERE run_id = (p_stamp->>'runId')::uuid AND job_id = v_job.id
     AND tenant_id = v_job.tenant_id AND requester_ref = v_job.requested_by FOR UPDATE;
  -- A legacy job_release + job_claim keeps worker, attempt, claim_id and fence but not started_at.
  IF NOT FOUND OR v_run.claim_id IS DISTINCT FROM (p_stamp->>'claimId')::uuid
    OR v_run.fence <> (p_stamp->>'fence')::bigint OR v_run.claim_started_at IS DISTINCT FROM v_job.started_at THEN
    RETURN 'STALE_CLAIM';
  END IF;
  v_now := clock_timestamp();
  IF v_job.lease_until < v_now THEN RETURN 'STALE_CLAIM'; END IF;
  -- A database clock earlier than the last guarded decision is an anomaly: fail closed.
  IF v_now < v_run.last_guarded_at THEN RETURN 'DEADLINE_EXPIRED'; END IF;
  v_terminal := v_run.state IN ('released','held','failed','cancelled','expired');
  IF NOT v_terminal AND v_now >= v_run.deadline_at THEN RETURN 'DEADLINE_EXPIRED'; END IF;
  UPDATE public.agentic_synthetic_runs SET last_guarded_at = v_now
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id;
  RETURN NULL;
END $$;

-- Final time check after the last lock of a worker step. Every row it reads is already locked by this
-- transaction, so it never waits; a wait on a later lock (membership, source, accounts) therefore
-- cannot let a step commit after its lease, original deadline or grant expiry.
CREATE FUNCTION public.agentic_synthetic_fresh(p_stamp jsonb) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now timestamptz;
  v_lease timestamptz;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_expires timestamptz;
BEGIN
  SELECT lease_until INTO v_lease FROM public.jobs WHERE id = (p_stamp->>'jobId')::uuid;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE run_id = (p_stamp->>'runId')::uuid;
  SELECT expires_at INTO v_expires FROM public.agentic_synthetic_grants
   WHERE tenant_id = v_run.tenant_id AND grant_id = v_run.grant_id;
  v_now := clock_timestamp();
  IF v_lease IS NULL OR v_lease < v_now THEN RETURN 'STALE_CLAIM'; END IF;
  IF v_now < v_run.last_guarded_at THEN RETURN 'DEADLINE_EXPIRED'; END IF;
  IF v_run.state NOT IN ('released','held','failed','cancelled','expired') AND v_now >= v_run.deadline_at THEN
    RETURN 'DEADLINE_EXPIRED';
  END IF;
  IF v_expires IS NULL OR v_expires <= v_now THEN RETURN 'NOT_AUTHORIZED'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.agentic_synthetic_expected_matches(p_tenant text, p_run uuid, p_expected jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.agentic_synthetic_runs r WHERE r.tenant_id = p_tenant AND r.run_id = p_run
    AND r.state = p_expected->>'state' AND r.sequence = (p_expected->>'sequence')::bigint)
$$;

CREATE FUNCTION public.agentic_synthetic_view(p_tenant text, p_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('kind','ok','value',jsonb_build_object('schemaVersion','synthetic.durable.v1',
    'runId', r.run_id, 'state', r.state, 'sequence', r.sequence::text,
    'deadlineAt', public.agentic_synthetic_ts(r.deadline_at),
    'selectedAttempt', (SELECT max(i.ordinal) FROM public.agentic_synthetic_invocations i
      WHERE i.tenant_id = r.tenant_id AND i.run_id = r.run_id AND i.role = 'draft'),
    'outcomeCommitted', EXISTS (SELECT 1 FROM public.agentic_synthetic_outcomes o
      WHERE o.tenant_id = r.tenant_id AND o.run_id = r.run_id),
    'dispatchUnknown', EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations i
      WHERE i.tenant_id = r.tenant_id AND i.run_id = r.run_id AND i.usage_state = 'unknown')))
  FROM public.agentic_synthetic_runs r WHERE r.tenant_id = p_tenant AND r.run_id = p_run
$$;

-- Mechanical candidate check, mirroring P1 checkCandidate byte for byte against the run's
-- admitted source snapshot: strict shape, text digest, claim join, unique ids, UTF-8 spans.
CREATE FUNCTION public.agentic_synthetic_candidate_ok(p_tenant text, p_run uuid, p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_claim jsonb;
  v_ids text[] := ARRAY[]::text[];
  v_join text := NULL;
  v_entry jsonb;
  v_bytes bytea;
  v_len integer;
  v_start integer;
  v_end integer;
  v_count integer;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p)) <> 3
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('text','digest','claims'))
    OR jsonb_typeof(p->'text') <> 'string' OR jsonb_typeof(p->'digest') <> 'string'
    OR (p->>'digest') !~ '^sha256:[a-f0-9]{64}$' OR jsonb_typeof(p->'claims') <> 'array' THEN
    RETURN false;
  END IF;
  v_count := jsonb_array_length(p->'claims');
  IF v_count < 1 OR v_count > 8 OR p->>'digest' <> public.agentic_synthetic_sha(p->>'text') THEN RETURN false; END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE tenant_id = p_tenant AND run_id = p_run;
  IF NOT FOUND THEN RETURN false; END IF;
  FOR v_claim IN SELECT c FROM jsonb_array_elements(p->'claims') WITH ORDINALITY AS t(c, n) ORDER BY n LOOP
    IF jsonb_typeof(v_claim) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(v_claim)) <> 5
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_claim) k WHERE k NOT IN ('id','text','sourceId','startByte','endByte'))
      OR jsonb_typeof(v_claim->'id') <> 'string' OR length(v_claim->>'id') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(v_claim->'text') <> 'string'
      OR jsonb_typeof(v_claim->'sourceId') <> 'string' OR length(v_claim->>'sourceId') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(v_claim->'startByte') <> 'number' OR (v_claim->>'startByte') !~ '^(0|[1-9][0-9]{0,8})$'
      OR jsonb_typeof(v_claim->'endByte') <> 'number' OR (v_claim->>'endByte') !~ '^[1-9][0-9]{0,8}$'
      OR v_claim->>'id' = ANY(v_ids) THEN
      RETURN false;
    END IF;
    v_ids := v_ids || (v_claim->>'id');
    v_join := CASE WHEN v_join IS NULL THEN v_claim->>'text' ELSE v_join || E'\n' || (v_claim->>'text') END;
    SELECT e INTO v_entry FROM jsonb_array_elements(v_run.source_snapshot) e WHERE e->>'id' = v_claim->>'sourceId';
    IF v_entry IS NULL THEN RETURN false; END IF;
    SELECT convert_to(s.body, 'UTF8') INTO v_bytes FROM public.agentic_synthetic_sources s
     WHERE s.tenant_id = p_tenant AND s.source_id = v_entry->>'id' AND s.source_version = v_entry->>'version'
       AND s.digest = v_entry->>'digest';
    IF v_bytes IS NULL THEN RETURN false; END IF;
    v_len := octet_length(v_bytes);
    v_start := (v_claim->>'startByte')::integer;
    v_end := (v_claim->>'endByte')::integer;
    IF v_start >= v_end OR v_end > v_len OR (get_byte(v_bytes, v_start) & 192) = 128
      OR (v_end < v_len AND (get_byte(v_bytes, v_end) & 192) = 128)
      OR convert_from(substring(v_bytes FROM v_start + 1 FOR v_end - v_start), 'UTF8') <> v_claim->>'text' THEN
      RETURN false;
    END IF;
    v_entry := NULL;
  END LOOP;
  RETURN v_join = p->>'text';
END $$;

-- P1 checkVerdict: strict shape, exact candidate/evidence binding, complete supported coverage.
CREATE FUNCTION public.agentic_synthetic_verdict_ok(p_candidate jsonb, p jsonb, p_evidence text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v jsonb; v_ids text[] := ARRAY[]::text[];
BEGIN
  IF p IS NULL OR p_candidate IS NULL OR jsonb_typeof(p) <> 'object' OR jsonb_typeof(p_candidate) <> 'object'
    OR jsonb_typeof(p_candidate->'claims') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p)) <> 4 OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k
      WHERE k NOT IN ('decision','candidateDigest','evidenceDigest','claimVerdicts')) THEN RETURN false; END IF;
  IF jsonb_typeof(p->'decision') IS DISTINCT FROM 'string' OR (p->>'decision') NOT IN ('accept','repair','hold')
    OR jsonb_typeof(p->'candidateDigest') IS DISTINCT FROM 'string' OR p->>'candidateDigest' IS DISTINCT FROM p_candidate->>'digest'
    OR jsonb_typeof(p->'evidenceDigest') IS DISTINCT FROM 'string' OR p->>'evidenceDigest' IS DISTINCT FROM p_evidence
    OR jsonb_typeof(p->'claimVerdicts') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p->'claimVerdicts') > 8
    OR jsonb_array_length(p->'claimVerdicts') <> jsonb_array_length(p_candidate->'claims') THEN RETURN false; END IF;
  FOR v IN SELECT e FROM jsonb_array_elements(p->'claimVerdicts') e LOOP
    IF jsonb_typeof(v) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(v)) <> 2
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('claimId','supported'))
      OR jsonb_typeof(v->'claimId') IS DISTINCT FROM 'string' OR length(v->>'claimId') NOT BETWEEN 1 AND 128
      OR v->'supported' IS DISTINCT FROM 'true'::jsonb OR v->>'claimId' = ANY(v_ids) THEN RETURN false; END IF;
    v_ids := v_ids || (v->>'claimId');
  END LOOP;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_candidate->'claims') c WHERE NOT ((c->>'id') = ANY(v_ids)));
END $$;

-- Exact actor input identity, byte-equal to the durable kernel's JSON.stringify tuples.
CREATE FUNCTION public.agentic_synthetic_input_digest(p_tenant text, p_run uuid, p_role text, p_ordinal integer) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_role
    WHEN 'draft' THEN public.agentic_synthetic_sha('[' || to_json(r.run_id::text || ':draft:' || p_ordinal)::text
      || ',' || to_json(r.evidence_digest)::text || ',' || r.evidence_tuple_preimage || ']')
    WHEN 'director' THEN (SELECT public.agentic_synthetic_sha('[' || to_json(r.run_id::text || ':director:' || p_ordinal)::text
      || ',' || to_json(d.artifact->>'digest')::text || ',' || to_json(r.evidence_digest)::text || ']')
      FROM public.agentic_synthetic_invocations d
      WHERE d.tenant_id = r.tenant_id AND d.run_id = r.run_id AND d.role = 'draft' AND d.ordinal = p_ordinal
        AND d.usage_state = 'known' AND d.artifact IS NOT NULL)
    END
  FROM public.agentic_synthetic_runs r WHERE r.tenant_id = p_tenant AND r.run_id = p_run
$$;

-- A completed (draft, n) with a persisted mechanically valid candidate and bound identities.
CREATE FUNCTION public.agentic_synthetic_draft_ok(p_tenant text, p_run uuid, p_ordinal integer) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations d
    JOIN public.agentic_synthetic_runs r ON (r.tenant_id, r.run_id) = (d.tenant_id, d.run_id)
    WHERE d.tenant_id = p_tenant AND d.run_id = p_run AND d.role = 'draft' AND d.ordinal = p_ordinal
      AND d.usage_state = 'known' AND d.observation IS NOT NULL AND d.artifact IS NOT NULL
      AND d.candidate_digest = d.artifact->>'digest' AND d.evidence_digest = r.evidence_digest
      AND d.input_digest = public.agentic_synthetic_input_digest(p_tenant, p_run, 'draft', p_ordinal)
      AND public.agentic_synthetic_candidate_ok(p_tenant, p_run, d.artifact))
$$;

-- A completed (director, n) whose persisted verdict has the given decision and binds draft n.
CREATE FUNCTION public.agentic_synthetic_director_is(p_tenant text, p_run uuid, p_ordinal integer, p_decision text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT public.agentic_synthetic_draft_ok(p_tenant, p_run, p_ordinal) AND EXISTS (
    SELECT 1 FROM public.agentic_synthetic_invocations v
    JOIN public.agentic_synthetic_invocations d ON (d.tenant_id, d.run_id, d.role, d.ordinal) = (v.tenant_id, v.run_id, 'draft', v.ordinal)
    JOIN public.agentic_synthetic_runs r ON (r.tenant_id, r.run_id) = (v.tenant_id, v.run_id)
    WHERE v.tenant_id = p_tenant AND v.run_id = p_run AND v.role = 'director' AND v.ordinal = p_ordinal
      AND v.usage_state = 'known' AND v.observation IS NOT NULL AND v.artifact IS NOT NULL
      AND v.artifact->>'decision' = p_decision
      AND v.candidate_digest = d.artifact->>'digest' AND v.evidence_digest = r.evidence_digest
      AND v.input_digest = public.agentic_synthetic_input_digest(p_tenant, p_run, 'director', p_ordinal)
      AND public.agentic_synthetic_verdict_ok(d.artifact, v.artifact, r.evidence_digest))
$$;

-- Attempt two is authorized only by the persisted, valid first-director repair verdict.
CREATE FUNCTION public.agentic_synthetic_repair_ok(p_tenant text, p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT public.agentic_synthetic_director_is(p_tenant, p_run, 1, 'repair')
    AND NOT EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations i
      WHERE i.tenant_id = p_tenant AND i.run_id = p_run AND (i.ordinal = 2 OR i.usage_state = 'unknown'))
    AND NOT EXISTS (SELECT 1 FROM public.agentic_synthetic_outcomes o WHERE o.tenant_id = p_tenant AND o.run_id = p_run)
$$;

CREATE FUNCTION public.agentic_synthetic_audit_event(p_tenant text, p_run uuid, p_code text, p_reason text,
  p_digest text) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO public.agentic_synthetic_audit(tenant_id,run_id,event_sequence,code,reason_code,artifact_digest,
    fence,reserved_units,observed_units)
  SELECT r.tenant_id, r.run_id, r.sequence, p_code, p_reason, p_digest, r.fence,
    CASE WHEN v.settled THEN 0 ELSE v.reserved_cost END, v.observed_input + v.observed_generated
  FROM public.agentic_synthetic_runs r
  JOIN public.agentic_synthetic_reservations v ON (v.tenant_id, v.run_id) = (r.tenant_id, r.run_id)
  WHERE r.tenant_id = p_tenant AND r.run_id = p_run
$$;

-- Known usage charges the full conservative synthetic cost to the ORIGINAL period buckets once
-- and frees the in-flight permit. Unknown usage keeps the full reservation and permit held.
CREATE FUNCTION public.agentic_synthetic_settle(p_tenant text, p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_res public.agentic_synthetic_reservations%ROWTYPE;
  v_n integer;
BEGIN
  SELECT * INTO v_res FROM public.agentic_synthetic_reservations WHERE tenant_id = p_tenant AND run_id = p_run;
  IF NOT FOUND OR v_res.settled THEN
    RAISE EXCEPTION 'Synthetic settlement invariant failed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations
      WHERE tenant_id = p_tenant AND run_id = p_run AND usage_state = 'unknown') OR v_res.usage_state <> 'known' THEN
    RETURN;
  END IF;
  UPDATE public.agentic_synthetic_buckets
     SET reserved_units = reserved_units - v_res.reserved_cost, consumed_units = consumed_units + v_res.reserved_cost
   WHERE (scope, scope_key, period_kind, period_start) IN
     (('tenant', p_tenant, 'day', v_res.original_day), ('fleet', 'fleet', 'month', v_res.original_month));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'Synthetic settlement buckets missing.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  UPDATE public.agentic_synthetic_reservations SET settled = true, in_flight = false
   WHERE tenant_id = p_tenant AND run_id = p_run;
END $$;

CREATE FUNCTION public.agentic_synthetic_lock_accounts(p_tenant text, p_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_res public.agentic_synthetic_reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_res FROM public.agentic_synthetic_reservations WHERE tenant_id = p_tenant AND run_id = p_run FOR UPDATE;
  PERFORM 1 FROM public.agentic_synthetic_buckets
   WHERE (scope, scope_key, period_kind, period_start) IN
     (('tenant', p_tenant, 'day', v_res.original_day), ('fleet', 'fleet', 'month', v_res.original_month))
   ORDER BY scope, scope_key, period_kind, period_start FOR UPDATE;
END $$;

CREATE FUNCTION public.agentic_synthetic_outcome(p_tenant text, p_run uuid, p_state text, p_reason text,
  p_artifact jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion','synthetic.business-outcome.v1','evidenceKind','synthetic-control-flow',
    'runId', r.run_id::text, 'tenantId', r.tenant_id, 'requesterRef', r.requester_ref, 'terminalState', p_state,
    'fixtureProfileDigest', r.profile_digest,
    'simulatedArtifact', CASE WHEN p_state = 'released'
      THEN jsonb_build_object('text', p_artifact->>'text', 'digest', p_artifact->>'digest') ELSE 'null'::jsonb END,
    'simulationReceiptRef', CASE WHEN p_state = 'released' THEN to_jsonb('simulation:' || r.run_id::text) ELSE 'null'::jsonb END,
    'reasonCode', p_reason,
    'counters', jsonb_build_object(
      'logicalSlots', (SELECT count(*) FROM public.agentic_synthetic_invocations i
        WHERE i.tenant_id = r.tenant_id AND i.run_id = r.run_id),
      'projectedTokens', v.observed_input + v.observed_generated,
      'actualModelCalls', 0, 'actualModelTokens', 0, 'actualInferenceCharges', 0,
      'usageState', CASE WHEN EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations i
        WHERE i.tenant_id = r.tenant_id AND i.run_id = r.run_id AND i.usage_state = 'unknown')
        THEN 'unknown' ELSE 'known' END))
  FROM public.agentic_synthetic_runs r
  JOIN public.agentic_synthetic_reservations v ON (v.tenant_id, v.run_id) = (r.tenant_id, r.run_id)
  WHERE r.tenant_id = p_tenant AND r.run_id = p_run
$$;

-- Commit one immutable terminal outcome and its audit and settlement in the caller's transaction.
CREATE FUNCTION public.agentic_synthetic_commit_terminal(p_tenant text, p_run uuid, p_state text, p_reason text,
  p_artifact jsonb, p_cancel boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_outcome jsonb;
BEGIN
  UPDATE public.agentic_synthetic_runs SET state = p_state, sequence = sequence + 1,
    fence = CASE WHEN p_cancel THEN fence + 1 ELSE fence END,
    claim_id = CASE WHEN p_cancel THEN NULL ELSE claim_id END
   WHERE tenant_id = p_tenant AND run_id = p_run;
  v_outcome := public.agentic_synthetic_outcome(p_tenant, p_run, p_state, p_reason, p_artifact);
  IF v_outcome IS NULL OR octet_length(v_outcome::text) > 16384 THEN
    RAISE EXCEPTION 'Synthetic outcome invariant failed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO public.agentic_synthetic_outcomes(tenant_id, run_id, simulation_receipt_ref, outcome, outcome_digest)
  VALUES (p_tenant, p_run, CASE WHEN p_state = 'released' THEN 'simulation:' || p_run::text END,
    v_outcome, public.agentic_synthetic_sha(v_outcome::text));
  PERFORM public.agentic_synthetic_settle(p_tenant, p_run);
  PERFORM public.agentic_synthetic_audit_event(p_tenant, p_run, CASE WHEN p_cancel THEN 'CANCELLED' ELSE 'FINISHED' END,
    p_reason, CASE WHEN p_state = 'released' THEN p_artifact->>'digest' END);
  RETURN v_outcome;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['agentic_synthetic_keys(jsonb,text[],text[])','agentic_synthetic_ts(timestamptz)','agentic_synthetic_refusal(text)',
    'agentic_synthetic_sha(text)','agentic_synthetic_stamp_ok(jsonb)','agentic_synthetic_expected_ok(jsonb)',
    'agentic_synthetic_caller_ok(jsonb)','agentic_synthetic_member_current(text,text,bigint)',
    'agentic_synthetic_authority(text,uuid)','agentic_synthetic_claim_guard(jsonb)','agentic_synthetic_fresh(jsonb)',
    'agentic_synthetic_expected_matches(text,uuid,jsonb)','agentic_synthetic_view(text,uuid)',
    'agentic_synthetic_candidate_ok(text,uuid,jsonb)','agentic_synthetic_verdict_ok(jsonb,jsonb,text)',
    'agentic_synthetic_input_digest(text,uuid,text,integer)','agentic_synthetic_draft_ok(text,uuid,integer)',
    'agentic_synthetic_director_is(text,uuid,integer,text)','agentic_synthetic_repair_ok(text,uuid)',
    'agentic_synthetic_audit_event(text,uuid,text,text,text)','agentic_synthetic_settle(text,uuid)',
    'agentic_synthetic_lock_accounts(text,uuid)','agentic_synthetic_outcome(text,uuid,text,text,jsonb)',
    'agentic_synthetic_commit_terminal(text,uuid,text,text,jsonb,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
  END LOOP;
END $$;

-- Worker claim: the stamp is minted inside the transaction that calls the existing job_claim,
-- with the fixed type, tenant cap 1 and 15-second lease. A job of this type without its exact
-- run (only possible via a direct job_enqueue) is failed nonretryably and never dispatched.
CREATE FUNCTION public.agentic_synthetic_claim(p_worker text, p_batch integer)
RETURNS TABLE (id uuid, tenant_id text, type text, payload jsonb, attempt integer, max_attempts integer,
  lease_until timestamptz, requested_by text, run_id uuid, claim_id uuid, fence bigint, sequence bigint, state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
#variable_conflict use_column
DECLARE
  v_job record;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_claim uuid;
  v_started timestamptz;
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128 OR p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'Synthetic claim limits out of range.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.agentic_synthetic_capacity c WHERE c.singleton = 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  FOR v_job IN SELECT * FROM public.job_claim(p_worker, ARRAY['test.agentic-synthetic'], p_batch, 1, 15) LOOP
    SELECT * INTO v_run FROM public.agentic_synthetic_runs r WHERE r.job_id = v_job.id FOR UPDATE;
    IF NOT FOUND OR v_run.run_id::text IS DISTINCT FROM v_job.payload->>'runId'
      OR v_job.payload IS DISTINCT FROM jsonb_build_object('runId', v_run.run_id::text)
      OR v_run.tenant_id <> v_job.tenant_id OR v_run.requester_ref <> v_job.requested_by OR v_job.max_attempts <> 1 THEN
      PERFORM public.job_fail(v_job.id, p_worker, 'synthetic-orphan', false);
      CONTINUE;
    END IF;
    v_claim := gen_random_uuid();
    SELECT q.started_at INTO v_started FROM public.jobs q WHERE q.id = v_job.id;
    UPDATE public.agentic_synthetic_runs r SET fence = r.fence + 1, claim_id = v_claim, claim_started_at = v_started,
      sequence = r.sequence + 1,
      last_guarded_at = greatest(r.last_guarded_at, clock_timestamp())
     WHERE r.tenant_id = v_run.tenant_id AND r.run_id = v_run.run_id
    RETURNING * INTO v_run;
    PERFORM public.agentic_synthetic_audit_event(v_run.tenant_id, v_run.run_id, 'CLAIMED', NULL, NULL);
    id := v_job.id; tenant_id := v_job.tenant_id; type := v_job.type; payload := v_job.payload;
    attempt := v_job.attempt; max_attempts := v_job.max_attempts; lease_until := v_job.lease_until;
    requested_by := v_job.requested_by; run_id := v_run.run_id; claim_id := v_claim; fence := v_run.fence;
    sequence := v_run.sequence; state := v_run.state;
    RETURN NEXT;
  END LOOP;
  -- With maxAttempts 1 the existing claim marks a lease-expired job dead instead of reclaiming
  -- it, and a legacy job_succeed can finish the job under a live run. Finish such a run as held so a known-usage run cannot keep its permit forever; any
  -- begun-but-unobserved invocation keeps the full reservation and permit (no settlement).
  FOR v_run IN SELECT r.* FROM public.agentic_synthetic_runs r JOIN public.jobs j ON j.id = r.job_id
     WHERE j.type = 'test.agentic-synthetic' AND j.state IN ('dead','succeeded','cancelled')
       AND r.state NOT IN ('released','held','failed','cancelled','expired')
     ORDER BY r.tenant_id, r.run_id FOR UPDATE OF r LOOP
    PERFORM public.agentic_synthetic_lock_accounts(v_run.tenant_id, v_run.run_id);
    PERFORM public.agentic_synthetic_commit_terminal(v_run.tenant_id, v_run.run_id, 'held', 'QUEUE_DEAD', NULL, false);
  END LOOP;
END $$;

CREATE FUNCTION public.agentic_synthetic_load(p_stamp jsonb, p_expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_code text;
  v_run public.agentic_synthetic_runs%ROWTYPE;
BEGIN
  IF NOT public.agentic_synthetic_stamp_ok(p_stamp) OR NOT public.agentic_synthetic_expected_ok(p_expected) THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  v_code := public.agentic_synthetic_claim_guard(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE run_id = (p_stamp->>'runId')::uuid;
  IF NOT public.agentic_synthetic_expected_matches(v_run.tenant_id, v_run.run_id, p_expected) THEN
    RETURN public.agentic_synthetic_refusal('STALE_SEQUENCE');
  END IF;
  v_code := public.agentic_synthetic_authority(v_run.tenant_id, v_run.run_id);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  v_code := public.agentic_synthetic_fresh(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  RETURN public.agentic_synthetic_view(v_run.tenant_id, v_run.run_id);
END $$;

CREATE FUNCTION public.agentic_synthetic_sources(p_stamp jsonb, p_expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_code text;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_sources jsonb;
BEGIN
  IF NOT public.agentic_synthetic_stamp_ok(p_stamp) OR NOT public.agentic_synthetic_expected_ok(p_expected) THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  v_code := public.agentic_synthetic_claim_guard(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE run_id = (p_stamp->>'runId')::uuid;
  IF NOT public.agentic_synthetic_expected_matches(v_run.tenant_id, v_run.run_id, p_expected) THEN
    RETURN public.agentic_synthetic_refusal('STALE_SEQUENCE');
  END IF;
  IF v_run.state NOT IN ('queued','running') THEN RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION'); END IF;
  v_code := public.agentic_synthetic_authority(v_run.tenant_id, v_run.run_id);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  v_code := public.agentic_synthetic_fresh(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  SELECT jsonb_agg(jsonb_build_object('id', s.source_id, 'tenantId', s.tenant_id, 'version', s.source_version,
      'digest', s.digest, 'body', s.body) ORDER BY e.n)
    INTO v_sources
    FROM jsonb_array_elements(v_run.source_snapshot) WITH ORDINALITY AS e(entry, n)
    JOIN public.agentic_synthetic_sources s ON s.tenant_id = v_run.tenant_id
     AND s.source_id = e.entry->>'id' AND s.source_version = e.entry->>'version' AND s.digest = e.entry->>'digest';
  IF v_sources IS NULL OR jsonb_array_length(v_sources) <> jsonb_array_length(v_run.source_snapshot) THEN
    RETURN public.agentic_synthetic_refusal('SOURCE_UNAVAILABLE');
  END IF;
  RETURN jsonb_build_object('kind','ok','value',v_sources);
END $$;

CREATE FUNCTION public.agentic_synthetic_advance(p_stamp jsonb, p_expected jsonb, p_next text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_code text;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_draft integer;
  v_unknown boolean;
  v_allowed boolean := false;
BEGIN
  IF NOT public.agentic_synthetic_stamp_ok(p_stamp) OR NOT public.agentic_synthetic_expected_ok(p_expected)
    OR p_next IS NULL OR p_next NOT IN ('running','reviewing','repair-pending','release-pending') THEN
    RETURN public.agentic_synthetic_refusal(CASE WHEN p_next IN ('released','held','failed','cancelled','expired')
      THEN 'INVALID_TRANSITION' ELSE 'INVALID_INPUT' END);
  END IF;
  v_code := public.agentic_synthetic_claim_guard(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE run_id = (p_stamp->>'runId')::uuid;
  IF NOT public.agentic_synthetic_expected_matches(v_run.tenant_id, v_run.run_id, p_expected) THEN
    RETURN public.agentic_synthetic_refusal('STALE_SEQUENCE');
  END IF;
  v_code := public.agentic_synthetic_authority(v_run.tenant_id, v_run.run_id);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  v_code := public.agentic_synthetic_fresh(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  SELECT max(ordinal) INTO v_draft FROM public.agentic_synthetic_invocations
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id AND role = 'draft';
  v_unknown := EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id AND usage_state = 'unknown');
  IF v_unknown THEN RETURN public.agentic_synthetic_refusal('USAGE_UNKNOWN'); END IF;
  IF v_run.state = 'queued' AND p_next = 'running' THEN
    IF v_draft IS NOT NULL THEN RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION'); END IF;
    -- Stricter queue-wait bound: the first dispatch must start within 15s of DB admission.
    IF clock_timestamp() > v_run.admitted_at + interval '15 seconds' THEN
      RETURN public.agentic_synthetic_refusal('DEADLINE_EXPIRED');
    END IF;
    v_allowed := true;
  ELSIF v_run.state = 'running' AND p_next = 'reviewing' THEN
    v_allowed := v_draft IS NOT NULL AND public.agentic_synthetic_draft_ok(v_run.tenant_id, v_run.run_id, v_draft)
      AND NOT EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations WHERE tenant_id = v_run.tenant_id
        AND run_id = v_run.run_id AND role = 'director' AND ordinal = v_draft);
  ELSIF v_run.state = 'reviewing' AND p_next = 'repair-pending' THEN
    v_allowed := v_draft = 1 AND public.agentic_synthetic_repair_ok(v_run.tenant_id, v_run.run_id);
  ELSIF v_run.state = 'repair-pending' AND p_next = 'running' THEN
    v_allowed := v_draft = 1 AND public.agentic_synthetic_repair_ok(v_run.tenant_id, v_run.run_id);
  ELSIF v_run.state = 'reviewing' AND p_next = 'release-pending' THEN
    v_allowed := v_draft IS NOT NULL AND public.agentic_synthetic_director_is(v_run.tenant_id, v_run.run_id, v_draft, 'accept');
  END IF;
  IF NOT v_allowed THEN RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION'); END IF;
  UPDATE public.agentic_synthetic_runs SET state = p_next, sequence = sequence + 1
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id;
  PERFORM public.agentic_synthetic_audit_event(v_run.tenant_id, v_run.run_id, 'ADVANCED', NULL, NULL);
  RETURN public.agentic_synthetic_view(v_run.tenant_id, v_run.run_id);
END $$;

-- Durable potential-dispatch marker before the scripted actor runs. Fixed slot plan only:
-- (draft,1) -> (director,1) -> [(draft,2) only after a persisted valid repair] -> (director,2).
CREATE FUNCTION public.agentic_synthetic_begin(p_stamp jsonb, p_expected jsonb, p_invocation jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_code text;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_res public.agentic_synthetic_reservations%ROWTYPE;
  v_role text;
  v_ordinal integer;
  v_slots integer;
  v_allowed boolean := false;
BEGIN
  IF NOT public.agentic_synthetic_stamp_ok(p_stamp) OR NOT public.agentic_synthetic_expected_ok(p_expected)
    OR NOT public.agentic_synthetic_keys(p_invocation, ARRAY['invocationId','role','ordinal','inputDigest'])
    OR jsonb_typeof(p_invocation->'invocationId') <> 'string'
    OR (p_invocation->>'invocationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_invocation->'role') <> 'string' OR (p_invocation->>'role') NOT IN ('draft','director')
    OR jsonb_typeof(p_invocation->'ordinal') <> 'number' OR (p_invocation->>'ordinal') NOT IN ('1','2')
    OR jsonb_typeof(p_invocation->'inputDigest') <> 'string' OR (p_invocation->>'inputDigest') !~ '^sha256:[0-9a-f]{64}$' THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  v_role := p_invocation->>'role';
  v_ordinal := (p_invocation->>'ordinal')::integer;
  v_code := public.agentic_synthetic_claim_guard(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE run_id = (p_stamp->>'runId')::uuid;
  IF NOT public.agentic_synthetic_expected_matches(v_run.tenant_id, v_run.run_id, p_expected) THEN
    RETURN public.agentic_synthetic_refusal('STALE_SEQUENCE');
  END IF;
  SELECT * INTO v_res FROM public.agentic_synthetic_reservations
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id FOR UPDATE;
  v_code := public.agentic_synthetic_authority(v_run.tenant_id, v_run.run_id);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  v_code := public.agentic_synthetic_fresh(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  IF v_res.run_id IS NULL OR v_res.settled OR NOT v_res.in_flight THEN RETURN public.agentic_synthetic_refusal('USAGE_UNKNOWN'); END IF;
  IF EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations WHERE tenant_id = v_run.tenant_id
      AND run_id = v_run.run_id AND usage_state = 'unknown') OR v_res.usage_state <> 'known' THEN
    RETURN public.agentic_synthetic_refusal('USAGE_UNKNOWN');
  END IF;
  IF EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations WHERE invocation_id = (p_invocation->>'invocationId')::uuid)
    OR EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations WHERE tenant_id = v_run.tenant_id
      AND run_id = v_run.run_id AND role = v_role AND ordinal = v_ordinal) THEN
    RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION');
  END IF;
  SELECT count(*) INTO v_slots FROM public.agentic_synthetic_invocations
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id;
  IF v_slots >= 4 THEN RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION'); END IF;
  IF v_role = 'draft' AND v_ordinal = 1 THEN
    v_allowed := v_run.state = 'running' AND v_slots = 0;
  ELSIF v_role = 'director' THEN
    v_allowed := v_run.state = 'reviewing' AND public.agentic_synthetic_draft_ok(v_run.tenant_id, v_run.run_id, v_ordinal)
      AND (v_ordinal = 1 OR public.agentic_synthetic_director_is(v_run.tenant_id, v_run.run_id, 1, 'repair'));
  ELSE
    -- The dispatch authority for attempt two is re-proved here from protected rows.
    v_allowed := v_run.state = 'running' AND v_slots = 2 AND public.agentic_synthetic_repair_ok(v_run.tenant_id, v_run.run_id);
  END IF;
  IF NOT v_allowed THEN RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION'); END IF;
  IF p_invocation->>'inputDigest' IS DISTINCT FROM
    public.agentic_synthetic_input_digest(v_run.tenant_id, v_run.run_id, v_role, v_ordinal) THEN
    RETURN public.agentic_synthetic_refusal('INVALID_EVIDENCE');
  END IF;
  INSERT INTO public.agentic_synthetic_invocations(tenant_id, run_id, role, ordinal, invocation_id, input_digest,
    dispatch_started_at, usage_state)
  VALUES (v_run.tenant_id, v_run.run_id, v_role, v_ordinal, (p_invocation->>'invocationId')::uuid,
    p_invocation->>'inputDigest', clock_timestamp(), 'unknown');
  UPDATE public.agentic_synthetic_reservations SET usage_state = 'unknown'
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id;
  UPDATE public.agentic_synthetic_runs SET sequence = sequence + 1
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id;
  PERFORM public.agentic_synthetic_audit_event(v_run.tenant_id, v_run.run_id, 'BEGUN', NULL, p_invocation->>'inputDigest');
  RETURN public.agentic_synthetic_view(v_run.tenant_id, v_run.run_id);
END $$;

-- One exact observation per begun invocation. A missing observation keeps usage unknown; an
-- artifact that fails the SQL mechanical/binding checks is refused and recorded nowhere.
CREATE FUNCTION public.agentic_synthetic_observe(p_stamp jsonb, p_expected jsonb, p_receipt jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_code text;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_inv public.agentic_synthetic_invocations%ROWTYPE;
  v_obs jsonb;
  v_artifact jsonb;
  v_input bigint;
  v_generated bigint;
  v_candidate jsonb;
BEGIN
  IF NOT public.agentic_synthetic_stamp_ok(p_stamp) OR NOT public.agentic_synthetic_expected_ok(p_expected)
    OR NOT public.agentic_synthetic_keys(p_receipt, ARRAY['invocationId','role','inputDigest','observation','artifact'])
    OR jsonb_typeof(p_receipt->'invocationId') <> 'string'
    OR (p_receipt->>'invocationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_receipt->'role') <> 'string' OR (p_receipt->>'role') NOT IN ('draft','director')
    OR jsonb_typeof(p_receipt->'inputDigest') <> 'string'
    OR jsonb_typeof(p_receipt->'observation') NOT IN ('object','null')
    OR jsonb_typeof(p_receipt->'artifact') NOT IN ('object','null') THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  v_obs := CASE WHEN jsonb_typeof(p_receipt->'observation') = 'object' THEN p_receipt->'observation' END;
  v_artifact := CASE WHEN jsonb_typeof(p_receipt->'artifact') = 'object' THEN p_receipt->'artifact' END;
  IF v_obs IS NULL AND v_artifact IS NOT NULL THEN RETURN public.agentic_synthetic_refusal('INVALID_INPUT'); END IF;
  IF v_obs IS NOT NULL THEN
    IF NOT public.agentic_synthetic_keys(v_obs, ARRAY['inputUnits','generatedUnits'])
      OR jsonb_typeof(v_obs->'inputUnits') <> 'number' OR (v_obs->>'inputUnits') !~ '^(0|[1-9][0-9]{0,8})$'
      OR jsonb_typeof(v_obs->'generatedUnits') <> 'number' OR (v_obs->>'generatedUnits') !~ '^(0|[1-9][0-9]{0,8})$' THEN
      RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
    END IF;
    v_input := (v_obs->>'inputUnits')::bigint;
    v_generated := (v_obs->>'generatedUnits')::bigint;
    IF (p_receipt->>'role' = 'draft' AND (v_input > 4096 OR v_generated > 768))
      OR (p_receipt->>'role' = 'director' AND (v_input > 8192 OR v_generated > 1024)) THEN
      RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
    END IF;
  END IF;
  v_code := public.agentic_synthetic_claim_guard(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE run_id = (p_stamp->>'runId')::uuid;
  SELECT * INTO v_inv FROM public.agentic_synthetic_invocations
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id
     AND invocation_id = (p_receipt->>'invocationId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_inv.role <> p_receipt->>'role' OR v_inv.input_digest <> p_receipt->>'inputDigest' THEN
    RETURN public.agentic_synthetic_refusal('INVALID_EVIDENCE');
  END IF;
  -- An exact repeat of an already persisted observation is idempotent; any change is refused.
  IF v_inv.usage_state = 'known' THEN
    IF v_inv.observation = v_obs AND v_inv.artifact IS NOT DISTINCT FROM v_artifact THEN
      RETURN public.agentic_synthetic_view(v_run.tenant_id, v_run.run_id);
    END IF;
    RETURN public.agentic_synthetic_refusal('INVALID_EVIDENCE');
  END IF;
  IF NOT public.agentic_synthetic_expected_matches(v_run.tenant_id, v_run.run_id, p_expected) THEN
    RETURN public.agentic_synthetic_refusal('STALE_SEQUENCE');
  END IF;
  PERFORM 1 FROM public.agentic_synthetic_reservations
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id FOR UPDATE;
  v_code := public.agentic_synthetic_authority(v_run.tenant_id, v_run.run_id);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  v_code := public.agentic_synthetic_fresh(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  IF v_obs IS NULL THEN RETURN public.agentic_synthetic_refusal('USAGE_UNKNOWN'); END IF;
  IF v_artifact IS NOT NULL THEN
    IF v_inv.role = 'draft' THEN
      IF NOT public.agentic_synthetic_candidate_ok(v_run.tenant_id, v_run.run_id, v_artifact) THEN
        RETURN public.agentic_synthetic_refusal('INVALID_EVIDENCE');
      END IF;
    ELSE
      SELECT artifact INTO v_candidate FROM public.agentic_synthetic_invocations
       WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id AND role = 'draft' AND ordinal = v_inv.ordinal;
      IF NOT public.agentic_synthetic_verdict_ok(v_candidate, v_artifact, v_run.evidence_digest) THEN
        RETURN public.agentic_synthetic_refusal('INVALID_EVIDENCE');
      END IF;
    END IF;
  END IF;
  UPDATE public.agentic_synthetic_invocations SET observation = v_obs, usage_state = 'known', artifact = v_artifact,
    candidate_digest = CASE WHEN v_artifact IS NULL THEN NULL WHEN v_inv.role = 'draft' THEN v_artifact->>'digest'
      ELSE v_artifact->>'candidateDigest' END,
    evidence_digest = CASE WHEN v_artifact IS NULL THEN NULL ELSE v_run.evidence_digest END
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id AND role = v_inv.role AND ordinal = v_inv.ordinal;
  UPDATE public.agentic_synthetic_reservations SET observed_input = observed_input + v_input,
    observed_generated = observed_generated + v_generated,
    usage_state = CASE WHEN EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations WHERE tenant_id = v_run.tenant_id
      AND run_id = v_run.run_id AND usage_state = 'unknown') THEN 'unknown' ELSE 'known' END
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id;
  UPDATE public.agentic_synthetic_runs SET sequence = sequence + 1
   WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id;
  PERFORM public.agentic_synthetic_audit_event(v_run.tenant_id, v_run.run_id, 'OBSERVED', NULL,
    CASE WHEN v_artifact IS NULL THEN NULL WHEN v_inv.role = 'draft' THEN v_artifact->>'digest' END);
  RETURN public.agentic_synthetic_view(v_run.tenant_id, v_run.run_id);
END $$;

-- Atomic final current checks + immutable outcome + audit + settlement. The database derives
-- the Outcome; the proposal only selects a terminal state and a fixed reason. Queue
-- acknowledgement is deliberately separate (queue_control).
CREATE FUNCTION public.agentic_synthetic_finish(p_stamp jsonb, p_expected jsonb, p_proposal jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_code text;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_existing public.agentic_synthetic_outcomes%ROWTYPE;
  v_state text;
  v_reason text;
  v_n integer;
  v_candidate jsonb;
  v_verdict jsonb;
BEGIN
  IF NOT public.agentic_synthetic_stamp_ok(p_stamp) OR NOT public.agentic_synthetic_expected_ok(p_expected)
    OR NOT public.agentic_synthetic_keys(p_proposal, ARRAY['terminalState','reasonCode'],
      ARRAY['candidate','verdict','evidenceDigest'])
    OR jsonb_typeof(p_proposal->'terminalState') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_proposal->'reasonCode') IS DISTINCT FROM 'string' THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  v_state := p_proposal->>'terminalState';
  v_reason := p_proposal->>'reasonCode';
  IF NOT ((v_state = 'released' AND v_reason = 'SIMULATED_RELEASE')
    OR (v_state = 'held' AND v_reason IN ('DIRECTOR_HELD','REPAIR_EXHAUSTED','RECLAIM_HELD','CONTROL_HELD'))
    OR (v_state = 'failed' AND v_reason = 'INVALID_EVIDENCE')
    OR (v_state = 'expired' AND v_reason = 'QUEUE_WAIT_EXPIRED')) THEN
    RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION');
  END IF;
  IF v_state <> 'released' AND (p_proposal ? 'candidate' OR p_proposal ? 'verdict' OR p_proposal ? 'evidenceDigest') THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  PERFORM 1 FROM public.agentic_synthetic_capacity WHERE singleton = 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN public.agentic_synthetic_refusal('STORAGE_UNAVAILABLE'); END IF;
  v_code := public.agentic_synthetic_claim_guard(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs WHERE run_id = (p_stamp->>'runId')::uuid;
  SELECT * INTO v_existing FROM public.agentic_synthetic_outcomes WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id;
  IF FOUND THEN
    -- Idempotent for the same terminal decision; a changed proposal never makes a second outcome.
    IF v_existing.outcome->>'terminalState' = v_state AND v_existing.outcome->>'reasonCode' = v_reason THEN
      RETURN jsonb_build_object('kind','ok','value',v_existing.outcome);
    END IF;
    RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION');
  END IF;
  IF NOT public.agentic_synthetic_expected_matches(v_run.tenant_id, v_run.run_id, p_expected) THEN
    RETURN public.agentic_synthetic_refusal('STALE_SEQUENCE');
  END IF;
  PERFORM public.agentic_synthetic_lock_accounts(v_run.tenant_id, v_run.run_id);
  v_code := public.agentic_synthetic_authority(v_run.tenant_id, v_run.run_id);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  v_code := public.agentic_synthetic_fresh(p_stamp);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  IF v_state = 'released' THEN
    SELECT max(ordinal) INTO v_n FROM public.agentic_synthetic_invocations
     WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id AND role = 'director';
    IF v_run.state <> 'release-pending' OR v_n IS NULL
      OR EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations WHERE tenant_id = v_run.tenant_id
        AND run_id = v_run.run_id AND usage_state = 'unknown')
      OR NOT public.agentic_synthetic_director_is(v_run.tenant_id, v_run.run_id, v_n, 'accept') THEN
      RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION');
    END IF;
    SELECT artifact INTO v_candidate FROM public.agentic_synthetic_invocations
     WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id AND role = 'draft' AND ordinal = v_n;
    SELECT artifact INTO v_verdict FROM public.agentic_synthetic_invocations
     WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id AND role = 'director' AND ordinal = v_n;
    IF p_proposal->'candidate' IS DISTINCT FROM v_candidate OR p_proposal->'verdict' IS DISTINCT FROM v_verdict
      OR p_proposal->>'evidenceDigest' IS DISTINCT FROM v_run.evidence_digest THEN
      RETURN public.agentic_synthetic_refusal('INVALID_EVIDENCE');
    END IF;
  ELSIF v_state = 'expired' THEN
    IF v_run.state <> 'queued' OR clock_timestamp() <= v_run.admitted_at + interval '15 seconds'
      OR EXISTS (SELECT 1 FROM public.agentic_synthetic_invocations WHERE tenant_id = v_run.tenant_id AND run_id = v_run.run_id) THEN
      RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION');
    END IF;
  ELSIF v_run.state IN ('released','held','failed','cancelled','expired') THEN
    RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION');
  END IF;
  RETURN jsonb_build_object('kind','ok','value',
    public.agentic_synthetic_commit_terminal(v_run.tenant_id, v_run.run_id, v_state, v_reason, v_candidate, false));
END $$;

-- App readback: current requester, captured grant/membership and source eligibility even for a
-- stored outcome. A refused reader learns nothing; an in-progress run reads as null.
CREATE FUNCTION public.agentic_synthetic_read(p_run uuid, p_caller jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
  v_actor text := nullif(current_setting('app.current_actor', true), '');
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_code text;
  v_outcome jsonb;
BEGIN
  IF p_run IS NULL OR NOT public.agentic_synthetic_caller_ok(p_caller) THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  IF v_tenant IS NULL OR v_actor IS NULL OR v_tenant <> p_caller->>'tenantId' OR v_actor <> p_caller->>'requesterRef' THEN
    RETURN public.agentic_synthetic_refusal('NOT_AUTHORIZED');
  END IF;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs
   WHERE tenant_id = v_tenant AND run_id = p_run AND requester_ref = v_actor FOR SHARE;
  IF NOT FOUND OR v_run.grant_id <> (p_caller->>'grantId')::uuid
    OR v_run.grant_generation <> (p_caller->>'grantGeneration')::bigint
    OR v_run.membership_version <> (p_caller->>'membershipVersion')::bigint THEN
    RETURN public.agentic_synthetic_refusal('NOT_AUTHORIZED');
  END IF;
  v_code := public.agentic_synthetic_authority(v_run.tenant_id, v_run.run_id);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal('NOT_AUTHORIZED'); END IF;
  SELECT outcome INTO v_outcome FROM public.agentic_synthetic_outcomes WHERE tenant_id = v_tenant AND run_id = p_run;
  RETURN jsonb_build_object('kind','ok','value',coalesce(v_outcome, 'null'::jsonb));
END $$;

-- App cancel: invalidate the claim fence and commit the single cancelled outcome. Known usage
-- settles; unknown usage keeps the full reservation and in-flight permit.
CREATE FUNCTION public.agentic_synthetic_cancel(p_run uuid, p_caller jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
  v_actor text := nullif(current_setting('app.current_actor', true), '');
  v_job uuid;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_existing public.agentic_synthetic_outcomes%ROWTYPE;
  v_code text;
BEGIN
  IF p_run IS NULL OR NOT public.agentic_synthetic_caller_ok(p_caller) THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  IF v_tenant IS NULL OR v_actor IS NULL OR v_tenant <> p_caller->>'tenantId' OR v_actor <> p_caller->>'requesterRef' THEN
    RETURN public.agentic_synthetic_refusal('NOT_AUTHORIZED');
  END IF;
  PERFORM 1 FROM public.agentic_synthetic_capacity WHERE singleton = 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN public.agentic_synthetic_refusal('STORAGE_UNAVAILABLE'); END IF;
  SELECT job_id INTO v_job FROM public.agentic_synthetic_runs
   WHERE tenant_id = v_tenant AND run_id = p_run AND requester_ref = v_actor;
  IF NOT FOUND THEN RETURN public.agentic_synthetic_refusal('NOT_AUTHORIZED'); END IF;
  PERFORM 1 FROM public.jobs WHERE id = v_job FOR UPDATE;
  SELECT * INTO v_run FROM public.agentic_synthetic_runs
   WHERE tenant_id = v_tenant AND run_id = p_run AND requester_ref = v_actor AND job_id = v_job FOR UPDATE;
  IF NOT FOUND OR v_run.grant_id <> (p_caller->>'grantId')::uuid
    OR v_run.grant_generation <> (p_caller->>'grantGeneration')::bigint
    OR v_run.membership_version <> (p_caller->>'membershipVersion')::bigint THEN
    RETURN public.agentic_synthetic_refusal('NOT_AUTHORIZED');
  END IF;
  PERFORM public.agentic_synthetic_lock_accounts(v_run.tenant_id, v_run.run_id);
  v_code := public.agentic_synthetic_authority(v_run.tenant_id, v_run.run_id);
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal('NOT_AUTHORIZED'); END IF;
  SELECT * INTO v_existing FROM public.agentic_synthetic_outcomes WHERE tenant_id = v_tenant AND run_id = p_run;
  IF FOUND THEN
    IF v_existing.outcome->>'terminalState' = 'cancelled' THEN
      RETURN jsonb_build_object('kind','ok','value',v_existing.outcome);
    END IF;
    RETURN public.agentic_synthetic_refusal('INVALID_TRANSITION');
  END IF;
  RETURN jsonb_build_object('kind','ok','value',
    public.agentic_synthetic_commit_terminal(v_run.tenant_id, v_run.run_id, 'cancelled', 'CANCELLED', NULL, true));
END $$;

-- Fenced queue settlement. Only the current claim with a live lease may delegate the fixed
-- existing operation; stale calls do nothing. Failure is always nonretryable.
CREATE FUNCTION public.agentic_synthetic_queue_control(p_stamp jsonb, p_operation text, p_code text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_code text;
  v_job uuid;
  v_worker text;
BEGIN
  IF NOT public.agentic_synthetic_stamp_ok(p_stamp) OR p_operation IS NULL
    OR p_operation NOT IN ('heartbeat','succeed','fail','release')
    OR (p_operation = 'fail' AND (p_code IS NULL OR p_code !~ '^[a-z][a-z0-9-]{1,47}$'))
    OR (p_operation <> 'fail' AND p_code IS NOT NULL) THEN
    RETURN public.agentic_synthetic_refusal('INVALID_INPUT');
  END IF;
  v_code := public.agentic_synthetic_claim_guard(p_stamp);
  -- Settling a run that already has its terminal outcome stays allowed after the deadline.
  IF v_code IS NOT NULL THEN RETURN public.agentic_synthetic_refusal(v_code); END IF;
  v_job := (p_stamp->>'jobId')::uuid;
  v_worker := p_stamp->>'workerId';
  RETURN jsonb_build_object('kind','ok','value', CASE p_operation
    WHEN 'heartbeat' THEN to_jsonb(public.job_heartbeat(v_job, v_worker, 15))
    WHEN 'succeed' THEN to_jsonb(public.job_succeed(v_job, v_worker))
    WHEN 'fail' THEN coalesce(to_jsonb(public.job_fail(v_job, v_worker, p_code, false)), 'null'::jsonb)
    ELSE to_jsonb(public.job_release(v_job, v_worker)) END);
END $$;

REVOKE ALL ON FUNCTION public.agentic_synthetic_claim(text, integer), public.agentic_synthetic_load(jsonb, jsonb),
  public.agentic_synthetic_sources(jsonb, jsonb), public.agentic_synthetic_advance(jsonb, jsonb, text),
  public.agentic_synthetic_begin(jsonb, jsonb, jsonb), public.agentic_synthetic_observe(jsonb, jsonb, jsonb),
  public.agentic_synthetic_finish(jsonb, jsonb, jsonb), public.agentic_synthetic_read(uuid, jsonb),
  public.agentic_synthetic_cancel(uuid, jsonb), public.agentic_synthetic_queue_control(jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agentic_synthetic_claim(text, integer), public.agentic_synthetic_load(jsonb, jsonb),
  public.agentic_synthetic_sources(jsonb, jsonb), public.agentic_synthetic_advance(jsonb, jsonb, text),
  public.agentic_synthetic_begin(jsonb, jsonb, jsonb), public.agentic_synthetic_observe(jsonb, jsonb, jsonb),
  public.agentic_synthetic_finish(jsonb, jsonb, jsonb), public.agentic_synthetic_queue_control(jsonb, text, text)
  TO telesphoros_worker;
GRANT EXECUTE ON FUNCTION public.agentic_synthetic_read(uuid, jsonb), public.agentic_synthetic_cancel(uuid, jsonb)
  TO telesphoros_app;

RESET ROLE;
-- The jobs owner has SELECT, not UPDATE, on tenants. A tiny migration-owned
-- definer locks the current tenant row without broadening shared queue privileges.
CREATE FUNCTION public.agentic_synthetic_tenant_active(p_tenant text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.tenants WHERE id = p_tenant AND status = 'active' FOR SHARE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.agentic_synthetic_tenant_active(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agentic_synthetic_tenant_active(text) TO telesphoros_jobs;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
