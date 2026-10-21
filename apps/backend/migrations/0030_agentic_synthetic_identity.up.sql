-- compat: breaking
-- P2 option B (founder decision 2026-10-19: A for synthetic staging only, B before real data): the three application entry points of the synthetic
-- durable workflow take their caller from a presented tenant capability, never from the raw settings app.current_tenant_id / app.current_actor.
--
--   * agentic_synthetic_identity() is the one place that reads it. It requires app.capability to be set, in EVERY binding mode: app_tenant() and
--     app_actor() fall back to the settings when no token is set in the guc and dual modes (0028), which would leave a forged setting an identity.
--   * agentic_synthetic_admit, _read and _cancel keep their signatures, grants and bodies; only the identity lines change, and admit refuses (and
--     rolls the whole admission back) unless the queue row job_enqueue wrote carries the verified tenant and person, because job_enqueue (0023)
--     still reads the settings itself. DATA-01 slice 3 moves it onto app_actor(); this check stays valid afterwards.
--   * Labelled breaking: CREATE OR REPLACE is not allowed in an expand migration, and a caller that presents no capability is refused from here on.
--   * Not changed on purpose: agentic_synthetic_member_current (worker side) still writes the tenant setting. DATA-01 slice 5 must not flip the
--     mode to 'capability' before the P2 worker side binds through the internal binding (FR-015) or slice 7.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs;
SET LOCAL ROLE telesphoros_jobs;

-- Precondition, before anything is replaced: the bodies being replaced are the ones this migration was written against.
DO $$
DECLARE
  v_expected text[][] := ARRAY[
    ARRAY['public.agentic_synthetic_admit(jsonb, jsonb)', '854a308f02599ba758c945c4a7870dd4'],
    ARRAY['public.agentic_synthetic_read(uuid, jsonb)', '67737e6b45cd9157f06b42235cf43c7a'],
    ARRAY['public.agentic_synthetic_cancel(uuid, jsonb)', '1e33dbab66fbbb0de2a429b420a2e0d2']
  ];
  v_i integer;
BEGIN
  FOR v_i IN 1 .. array_length(v_expected, 1) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_expected[v_i][1])) IS DISTINCT FROM v_expected[v_i][2] THEN
      RAISE EXCEPTION 'Migration 0030 expects the 0029 body of % and found another.', v_expected[v_i][1];
    END IF;
  END LOOP;
  -- Owner and privileges of the three entry points as they are now: CREATE OR REPLACE must keep them, and the post-condition below checks that it did.
  PERFORM set_config('tp2.entry_acl_0030', (SELECT string_agg(p.oid::regprocedure::text || ' owner=' || p.proowner::regrole::text || ' acl=' || coalesce(p.proacl::text, 'null'),
      '; ' ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('agentic_synthetic_admit', 'agentic_synthetic_read', 'agentic_synthetic_cancel')), true);
END $$;

CREATE FUNCTION public.agentic_synthetic_identity() RETURNS TABLE (tenant_id text, actor text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant text;
  v_actor text;
BEGIN
  -- A capability must be presented. app_tenant() and app_actor() alone fall back to the raw settings in the guc and dual modes (0028), so
  -- without this line a forged setting would still be an identity. With a token they ignore the actor setting and refuse a foreign tenant setting.
  IF nullif(current_setting('app.capability', true), '') IS NULL THEN RETURN; END IF;
  v_tenant := public.app_tenant();
  v_actor := public.app_actor();
  IF v_tenant IS NULL OR v_actor IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT v_tenant, v_actor;
END $$;
REVOKE ALL ON FUNCTION public.agentic_synthetic_identity() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.agentic_synthetic_admit(p_input jsonb, p_caller jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
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
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_synthetic_identity() i;
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
     -- Byte order, never the database collation: the evidence preimage must not change with locale.
     ORDER BY s.source_id COLLATE "C", s.source_version COLLATE "C" FOR SHARE OF l, s
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
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = v_job_id AND j.tenant_id = v_tenant AND j.requested_by = v_actor) THEN
    RAISE EXCEPTION 'Synthetic enqueue identity mismatch.' USING ERRCODE = 'integrity_constraint_violation';
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

CREATE OR REPLACE FUNCTION public.agentic_synthetic_read(p_run uuid, p_caller jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_code text;
  v_outcome jsonb;
BEGIN
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_synthetic_identity() i;
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

CREATE OR REPLACE FUNCTION public.agentic_synthetic_cancel(p_run uuid, p_caller jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
  v_job uuid;
  v_run public.agentic_synthetic_runs%ROWTYPE;
  v_existing public.agentic_synthetic_outcomes%ROWTYPE;
  v_code text;
BEGIN
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_synthetic_identity() i;
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

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;

-- Post-condition: no function the application can execute reads a tenant or actor setting, and each of them asks the helper.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'agentic_synthetic_%'
               AND has_function_privilege('telesphoros_app', p.oid, 'EXECUTE')
               AND (p.prosrc ~ 'app\.current_(tenant_id|actor)' OR p.prosrc !~ 'public\.agentic_synthetic_identity\(\)')) THEN
    RAISE EXCEPTION 'An application entry point of the synthetic workflow still reads a session setting for identity.';
  END IF;
  IF (SELECT string_agg(p.oid::regprocedure::text || ' owner=' || p.proowner::regrole::text || ' acl=' || coalesce(p.proacl::text, 'null'),
        '; ' ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('agentic_synthetic_admit', 'agentic_synthetic_read', 'agentic_synthetic_cancel'))
     IS DISTINCT FROM current_setting('tp2.entry_acl_0030', true) THEN
    RAISE EXCEPTION 'Migration 0030 changed the owner or privileges of an entry point.';
  END IF;
END $$;
