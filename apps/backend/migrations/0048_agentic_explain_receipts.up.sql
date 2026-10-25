-- compat: breaking
-- Labelled breaking only because the migration lint refuses REVOKE and a TRUNCATE trigger in an expand migration (the rules are textual); every object here is new and nothing
-- older code uses is changed, as in 0029.
-- Stores the receipt of an explanation run (LLM harness slice 3b-1, specs/003-llm-harness; outcome v2 in apps/ai-service/src/outcome-v2.ts).
-- A receipt is digests, fixed codes and counters. It has no column that can hold text (FR-014, R5): every text column below is bound to a pattern or a list, so a
-- result, a phenotype or a model word cannot be written even by the function that writes it. The evidence and output digests are keyed (hmac-sha256:), never plain.
--   * Table owned by the NOLOGIN role telesphoros_jobs, as the synthetic agentic tables are (0029). No login holds a table privilege. FORCE ROW LEVEL SECURITY, one
--     owner policy; the application reaches the table only through agentic_explain_receipt_append and _read.
--   * Those two take their caller from agentic_explain_identity(), a thin helper of this family with the body of agentic_synthetic_identity() (0030): a presented
--     capability, never a raw setting, and NULL for a suspended organization (0047). Its own copy, so dropping the synthetic family later does not break receipts.
--     The receipt's tenant and requester must equal that identity. EXECUTE goes to the application login only: the worker cannot present a capability.
--   * Append-only: an UPDATE is refused for everyone, the owner included; so is TRUNCATE; a DELETE is refused until the row is 2190 days (6 years) old, whoever asks
--     (founder decision 2026-10-25: retention 6 years, as the reports bucket). The triggers are ENABLE ALWAYS, so session_replication_role = replica does not skip them.
--     Not closable here, same class as security_events: the owner (the migrator through SET ROLE) can disable or drop the triggers, drop the table, or back-date a row.
--   * A tenant can add at most 1000 receipts an hour (initial value, a founder-adjustable constant): rows are undeletable for six years, so an unbounded writer would be
--     an irreversible way to grow the table. The count is not locked, so concurrent appends may overshoot it slightly.
--   * Purge is an operator function: agentic_explain_receipt_purge(tenant or NULL) is executable by no login, run by the migrator through SET ROLE telesphoros_jobs. It reaches
--     every organization, suspended or offboarded ones included, which a capability-bound purge could not.
--   * Erasure on request: there is no row erasure. A receipt holds no text; the path to make its digests unlinkable is destroying or rotating the digest key.
--     Counsel is to confirm that before real data (R5).
-- Nothing is seeded. Nothing references this table yet except the functions below; the TypeScript store is apps/ai-service/durable/receipt-store.ts.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs;
SET LOCAL ROLE telesphoros_jobs;

CREATE TABLE public.agentic_explain_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9._:@-]{1,128}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9._:@-]{1,128}$'),
  requester_ref text NOT NULL CHECK (requester_ref ~ '^[A-Za-z0-9._:@-]{1,128}$'),
  task text NOT NULL CHECK (task = 'pgx.explain.v1'),
  terminal_state text NOT NULL CHECK (terminal_state IN ('released','held','expired')),
  reason_code text NOT NULL CHECK (reason_code IN ('RELEASED','INVALID_INPUT','TASK_UNDECLARED','NOT_SYNTHETIC','NO_BAA','AUTHORITY_HELD','IDEMPOTENCY_CONFLICT','IN_PROGRESS',
    'IDEMPOTENT_REPLAY','BUDGET_HELD','NOT_ELIGIBLE','INPUT_REFUSED','USAGE_HELD','MODEL_ERROR','MODEL_REFUSED','INVALID_STRUCTURE','SENSOR_HOLD','VERIFIER_HOLD','DEADLINE','CONTROL_HELD')),
  detail_codes text NOT NULL DEFAULT '' CHECK (detail_codes ~ '^([A-Za-z][A-Za-z0-9_-]{1,63}(,[A-Za-z][A-Za-z0-9_-]{1,63}){0,15})?$'),
  harness_version text NOT NULL CHECK (harness_version ~ '^sha256:[0-9a-f]{64}$'),
  model_id text CHECK (model_id ~ '^(scripted-v[0-9]+|[a-z0-9.-]+\.[a-z0-9-]+-[0-9]{8}-v[0-9]+:[0-9]+)$'),
  invocation_path text CHECK (invocation_path IN ('on-demand','inference-profile','scripted')),
  sdk_version text CHECK (sdk_version ~ '^(none|[0-9]+\.[0-9]+\.[0-9]+)$'),
  template_digest text CHECK (template_digest ~ '^sha256:[0-9a-f]{64}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  output_digest text CHECK (output_digest ~ '^hmac-sha256:[0-9a-f]{64}$'),
  guards_run text NOT NULL DEFAULT '' CHECK (guards_run ~ '^((S[1-6]|VERIFIER)(,(S[1-6]|VERIFIER)){0,6})?$'),
  slots integer NOT NULL CHECK (slots BETWEEN 0 AND 4),
  model_calls integer NOT NULL CHECK (model_calls BETWEEN 0 AND 4),
  input_units bigint NOT NULL CHECK (input_units >= 0),
  generated_units bigint NOT NULL CHECK (generated_units >= 0),
  usage_state text NOT NULL CHECK (usage_state IN ('known','unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((model_id IS NULL) = (invocation_path IS NULL) AND (model_id IS NULL) = (sdk_version IS NULL)),
  CHECK ((model_calls > 0) = (model_id IS NOT NULL)),
  CHECK ((terminal_state = 'released') = (reason_code = 'RELEASED')),
  CHECK (terminal_state <> 'released' OR (output_digest IS NOT NULL AND usage_state = 'known' AND model_id IS NOT NULL))
);
-- One receipt per admitted run. Refusals before admission all carry the run id 'unadmitted' and are not unique.
CREATE UNIQUE INDEX agentic_explain_receipts_run ON public.agentic_explain_receipts (tenant_id, run_id) WHERE run_id <> 'unadmitted';
CREATE INDEX agentic_explain_receipts_age ON public.agentic_explain_receipts (tenant_id, created_at);

ALTER TABLE public.agentic_explain_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agentic_explain_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY agentic_explain_receipts_owner ON public.agentic_explain_receipts FOR ALL TO telesphoros_jobs USING (true) WITH CHECK (true);

-- Immutable, except that a row past its retention may be deleted. The floor lives here, not in the purge function, so no caller (the owner included) can delete a young row.
CREATE FUNCTION public.agentic_explain_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.created_at < clock_timestamp() - interval '2190 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'An explanation receipt is immutable until it is 2190 days old.' USING ERRCODE = 'integrity_constraint_violation';
END $$;
REVOKE ALL ON FUNCTION public.agentic_explain_receipt_guard() FROM PUBLIC;
CREATE TRIGGER agentic_explain_receipt_guard BEFORE UPDATE OR DELETE ON public.agentic_explain_receipts
FOR EACH ROW EXECUTE FUNCTION public.agentic_explain_receipt_guard();
CREATE TRIGGER agentic_explain_receipt_no_truncate BEFORE TRUNCATE ON public.agentic_explain_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.agentic_explain_receipt_guard();
-- ENABLE ALWAYS: a session with session_replication_role = replica (a superuser, or a role granted SET on it) must not skip the guard.
ALTER TABLE public.agentic_explain_receipts ENABLE ALWAYS TRIGGER agentic_explain_receipt_guard;
ALTER TABLE public.agentic_explain_receipts ENABLE ALWAYS TRIGGER agentic_explain_receipt_no_truncate;

CREATE FUNCTION public.agentic_explain_identity() RETURNS TABLE (tenant_id text, actor text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant text;
  v_actor text;
BEGIN
  -- A capability must be presented. app_tenant() and app_actor() alone fall back to the raw settings in the guc and dual modes (0028), so without this line a forged
  -- setting would still be an identity. With a token they ignore the actor setting and refuse a foreign tenant setting; app_tenant() is NULL for a suspended organization (0047).
  IF nullif(current_setting('app.capability', true), '') IS NULL THEN RETURN; END IF;
  v_tenant := public.app_tenant();
  v_actor := public.app_actor();
  IF v_tenant IS NULL OR v_actor IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT v_tenant, v_actor;
END $$;
REVOKE ALL ON FUNCTION public.agentic_explain_identity() FROM PUBLIC;

CREATE FUNCTION public.agentic_explain_receipt_append(p_receipt jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
  v_model jsonb;
  v_digests jsonb;
  v_counters jsonb;
  v_recent bigint;
  v_id uuid;
BEGIN
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_explain_identity() i;
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  -- Exactly the outcome v2 keys at every level: an extra key is where text would be smuggled in. Each step below runs only after the one before it
  -- has proved the type it relies on (SQL does not promise the order of OR terms, so there is no OR across a type test and a use of the value).
  IF p_receipt IS NULL OR jsonb_typeof(p_receipt) <> 'object' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_receipt) k)
       IS DISTINCT FROM ARRAY['counters','detailCodes','digests','evidenceKind','guardsRun','harnessVersion','model','reasonCode','requesterRef','runId','schemaVersion','task','tenantId','terminalState']
    OR p_receipt->>'schemaVersion' IS DISTINCT FROM 'agentic.explain-outcome.v2'
    OR p_receipt->>'evidenceKind' IS DISTINCT FROM 'harness-run' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  v_model := p_receipt->'model';
  v_digests := p_receipt->'digests';
  v_counters := p_receipt->'counters';
  IF jsonb_typeof(v_digests) <> 'object' OR jsonb_typeof(v_counters) <> 'object' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_digests) k) IS DISTINCT FROM ARRAY['evidence','output','template']
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_counters) k) IS DISTINCT FROM ARRAY['generatedUnits','inputUnits','modelCalls','slots','usageState'] THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  IF jsonb_typeof(v_model) = 'object' THEN
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_model) k) IS DISTINCT FROM ARRAY['invocationPath','modelId','sdkVersion'] THEN
      RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
    END IF;
  ELSIF jsonb_typeof(v_model) <> 'null' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  IF jsonb_typeof(p_receipt->'detailCodes') <> 'array' OR jsonb_typeof(p_receipt->'guardsRun') <> 'array' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  -- Each element is checked on its own against the single-code pattern before the list is joined, so ["AB,CD"] and [""] cannot read back as something else.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_receipt->'detailCodes') e WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_-]{1,63}$')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_receipt->'guardsRun') e WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~ '^(S[1-6]|VERIFIER)$')
    OR EXISTS (SELECT 1 FROM jsonb_each(v_counters) c WHERE c.key <> 'usageState' AND (jsonb_typeof(c.value) <> 'number' OR c.value::text !~ '^[0-9]{1,15}$'))
    OR EXISTS (SELECT 1 FROM jsonb_each(p_receipt) t WHERE t.key IN ('runId','tenantId','requesterRef','task','terminalState','reasonCode','harnessVersion') AND jsonb_typeof(t.value) <> 'string') THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  IF p_receipt->>'tenantId' IS DISTINCT FROM v_tenant OR p_receipt->>'requesterRef' IS DISTINCT FROM v_actor THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  SELECT count(*) INTO v_recent FROM public.agentic_explain_receipts WHERE tenant_id = v_tenant AND created_at > clock_timestamp() - interval '1 hour';
  IF v_recent >= 1000 THEN
    RETURN jsonb_build_object('kind','refused','code','RATE_LIMITED');
  END IF;
  BEGIN
    INSERT INTO public.agentic_explain_receipts (tenant_id, run_id, requester_ref, task, terminal_state, reason_code, detail_codes, harness_version, model_id, invocation_path,
      sdk_version, template_digest, evidence_digest, output_digest, guards_run, slots, model_calls, input_units, generated_units, usage_state)
    VALUES (v_tenant, p_receipt->>'runId', v_actor, p_receipt->>'task', p_receipt->>'terminalState', p_receipt->>'reasonCode',
      (SELECT coalesce(string_agg(e #>> '{}', ','), '') FROM jsonb_array_elements(p_receipt->'detailCodes') e), p_receipt->>'harnessVersion',
      v_model->>'modelId', v_model->>'invocationPath', v_model->>'sdkVersion', v_digests->>'template', v_digests->>'evidence', v_digests->>'output',
      (SELECT coalesce(string_agg(e #>> '{}', ','), '') FROM jsonb_array_elements(p_receipt->'guardsRun') e),
      (v_counters->>'slots')::integer, (v_counters->>'modelCalls')::integer, (v_counters->>'inputUnits')::bigint, (v_counters->>'generatedUnits')::bigint, v_counters->>'usageState')
    RETURNING receipt_id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN RETURN jsonb_build_object('kind','refused','code','DUPLICATE');
    WHEN check_violation OR not_null_violation OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END;
  RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('receiptId',v_id));
END $$;

-- Rebuilds outcome v2 from the typed columns, so a stored receipt round-trips to exactly what was appended (the append function checks each list element on its own).
CREATE FUNCTION public.agentic_explain_receipt_read(p_run text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
DECLARE
  v_tenant text;
  v_actor text;
  r public.agentic_explain_receipts%ROWTYPE;
BEGIN
  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_explain_identity() i;
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RETURN jsonb_build_object('kind','refused','code','NOT_AUTHORIZED');
  END IF;
  IF p_run IS NULL OR p_run = 'unadmitted' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  SELECT * INTO r FROM public.agentic_explain_receipts WHERE tenant_id = v_tenant AND run_id = p_run;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind','ok','value','null'::jsonb);
  END IF;
  RETURN jsonb_build_object('kind','ok','value',jsonb_build_object(
    'schemaVersion','agentic.explain-outcome.v2','evidenceKind','harness-run','runId',r.run_id,'tenantId',r.tenant_id,'requesterRef',r.requester_ref,'task',r.task,
    'terminalState',r.terminal_state,'reasonCode',r.reason_code,
    'detailCodes',CASE WHEN r.detail_codes = '' THEN '[]'::jsonb ELSE to_jsonb(string_to_array(r.detail_codes, ',')) END,
    'harnessVersion',r.harness_version,
    'model',CASE WHEN r.model_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('modelId',r.model_id,'invocationPath',r.invocation_path,'sdkVersion',r.sdk_version) END,
    'digests',jsonb_build_object('template',r.template_digest,'evidence',r.evidence_digest,'output',r.output_digest),
    'guardsRun',CASE WHEN r.guards_run = '' THEN '[]'::jsonb ELSE to_jsonb(string_to_array(r.guards_run, ',')) END,
    'counters',jsonb_build_object('slots',r.slots,'modelCalls',r.model_calls,'inputUnits',r.input_units,'generatedUnits',r.generated_units,'usageState',r.usage_state)));
END $$;

-- Operator purge: deletes receipts past their retention for one organization, or for all when the argument is NULL. Executable by no login; the migrator runs it through
-- SET ROLE telesphoros_jobs. It does not depend on a capability, so a suspended or offboarded organization's expired receipts can still be purged. The age floor is enforced
-- by the row trigger, not trusted to this body.
CREATE FUNCTION public.agentic_explain_receipt_purge(p_tenant text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s' SET statement_timeout = '60s' AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_tenant IS NOT NULL AND p_tenant !~ '^[A-Za-z0-9._:@-]{1,128}$' THEN
    RETURN jsonb_build_object('kind','refused','code','INVALID_INPUT');
  END IF;
  DELETE FROM public.agentic_explain_receipts WHERE (p_tenant IS NULL OR tenant_id = p_tenant) AND created_at < clock_timestamp() - interval '2190 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('kind','ok','value',jsonb_build_object('deleted',v_deleted));
END $$;

REVOKE ALL ON FUNCTION public.agentic_explain_receipt_append(jsonb), public.agentic_explain_receipt_read(text), public.agentic_explain_receipt_purge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agentic_explain_receipt_append(jsonb), public.agentic_explain_receipt_read(text) TO telesphoros_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
