-- compat: breaking
-- A suspended organization is stopped by the database, not only by application code (schema assessment, finding 2).
-- Before: app_tenant() returned whatever organization a request was bound to. The issuer refuses a NEW capability for a suspended organization (0028), but a
-- capability minted earlier kept binding until it expired.
-- Not covered, on purpose: an organization that was never registered. In the guc and dual modes the setting can still name any string (a patient can be
-- inserted for an unregistered organization, shown on a live instance), and the test suite does so throughout. That closes with the move to capability-only
-- binding (the issuer mints only for a registered, active organization), which is a separate, planned change; rejecting unregistered names here would break
-- hundreds of specs for a state production cannot reach once that mode is on.
-- Now:
--   * app_tenant_bound() is the old logic, unchanged: the organization a request names, whatever its status.
--   * app_tenant() = app_tenant_bound() unless that organization is registered and not active, in which case NULL. Every policy and definer function that already calls
--     app_tenant() (47 policies, the ledger, queue and outbox writers) therefore fails closed for a suspended organization, with no change to their text.
--   * What must still see a suspended organization is pointed at app_tenant_bound(): the policies of tenants, tenant_memberships, invitations and
--     browser_sessions (admission has to read the row to refuse it, and a suspended organization's sessions must stay revocable), and the four functions
--     security_event_append, membership_assert_current, member_sign_out and member_admin_context (the refusal is recorded, and sign-out works).
-- A suspended organization loses database-level READ as well as write access to its clinical rows, by decision. Cost: one primary-key lookup on tenants per statement.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_capability;

CREATE FUNCTION app_tenant_bound() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_token   text := nullif(current_setting('app.capability', true), '');
  v_setting text := nullif(current_setting('app.current_tenant_id', true), '');
  v_tenant  text;
BEGIN
  IF v_token IS NULL THEN
    IF (SELECT b.mode FROM public.tenant_binding_mode b) IN ('guc', 'dual') THEN
      RETURN v_setting;
    END IF;
    RETURN NULL;
  END IF;
  IF length(v_token) > 128 THEN
    RETURN NULL;
  END IF;
  SELECT c.tenant_id INTO v_tenant FROM public.tenant_capabilities c
   WHERE c.token_hash = sha256(convert_to(v_token, 'UTF8')) AND c.expires_at > statement_timestamp() AND c.revoked_at IS NULL;
  IF v_tenant IS NULL OR (v_setting IS NOT NULL AND v_setting <> v_tenant) THEN
    RETURN NULL;
  END IF;
  RETURN v_tenant;
END
$$;
REVOKE ALL ON FUNCTION app_tenant_bound() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_tenant_bound() TO telesphoros_app, telesphoros_worker, telesphoros_ledger, telesphoros_redactor, telesphoros_jobs;

CREATE OR REPLACE FUNCTION app_tenant() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_bound text := public.app_tenant_bound();
BEGIN
  IF v_bound IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v_bound AND t.status <> 'active') THEN
    RETURN NULL;
  END IF;
  RETURN v_bound;
END
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;

-- The authority policies and functions that must keep seeing a suspended organization. Each is restated from its catalog text; the count is asserted.
DO $$
DECLARE
  r record;
  v_def text;
  n_policies int := 0;
  n_functions int := 0;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
            WHERE schemaname = 'public' AND tablename IN ('tenants', 'tenant_memberships', 'invitations', 'browser_sessions')
              AND (qual LIKE '%app_tenant()%' OR with_check LIKE '%app_tenant()%') LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I%s%s', r.policyname, r.schemaname, r.tablename,
      CASE WHEN r.qual IS NULL THEN '' ELSE ' USING (' || regexp_replace(r.qual, '(public\.)?app_tenant\(\)', 'public.app_tenant_bound()', 'g') || ')' END,
      CASE WHEN r.with_check IS NULL THEN '' ELSE ' WITH CHECK (' || regexp_replace(r.with_check, '(public\.)?app_tenant\(\)', 'public.app_tenant_bound()', 'g') || ')' END);
    n_policies := n_policies + 1;
  END LOOP;
  IF n_policies <> 7 THEN
    RAISE EXCEPTION 'Migration 0047 expected to repoint 7 authority policies and found %', n_policies;
  END IF;

  FOR r IN SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('security_event_append', 'membership_assert_current', 'member_sign_out', 'member_admin_context') LOOP
    v_def := pg_get_functiondef(r.oid);
    IF position('public.app_tenant()' IN v_def) = 0 THEN
      RAISE EXCEPTION 'Migration 0047: function % does not call public.app_tenant() as expected', r.oid::regprocedure;
    END IF;
    EXECUTE replace(v_def, 'public.app_tenant()', 'public.app_tenant_bound()');
    n_functions := n_functions + 1;
  END LOOP;
  IF n_functions <> 4 THEN
    RAISE EXCEPTION 'Migration 0047 expected to repoint 4 functions and found %', n_functions;
  END IF;
END
$$;
