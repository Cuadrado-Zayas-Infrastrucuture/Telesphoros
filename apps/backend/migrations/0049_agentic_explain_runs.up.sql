-- compat: breaking
-- Labelled breaking only because the migration lint refuses REVOKE and a TRUNCATE trigger in an expand migration (the rules are textual); every object here is new and nothing
-- older code uses is changed, as in 0029 and 0048.
-- The durable run of an explanation (LLM harness slice 3b-2a, specs/003-llm-harness): the idempotency key, the fenced state and the deadline of one run of
-- apps/ai-service/src/explain.ts, so that a retried request finds its run, two workers cannot both advance it, and a cancelled or crashed run is not left open for ever.
-- It holds ids, hashes, a state and times. No text: the idempotency key is kept as a hash, the request as a KEYED digest (hmac-sha256:), never a plain one.
--   * Same ownership and access as the receipts (0048): the table belongs to the NOLOGIN role telesphoros_jobs, forced row-level security with one owner policy, no login holds a table
--     privilege; the application reaches it through four capability-bound functions (admit, get, advance, cancel) that take their caller from agentic_explain_identity() and see only
--     the caller's own organization AND requester. A suspended organization is refused (0047).
--   * The state machine is in SQL (agentic_explain_transition_ok, one explicit list of the 31 legal pairs; a test reads this file and compares the list with canTransition in
--     apps/ai-service/src/kernel.ts) and again in a row trigger, so even a caller with table access cannot make an illegal move. advance is a compare-and-swap on state, sequence and
--     fence under a row lock: of any number of concurrent advances from the same state exactly one wins. cancel raises the fence, so a worker that still holds the old one is stale.
--   * A run that was never finished is not left open: admit expires an existing run past its deadline (the retry then replays the engine text, as for any finished run) and
--     agentic_explain_run_sweep() expires them all. Both are the only way a run leaves an in-flight state without the process that owns it.
--   * Rows: a finished run is frozen; the identity columns never change; sequence rises by one; the fence rises only with a cancellation. A delete is refused until a finished run is 2190 days
--     old (6 years, as the receipts; founder decision 2026-10-25), whoever asks; both triggers are ENABLE ALWAYS. The operator purge is executable by no login. An organization may admit at most
--     1000 runs an hour (RATE_LIMITED; initial value, as for receipts).
--   * Not closable here, same class as 0048: the owner can disable or drop the triggers or the table, or back-date a row. The down migration's setting is the only guard against DROP TABLE.
-- Nothing is seeded. Usage reservation and the fleet and tenant caps are the next slice (3b-2b); the TypeScript store is apps/ai-service/durable/run-store.ts.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs;
SET LOCAL ROLE telesphoros_jobs;

CREATE TABLE public.agentic_explain_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9._:@-]{1,128}$'),
  requester_ref text NOT NULL CHECK (requester_ref ~ '^[A-Za-z0-9._:@-]{1,128}$'),
  key_hash text NOT NULL CHECK (key_hash ~ '^sha256:[0-9a-f]{64}$'),
  tuple_digest text NOT NULL CHECK (tuple_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  harness_version text NOT NULL CHECK (harness_version ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('admitted','queued','running','reviewing','repair-pending','release-pending','released','held','failed','cancelled','expired')),
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  fence bigint NOT NULL DEFAULT 1 CHECK (fence >= 1),
  mono_at bigint NOT NULL CHECK (mono_at >= 0),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (tenant_id, requester_ref, key_hash),
  CHECK (deadline_at > admitted_at),
  CHECK ((state IN ('released','held','failed','cancelled','expired')) = (finished_at IS NOT NULL))
);
CREATE INDEX agentic_explain_runs_admitted ON public.agentic_explain_runs (tenant_id, admitted_at);
CREATE INDEX agentic_explain_runs_open ON public.agentic_explain_runs (deadline_at) WHERE finished_at IS NULL;
CREATE INDEX agentic_explain_runs_finished ON public.agentic_explain_runs (tenant_id, finished_at) WHERE finished_at IS NOT NULL;

ALTER TABLE public.agentic_explain_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agentic_explain_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY agentic_explain_runs_owner ON public.agentic_explain_runs FOR ALL TO telesphoros_jobs USING (true) WITH CHECK (true);

-- The legal moves, one explicit list (apps/ai-service/src/kernel.ts canTransition): the chain admitted > queued > running > reviewing > (repair-pending > running | release-pending),
-- release-pending > released, and from any state that is not final to held, failed, cancelled or expired. A final state moves nowhere.
-- transitions:begin
CREATE FUNCTION public.agentic_explain_transition_ok(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM (VALUES
    ('admitted','queued'), ('queued','running'), ('running','reviewing'), ('reviewing','repair-pending'), ('reviewing','release-pending'), ('repair-pending','running'),
    ('release-pending','released'),
    ('admitted','held'), ('admitted','failed'), ('admitted','cancelled'), ('admitted','expired'),
    ('queued','held'), ('queued','failed'), ('queued','cancelled'), ('queued','expired'),
    ('running','held'), ('running','failed'), ('running','cancelled'), ('running','expired'),
    ('reviewing','held'), ('reviewing','failed'), ('reviewing','cancelled'), ('reviewing','expired'),
    ('repair-pending','held'), ('repair-pending','failed'), ('repair-pending','cancelled'), ('repair-pending','expired'),
    ('release-pending','held'), ('release-pending','failed'), ('release-pending','cancelled'), ('release-pending','expired')
  ) t(f, n) WHERE t.f = p_from AND t.n = p_to);
$$;
-- transitions:end
REVOKE ALL ON FUNCTION public.agentic_explain_transition_ok(text, text) FROM PUBLIC;

-- What the caller sees of a run: the shape of Run in apps/ai-service/src/contracts.ts (times in epoch milliseconds).
CREATE FUNCTION public.agentic_explain_run_json(r public.agentic_explain_runs) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('id', r.run_id, 'tenantId', r.tenant_id, 'requesterRef', r.requester_ref, 'state', r.state, 'sequence', r.sequence, 'fence', r.fence,
    'admittedAt', floor(extract(epoch FROM r.admitted_at) * 1000)::bigint, 'monoAt', r.mono_at, 'deadlineAt', floor(extract(epoch FROM r.deadline_at) * 1000)::bigint,
    'profileDigest', r.harness_version);
$$;
REVOKE ALL ON FUNCTION public.agentic_explain_run_json(public.agentic_explain_runs) FROM PUBLIC;

CREATE FUNCTION public.agentic_explain_run_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.finished_at IS NOT NULL AND OLD.finished_at < clock_timestamp() - interval '2190 days' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'An explanation run is immutable until it is finished and 2190 days old.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'A finished explanation run is immutable.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW.run_id, NEW.tenant_id, NEW.requester_ref, NEW.key_hash, NEW.tuple_digest, NEW.harness_version, NEW.mono_at, NEW.admitted_at, NEW.deadline_at)
       IS DISTINCT FROM (OLD.run_id, OLD.tenant_id, OLD.requester_ref, OLD.key_hash, OLD.tuple_digest, OLD.harness_version, OLD.mono_at, OLD.admitted_at, OLD.deadline_at) THEN
      RAISE EXCEPTION 'The identity of an explanation run is immutable.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.sequence IS DISTINCT FROM OLD.sequence + 1 OR NOT public.agentic_explain_transition_ok(OLD.state, NEW.state)
       OR NEW.fence NOT IN (OLD.fence, OLD.fence + 1) OR (NEW.fence = OLD.fence + 1 AND NEW.state <> 'cancelled') THEN
      RAISE EXCEPTION 'An explanation run advances by one legal step at a time.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An explanation run cannot be truncated.' USING ERRCODE = 'integrity_constraint_violation';
END $$;
REVOKE ALL ON FUNCTION public.agentic_explain_run_guard() FROM PUBLIC;
CREATE TRIGGER agentic_explain_run_guard BEFORE UPDATE OR DELETE ON public.agentic_explain_runs
FOR EACH ROW EXECUTE FUNCTION public.agentic_explain_run_guard();
CREATE TRIGGER agentic_explain_run_no_truncate BEFORE TRUNCATE ON public.agentic_explain_runs
FOR EACH STATEMENT EXECUTE FUNCTION public.agentic_explain_run_guard();
ALTER TABLE public.agentic_explain_runs ENABLE ALWAYS TRIGGER agentic_explain_run_guard;
ALTER TABLE public.agentic_explain_runs ENABLE ALWAYS TRIGGER agentic_explain_run_no_truncate;

CREATE FUNCTION public.agentic_explain_run_admit(p_key_hash text, p_tuple text, p_harness text, p_mono bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
  r public.agentic_explain_runs%ROWTYPE;
  v_recent bigint;
BEGIN
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_explain_identity() i;
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  IF NOT (coalesce(p_key_hash ~ '^sha256:[0-9a-f]{64}$', false) AND coalesce(p_tuple ~ '^hmac-sha256:[0-9a-f]{64}$', false)
          AND coalesce(p_harness ~ '^sha256:[0-9a-f]{64}$', false) AND coalesce(p_mono >= 0, false)) THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  SELECT * INTO r FROM public.agentic_explain_runs WHERE tenant_id = v_tenant AND requester_ref = v_actor AND key_hash = p_key_hash FOR UPDATE;
  IF FOUND THEN
    -- A run its process never finished is closed here, so a retry does not wait on it for ever.
    IF r.finished_at IS NULL AND r.deadline_at < clock_timestamp() THEN
      UPDATE public.agentic_explain_runs SET state = 'expired', sequence = sequence + 1, finished_at = clock_timestamp() WHERE run_id = r.run_id RETURNING * INTO r;
    END IF;
    RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('kind', CASE WHEN r.tuple_digest = p_tuple THEN 'existing' ELSE 'conflict' END, 'run', public.agentic_explain_run_json(r)));
  END IF;
  SELECT count(*) INTO v_recent FROM public.agentic_explain_runs WHERE tenant_id = v_tenant AND admitted_at > clock_timestamp() - interval '1 hour';
  IF v_recent >= 1000 THEN
    RETURN jsonb_build_object('kind','refused','code','RATE_LIMITED');
  END IF;
  INSERT INTO public.agentic_explain_runs (tenant_id, requester_ref, key_hash, tuple_digest, harness_version, state, mono_at, deadline_at)
  VALUES (v_tenant, v_actor, p_key_hash, p_tuple, p_harness, 'admitted', p_mono, clock_timestamp() + interval '120 seconds')
  ON CONFLICT (tenant_id, requester_ref, key_hash) DO NOTHING
  RETURNING * INTO r;
  IF FOUND THEN
    RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('kind','new','run', public.agentic_explain_run_json(r)));
  END IF;
  -- Another admission of the same key committed between the lookup and the insert: report on it.
  SELECT * INTO r FROM public.agentic_explain_runs WHERE tenant_id = v_tenant AND requester_ref = v_actor AND key_hash = p_key_hash;
  RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('kind', CASE WHEN r.tuple_digest = p_tuple THEN 'existing' ELSE 'conflict' END, 'run', public.agentic_explain_run_json(r)));
END $$;

CREATE FUNCTION public.agentic_explain_run_get(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
  r public.agentic_explain_runs%ROWTYPE;
BEGIN
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_explain_identity() i;
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  IF p_run IS NULL THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  SELECT * INTO r FROM public.agentic_explain_runs WHERE tenant_id = v_tenant AND requester_ref = v_actor AND run_id = p_run;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind','ok','value','null'::jsonb);
  END IF;
  RETURN jsonb_build_object('kind','ok','value',public.agentic_explain_run_json(r));
END $$;

-- Compare-and-swap: the run moves only if it is still in the state, at the sequence and under the fence the caller saw. The row lock makes concurrent callers take turns,
-- so of any number advancing from the same state exactly one succeeds and the rest see STALE.
CREATE FUNCTION public.agentic_explain_run_advance(p_run uuid, p_expected jsonb, p_next text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
  r public.agentic_explain_runs%ROWTYPE;
  v_seq text;
  v_fence text;
BEGIN
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_explain_identity() i;
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  IF p_run IS NULL OR p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_expected) k) IS DISTINCT FROM ARRAY['fence','sequence','state'] THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  v_seq := p_expected->>'sequence';
  v_fence := p_expected->>'fence';
  IF NOT (jsonb_typeof(p_expected->'state') = 'string' AND jsonb_typeof(p_expected->'sequence') = 'number' AND jsonb_typeof(p_expected->'fence') = 'number'
          AND coalesce(v_seq ~ '^[0-9]{1,15}$', false) AND coalesce(v_fence ~ '^[0-9]{1,15}$', false)
          AND coalesce(p_next ~ '^[a-z-]{1,32}$', false)) THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  SELECT * INTO r FROM public.agentic_explain_runs WHERE tenant_id = v_tenant AND requester_ref = v_actor AND run_id = p_run FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_FOUND');
  END IF;
  IF r.state <> p_expected->>'state' OR r.sequence <> v_seq::bigint OR r.fence <> v_fence::bigint THEN
    RETURN jsonb_build_object('kind','refused','code','STALE');
  END IF;
  IF NOT public.agentic_explain_transition_ok(r.state, p_next) THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_TRANSITION');
  END IF;
  UPDATE public.agentic_explain_runs
     SET state = p_next, sequence = sequence + 1,
         finished_at = CASE WHEN p_next IN ('released','held','failed','cancelled','expired') THEN clock_timestamp() ELSE NULL END
   WHERE run_id = r.run_id RETURNING * INTO r;
  RETURN jsonb_build_object('kind','ok','value',public.agentic_explain_run_json(r));
END $$;

-- Cancels the caller's own unfinished run and raises the fence, so a worker still holding the old fence is stale at its next step.
CREATE FUNCTION public.agentic_explain_run_cancel(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
  r public.agentic_explain_runs%ROWTYPE;
BEGIN
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_explain_identity() i;
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  IF p_run IS NULL THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  SELECT * INTO r FROM public.agentic_explain_runs WHERE tenant_id = v_tenant AND requester_ref = v_actor AND run_id = p_run FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_FOUND');
  END IF;
  IF r.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_TRANSITION');
  END IF;
  UPDATE public.agentic_explain_runs SET state = 'cancelled', sequence = sequence + 1, fence = fence + 1, finished_at = clock_timestamp() WHERE run_id = r.run_id RETURNING * INTO r;
  RETURN jsonb_build_object('kind','ok','value',public.agentic_explain_run_json(r));
END $$;

-- Operator functions: executable by no login (the migrator runs them through SET ROLE telesphoros_jobs). They need no capability, so they reach every organization,
-- suspended and offboarded ones included.
CREATE FUNCTION public.agentic_explain_run_sweep() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '60s' AS $$
DECLARE
  v_expired bigint;
BEGIN
  UPDATE public.agentic_explain_runs SET state = 'expired', sequence = sequence + 1, finished_at = clock_timestamp() WHERE finished_at IS NULL AND deadline_at < clock_timestamp();
  GET DIAGNOSTICS v_expired = ROW_COUNT;
  RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('expired', v_expired));
END $$;

CREATE FUNCTION public.agentic_explain_run_purge(p_tenant text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '60s' AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_tenant IS NOT NULL AND p_tenant !~ '^[A-Za-z0-9._:@-]{1,128}$' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  DELETE FROM public.agentic_explain_runs WHERE (p_tenant IS NULL OR tenant_id = p_tenant) AND finished_at < clock_timestamp() - interval '2190 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('deleted', v_deleted));
END $$;

REVOKE ALL ON FUNCTION public.agentic_explain_run_admit(text, text, text, bigint), public.agentic_explain_run_get(uuid), public.agentic_explain_run_advance(uuid, jsonb, text),
  public.agentic_explain_run_cancel(uuid), public.agentic_explain_run_sweep(), public.agentic_explain_run_purge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agentic_explain_run_admit(text, text, text, bigint), public.agentic_explain_run_get(uuid), public.agentic_explain_run_advance(uuid, jsonb, text),
  public.agentic_explain_run_cancel(uuid) TO telesphoros_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
