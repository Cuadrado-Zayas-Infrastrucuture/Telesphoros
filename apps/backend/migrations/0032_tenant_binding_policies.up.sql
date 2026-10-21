-- compat: breaking
-- DATA-01 slice 3 PR B (specs/001-tenant-capability, plan 3.2): the tenant binding policies read the capability through app_tenant().
--
--   * All 48 policies that compared a row's tenant with the app.current_tenant_id setting now read (SELECT public.app_tenant()) instead, for every
--     role and PUBLIC, keeping each policy's roles and command. A request that presents a capability sees its own organization, and a foreign
--     setting reads zero rows (fails closed). Without a capability, app_tenant() returns the setting (guc and dual), so the same statements behave
--     as before until the mode moves on.
--   * The definer functions and triggers that read the setting read app_tenant() / app_actor() (class a). membership_assert_current also checks the
--     person and version against the capability when one is presented (FR-007), using app_capability_version() from 0031.
--   * tenant_capability_bind_internal (FR-015) is the only way a class (b) function binds to a tenant of its own: ledger_record_checkpoint (both
--     overloads), job_held, uploads_sweep and redact_event_note. It writes a database-generated capability row (purpose 'internal') and sets
--     app.capability for the rest of the transaction; each of those functions puts the previous value back before it returns.
--   * The mode moves from 'guc' to 'dual' as the last statement. Nothing reads 'capability' yet (slice 5).
--
-- Breaking, not expand: ALTER POLICY and CREATE OR REPLACE change behaviour that older code calls. Preconditions and postconditions are asserted
-- in this file; a catalog that differs from the one it was written against stops the migration before any change. The down file restores the
-- previous policies and function bodies verbatim and drops the internal binding.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- 1. Preconditions: the catalog this file was written against (48 tenant-setting policies, mode 'guc', the accessors from 0028 and 0031).
SET LOCAL ROLE telesphoros_capability;
DO $pre$
DECLARE
  v_policies integer;
  v_mode text;
BEGIN
  SELECT count(*) INTO v_policies FROM pg_policies WHERE schemaname = 'public' AND (qual LIKE '%app.current_tenant_id%' OR with_check LIKE '%app.current_tenant_id%');
  IF v_policies <> 48 THEN
    RAISE EXCEPTION 'Migration 0032 was written for 48 tenant-setting policies; this catalog has %. Nothing was changed.', v_policies USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT b.mode INTO v_mode FROM public.tenant_binding_mode b;
  IF v_mode IS DISTINCT FROM 'guc' THEN
    RAISE EXCEPTION 'Migration 0032 starts from mode guc; this database is in %. Nothing was changed.', v_mode USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF to_regprocedure('public.app_tenant()') IS NULL OR to_regprocedure('public.app_actor()') IS NULL OR to_regprocedure('public.app_capability_version()') IS NULL THEN
    RAISE EXCEPTION 'Migration 0032 needs app_tenant(), app_actor() and app_capability_version(). Nothing was changed.' USING ERRCODE = 'undefined_function';
  END IF;
END
$pre$;
RESET ROLE;

-- 2. The 48 policies. Each is restated from its catalog text, with the setting replaced by app_tenant(), and applied as the table's own owner:
--    the migrator does not own every table (0024 gives file_verifications, the jobs tables and the ledger tables to their least-privilege roles).
--    The count is asserted before and after, so a catalog that differs from the one this file was written against changes nothing.
DO $policies$
DECLARE
  r record;
  v_owner text;
  v_using text;
  v_check text;
  v_changed integer := 0;
BEGIN
  FOR r IN SELECT p.tablename, p.policyname, p.qual, p.with_check FROM pg_policies p
            WHERE p.schemaname = 'public' AND (p.qual LIKE '%app.current_tenant_id%' OR p.with_check LIKE '%app.current_tenant_id%')
            ORDER BY p.tablename, p.policyname
  LOOP
    v_using := replace(r.qual, 'current_setting(''app.current_tenant_id''::text, true)', '(SELECT public.app_tenant())');
    v_check := replace(r.with_check, 'current_setting(''app.current_tenant_id''::text, true)', '(SELECT public.app_tenant())');
    SELECT pg_get_userbyid(c.relowner) INTO v_owner FROM pg_class c WHERE c.oid = format('public.%I', r.tablename)::regclass;
    IF v_owner IS DISTINCT FROM current_user THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    END IF;
    EXECUTE format('ALTER POLICY %I ON public.%I%s%s', r.policyname, r.tablename,
      CASE WHEN v_using IS NULL THEN '' ELSE format(' USING (%s)', v_using) END,
      CASE WHEN v_check IS NULL THEN '' ELSE format(' WITH CHECK (%s)', v_check) END);
    IF v_owner IS DISTINCT FROM current_user THEN
      RESET ROLE;
    END IF;
    v_changed := v_changed + 1;
  END LOOP;
  IF v_changed <> 48 THEN
    RAISE EXCEPTION 'Migration 0032 changed % policies, expected 48. Nothing was committed.', v_changed USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$policies$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Class (a): definer functions and triggers read the capability through app_tenant() / app_actor(), not the raw settings.
--    Same signatures, owners and grants (CREATE OR REPLACE keeps them). Without a capability these return the settings as before (dual).
-- ---------------------------------------------------------------------------------------------------------------------------------
-- The owner roles below replace functions in public, which needs CREATE on the schema while they run (0028, 0031 pattern): granted here, revoked before the postconditions.
GRANT CREATE ON SCHEMA public TO telesphoros_jobs, telesphoros_ledger, telesphoros_redactor;
SET LOCAL ROLE telesphoros_jobs;
CREATE OR REPLACE FUNCTION public.job_enqueue(p_type text, p_payload jsonb, p_key text, p_run_after timestamp with time zone DEFAULT now(), p_max_attempts integer DEFAULT 5)
 RETURNS TABLE(job_id uuid, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant text := public.app_tenant();
  v_actor  text := public.app_actor();
  v_id uuid;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'A job needs an organization and a person bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.jobs (tenant_id, type, payload, idempotency_key, run_after, max_attempts, requested_by)
  VALUES (v_tenant, p_type, coalesce(p_payload, '{}'::jsonb), p_key, coalesce(p_run_after, now()), p_max_attempts, v_actor)
  ON CONFLICT (tenant_id, type, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true;
  ELSE
    RETURN QUERY SELECT j.id, false FROM public.jobs j WHERE j.tenant_id = v_tenant AND j.type = p_type AND j.idempotency_key = p_key;
  END IF;
END
$function$;
RESET ROLE;

SET LOCAL ROLE telesphoros_ledger;
CREATE OR REPLACE FUNCTION public.ledger_append(p_event uuid, p_type text, p_table text, p_subject uuid, p_payload text, p_projection_version smallint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  t text := public.app_tenant();
BEGIN
  IF p_type IN ('redaction', 'checkpoint') THEN
    RAISE EXCEPTION 'This event type cannot be appended by the application.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- (A missing tenant is refused by ledger_append_internal, exactly as before.)
  IF t IS NOT NULL AND t <> '' THEN
    PERFORM pg_catalog.set_config('lock_timeout', '3000', true);
    INSERT INTO public.ledger_heads (tenant_id, seq, record_hash) VALUES (t, 0, pg_catalog.repeat('0', 64)) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM public.ledger_heads WHERE tenant_id = t FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.ledger_incidents i
                WHERE (i.scope = 'global' OR i.tenant_id = t)
                  AND NOT EXISTS (SELECT 1 FROM public.ledger_incident_clearances c WHERE c.incident_id = i.id)) THEN
      RAISE EXCEPTION 'Writes to the record log are stopped (an open incident).' USING ERRCODE = 'LC001';
    END IF;
  END IF;
  RETURN public.ledger_append_internal(p_event, p_type, p_table, p_subject, p_payload, p_projection_version);
END $function$;
RESET ROLE;

SET LOCAL ROLE telesphoros_ledger;
CREATE OR REPLACE FUNCTION public.ledger_append_internal(p_event uuid, p_type text, p_table text, p_subject uuid, p_payload text, p_projection_version smallint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  t  text := public.app_tenant();
  a  text := public.app_actor();
  h  record;
  s  bigint;
  rh text;
  ts timestamptz := pg_catalog.now();
BEGIN
  IF t IS NULL OR t = '' OR a IS NULL OR a = '' THEN
    RAISE EXCEPTION 'The ledger needs the tenant and actor settings.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.set_config('lock_timeout', '3000', true);
  INSERT INTO public.ledger_heads (tenant_id, seq, record_hash) VALUES (t, 0, pg_catalog.repeat('0', 64)) ON CONFLICT DO NOTHING;
  SELECT * INTO h FROM public.ledger_heads WHERE tenant_id = t FOR UPDATE;
  s := h.seq + 1;
  rh := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31),
          t, s::text, p_type, p_table, p_subject::text, a, p_payload, p_projection_version::text, '1', h.record_hash,
          pg_catalog.to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex');
  INSERT INTO public.ledger_events (id, tenant_id, seq, event_type, subject_table, subject_id, actor_sub, payload_sha256,
                                    projection_version, hash_version, prev_hash, record_hash, created_at)
       VALUES (p_event, t, s, p_type, p_table, p_subject, a, p_payload, p_projection_version, 1, h.record_hash, rh, ts);
  UPDATE public.ledger_heads SET seq = s, record_hash = rh WHERE tenant_id = t;
  RETURN s;
END $function$;
RESET ROLE;

CREATE OR REPLACE FUNCTION public.member_admin_context(OUT o_tenant text, OUT o_actor text)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  o_tenant := public.app_tenant();
  o_actor := public.app_actor();
  IF o_tenant IS NULL OR o_actor IS NULL THEN
    RAISE EXCEPTION 'member-admin-context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = o_tenant AND status = 'active') THEN
    RAISE EXCEPTION 'tenant-inactive' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenant_memberships WHERE tenant_id = o_tenant AND sub = o_actor AND status = 'active' AND 'admin' = ANY (roles)) THEN
    RAISE EXCEPTION 'not-administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One administrative change at a time per organization, so two administrators cannot demote each other past the last-administrator rule.
  PERFORM pg_advisory_xact_lock(hashtext('member-admin:' || o_tenant));
END
$function$;

-- The version check FR-007 asks for. With a capability presented, the person and the version must be the ones the capability was issued for;
-- without one (dual, the fallback) the check is the old one, on the settings.
CREATE OR REPLACE FUNCTION public.membership_assert_current(p_sub text, p_version bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant text := public.app_tenant();
BEGIN
  IF v_tenant IS NULL OR v_tenant = '' OR p_sub IS NULL OR p_version IS NULL THEN
    RETURN false;
  END IF;
  IF nullif(current_setting('app.capability', true), '') IS NOT NULL
     AND (public.app_actor() IS DISTINCT FROM p_sub OR public.app_capability_version() IS DISTINCT FROM p_version) THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.tenant_memberships
   WHERE tenant_id = v_tenant AND sub = p_sub AND status = 'active' AND version = p_version
     FOR SHARE;
  RETURN FOUND;
END
$function$;

SET LOCAL ROLE telesphoros_jobs;
CREATE OR REPLACE FUNCTION public.outbox_append(p_type text, p_subject uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_tenant text := public.app_tenant();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'An outbox event needs an organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.outbox_events (tenant_id, event_type, subject_id) VALUES (v_tenant, p_type, p_subject) ON CONFLICT (tenant_id, event_type, subject_id) DO NOTHING;
END
$function$;
RESET ROLE;

CREATE OR REPLACE FUNCTION public.patient_identifiers_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.app_actor();
BEGIN
  IF NEW.id <> OLD.id OR NEW.seq <> OLD.seq OR NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id OR NEW.system <> OLD.system
     OR NEW.value_digest <> OLD.value_digest OR NEW.key_version <> OLD.key_version OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An identifier can only be withdrawn, not edited.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (OLD.status = 'active' AND NEW.status = 'withdrawn') THEN
    RAISE EXCEPTION 'An identifier can only go from active to withdrawn, once.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_actor IS NOT NULL AND NEW.withdrawn_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'An identifier is withdrawn by the person making the request.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.security_event_append(p_event_type text, p_outcome text, p_subject_kind text, p_subject_ref text, p_details jsonb, p_request_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant text := public.app_tenant();
  v_actor  text := public.app_actor();
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'A security event needs an organization and a person bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_event_type NOT IN ('access.refused', 'intake.rejected') THEN
    RAISE EXCEPTION 'The application may not record this kind of security event.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A refused caller must not be able to flood the table: one event per person, organization, type and reason per minute.
  IF EXISTS (
       SELECT 1 FROM public.security_events e
        WHERE e.event_type = p_event_type AND e.tenant_id = v_tenant AND e.actor_ref = v_actor
          AND e.details ->> 'reason' IS NOT DISTINCT FROM p_details ->> 'reason'
          AND e.occurred_at > clock_timestamp() - interval '60 seconds') THEN
    RETURN;
  END IF;
  INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, request_id, details)
  VALUES (v_tenant, p_event_type, p_outcome, 'person', v_actor, p_subject_kind, p_subject_ref, p_request_id, coalesce(p_details, '{}'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION public.tenant_memberships_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_kind text := CASE WHEN public.app_actor() = NEW.changed_by THEN 'person' ELSE 'operator' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.granted', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub, jsonb_build_object('after', to_jsonb(NEW.roles)));
    RETURN NEW;
  END IF;
  IF OLD.status = 'removed' AND NEW.status = 'active' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.reinstated', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub, jsonb_build_object('after', to_jsonb(NEW.roles)));
  ELSIF OLD.status = 'active' AND NEW.status = 'removed' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.removed', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub, jsonb_build_object('before', to_jsonb(OLD.roles)));
  ELSE
    IF NEW.roles IS DISTINCT FROM OLD.roles THEN
      INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
      VALUES (NEW.tenant_id, 'membership.roles-changed', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub,
              jsonb_build_object('before', to_jsonb(OLD.roles), 'after', to_jsonb(NEW.roles)));
    END IF;
    IF NEW.tokens_valid_after IS DISTINCT FROM OLD.tokens_valid_after THEN
      INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
      VALUES (NEW.tenant_id, 'membership.sessions-revoked', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub, '{}'::jsonb);
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. The internal binding (FR-015). The named class (b) functions below bind to their own tenant with it, inside their own transaction,
--    and put back whatever app.capability held before they return. Nothing else may call it: EXECUTE is granted to three owner roles only.
--    The capability row is written by the database (a random token, purpose 'internal', lifetime from capability_purposes), and only its hash is stored.
-- ---------------------------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration runs (revoked below)
SET LOCAL ROLE telesphoros_capability;

CREATE FUNCTION public.tenant_capability_bind_internal(p_tenant text, p_sub text) RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_token text;
  v_lifetime integer;
BEGIN
  IF p_tenant IS NULL OR p_tenant = '' OR p_sub IS NULL OR p_sub = '' THEN
    RAISE EXCEPTION 'An internal binding needs an organization and a person.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant AND status = 'active') THEN
    RAISE EXCEPTION 'tenant-inactive' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.lifetime_seconds INTO v_lifetime FROM public.capability_purposes p WHERE p.purpose = 'internal';
  v_token := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, 'UTF8')), 'hex');
  INSERT INTO public.tenant_capabilities (token_hash, tenant_id, sub, membership_version, purpose, request_id, issued_at, expires_at)
  VALUES (pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')), p_tenant, p_sub, 0, 'internal', NULL,
          pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp() + pg_catalog.make_interval(secs => v_lifetime));
  PERFORM pg_catalog.set_config('app.capability', v_token, true);
END
$function$;
REVOKE ALL ON FUNCTION public.tenant_capability_bind_internal(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_capability_bind_internal(text, text) TO telesphoros_ledger, telesphoros_jobs, telesphoros_redactor;

INSERT INTO public.capability_purposes (purpose, lifetime_seconds, burst_limit, burst_seconds, sustained_limit, sustained_seconds, enforce_limits)
VALUES ('internal', 60, 120, 60, 3000, 3600, false);

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. Class (b): definer functions that bind to their own tenant with the internal binding and restore app.capability before returning.
-- ---------------------------------------------------------------------------------------------------------------------------------
SET LOCAL ROLE telesphoros_ledger;
CREATE OR REPLACE FUNCTION public.ledger_record_checkpoint(p_tenant text, p_up_to bigint, p_head_hash text, p_mode text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  cp uuid := gen_random_uuid();
  ev uuid := gen_random_uuid();
  v_prev text := nullif(current_setting('app.capability', true), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_events e WHERE e.tenant_id = p_tenant AND e.seq = p_up_to AND e.record_hash = p_head_hash) THEN
    RAISE EXCEPTION 'The checkpoint does not match the ledger.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM public.tenant_capability_bind_internal(p_tenant, 'ledger-verifier');
  PERFORM pg_catalog.set_config('app.current_tenant_id', p_tenant, true);
  PERFORM pg_catalog.set_config('app.current_actor', 'ledger-verifier', true);
  INSERT INTO public.ledger_checkpoints (id, tenant_id, created_by, ledger_event_id, up_to_seq, head_hash, mode)
       VALUES (cp, p_tenant, 'ledger-verifier', ev, p_up_to, p_head_hash, p_mode);
  -- Payload: sha256 of  id, tenant, up_to_seq, head_hash, mode  joined with chr(31) (the specification gives this encoding).
  PERFORM public.ledger_append_internal(ev, 'checkpoint', 'ledger_checkpoints', cp,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31), cp::text, p_tenant, p_up_to::text, p_head_hash, p_mode), 'UTF8')), 'hex'),
          1::smallint);
  PERFORM pg_catalog.set_config('app.capability', coalesce(v_prev, ''), true);
  RETURN cp;
END $function$;
RESET ROLE;

SET LOCAL ROLE telesphoros_ledger;
CREATE OR REPLACE FUNCTION public.ledger_record_checkpoint(p_tenant text, p_up_to bigint, p_head_hash text, p_mode text, p_walk_started_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  cp uuid := gen_random_uuid();
  ev uuid := gen_random_uuid();
  v_prev text := nullif(current_setting('app.capability', true), '');
BEGIN
  IF p_walk_started_at IS NULL OR p_walk_started_at > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'A checkpoint needs the start time of the walk that produced it, and that time cannot be in the future.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_events e WHERE e.tenant_id = p_tenant AND e.seq = p_up_to AND e.record_hash = p_head_hash) THEN
    RAISE EXCEPTION 'The checkpoint does not match the ledger.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM public.tenant_capability_bind_internal(p_tenant, 'ledger-verifier');
  PERFORM pg_catalog.set_config('app.current_tenant_id', p_tenant, true);
  PERFORM pg_catalog.set_config('app.current_actor', 'ledger-verifier', true);
  INSERT INTO public.ledger_checkpoints (id, tenant_id, created_by, ledger_event_id, up_to_seq, head_hash, mode, walk_started_at)
       VALUES (cp, p_tenant, 'ledger-verifier', ev, p_up_to, p_head_hash, p_mode, p_walk_started_at);
  -- The same payload as the four-argument function (0005): sha256 of  id, tenant, up_to_seq, head_hash, mode  joined with chr(31).
  PERFORM public.ledger_append_internal(ev, 'checkpoint', 'ledger_checkpoints', cp,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31), cp::text, p_tenant, p_up_to::text, p_head_hash, p_mode), 'UTF8')), 'hex'),
          1::smallint);
  PERFORM pg_catalog.set_config('app.capability', coalesce(v_prev, ''), true);
  RETURN cp;
END $function$;
RESET ROLE;

SET LOCAL ROLE telesphoros_jobs;
CREATE OR REPLACE FUNCTION public.job_held(p_job uuid, p_worker text, p_types text[])
 RETURNS TABLE(tenant_id text, job_type text, payload jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_tenant text;
  v_prev text := nullif(current_setting('app.capability', true), '');
BEGIN
  SELECT j.tenant_id INTO v_tenant FROM public.jobs j WHERE j.id = p_job AND j.state = 'running' AND j.locked_by = p_worker AND j.type = ANY (p_types);
  IF NOT FOUND THEN RAISE EXCEPTION 'The caller does not hold that job.' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.tenant_capability_bind_internal(v_tenant, p_worker);
  PERFORM set_config('app.current_tenant_id', v_tenant, true);
  PERFORM set_config('app.capability', coalesce(v_prev, ''), true);
  RETURN QUERY SELECT j.tenant_id, j.type, j.payload FROM public.jobs j WHERE j.id = p_job;
END
$function$;
RESET ROLE;

SET LOCAL ROLE telesphoros_jobs;
CREATE OR REPLACE FUNCTION public.uploads_sweep(p_tenant text, p_grace_seconds integer, p_dry boolean)
 RETURNS TABLE(released integer, released_bytes bigint, objects_kept integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_run uuid := public.uploads_organization_run_id(p_tenant);
  v_prev text := nullif(current_setting('app.capability', true), '');
  v_ids uuid[];
  v_released integer;
  v_bytes bigint;
  v_kept integer;
BEGIN
  IF p_grace_seconds < 0 OR p_grace_seconds > 604800 THEN RAISE EXCEPTION 'graceSeconds must be between 0 and 604800.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  PERFORM public.tenant_capability_bind_internal(p_tenant, 'uploads-sweep');
  PERFORM set_config('app.current_tenant_id', p_tenant, true);
  WITH abandoned AS (
    SELECT a.id, a.size_bytes, a.state, a.object_version
      FROM public.report_upload_attempts a
     WHERE a.tenant_id = p_tenant AND a.run_id = v_run AND a.state NOT IN ('committed', 'cleaned')
       AND (a.state IN ('cancelled', 'cleanup') OR a.lease_until + p_grace_seconds * interval '1 second' <= now())
       AND (a.writer IS NULL OR a.lease_until + p_grace_seconds * interval '1 second' <= now())
       AND NOT EXISTS (SELECT 1 FROM public.reports r WHERE r.tenant_id = a.tenant_id AND r.storage_key = a.storage_key AND r.uploaded_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.report_captures c WHERE c.tenant_id = a.tenant_id AND c.text_storage_key = a.storage_key)
     ORDER BY a.created_at
       FOR UPDATE
  )
  SELECT array_agg(ab.id), count(*)::integer, coalesce(sum(ab.size_bytes), 0)::bigint,
         (count(*) FILTER (WHERE ab.object_version IS NOT NULL OR ab.state IN ('stored', 'unresolved')))::integer
    INTO v_ids, v_released, v_bytes, v_kept FROM abandoned ab;
  IF NOT p_dry AND v_released > 0 THEN
    UPDATE public.report_upload_attempts SET state = 'cleaned', writer = NULL, updated_at = now() WHERE tenant_id = p_tenant AND id = ANY (v_ids);
    UPDATE public.report_upload_runs SET reserved_bytes = GREATEST(reserved_bytes - v_bytes, 0), updated_at = now() WHERE tenant_id = p_tenant AND run_id = v_run;
  END IF;
  PERFORM set_config('app.capability', coalesce(v_prev, ''), true);
  RETURN QUERY SELECT v_released, v_bytes, v_kept;
END
$function$;
RESET ROLE;

-- The operator's redaction. It reads the note under the operator's tenant setting (dual: the setting still works), then binds to the note's
-- own tenant for the ledger write and the update. The person is the one the operator bound with app.current_actor.
SET LOCAL ROLE telesphoros_redactor;
CREATE OR REPLACE FUNCTION public.redact_event_note(p_note uuid, p_event uuid, p_basis text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE n record;
  v_prev text := nullif(current_setting('app.capability', true), '');
  v_actor text := public.app_actor();
BEGIN
  SELECT * INTO n FROM public.event_notes WHERE id = p_note FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such note.' USING ERRCODE = 'no_data_found';
  END IF;
  IF n.redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This note is already redacted.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM public.tenant_capability_bind_internal(n.tenant_id, coalesce(v_actor, ''));
  PERFORM pg_catalog.set_config('app.current_tenant_id', n.tenant_id, true);
  PERFORM public.ledger_append_internal(p_event, 'redaction', 'event_notes', p_note,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_note::text || ':' || n.body_sha256 || ':' || p_basis, 'UTF8')), 'hex'), 1::smallint);
  UPDATE public.event_notes SET body = '[redacted]', redacted_at = pg_catalog.now(), redaction_basis_code = p_basis WHERE id = p_note;
  PERFORM pg_catalog.set_config('app.capability', coalesce(v_prev, ''), true);
END $function$;
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs, telesphoros_ledger, telesphoros_redactor;

-- 6. Postconditions: no policy reads the setting any more, and the 48 read the capability.
DO $post$
DECLARE
  v_left integer;
  v_now integer;
BEGIN
  SELECT count(*) INTO v_left FROM pg_policies WHERE schemaname = 'public' AND (qual LIKE '%app.current_tenant_id%' OR with_check LIKE '%app.current_tenant_id%');
  SELECT count(*) INTO v_now FROM pg_policies WHERE schemaname = 'public' AND (qual LIKE '%app_tenant()%' OR with_check LIKE '%app_tenant()%');
  IF v_left <> 0 OR v_now <> 48 THEN
    RAISE EXCEPTION 'Migration 0032 postcondition failed: % policies still read the setting, % read app_tenant().', v_left, v_now USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$post$;

-- 7. The mode. Last statement: a row only a migration changes (0028).
SET LOCAL ROLE telesphoros_capability;
UPDATE public.tenant_binding_mode SET mode = 'dual';
RESET ROLE;
