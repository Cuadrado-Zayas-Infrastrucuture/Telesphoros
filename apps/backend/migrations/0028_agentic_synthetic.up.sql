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
