-- Restores 0045's app_tenant() (any bound organization, active or not) and points the authority policies and functions back at it. No data is touched.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  r record;
  v_def text;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
            WHERE schemaname = 'public' AND (qual LIKE '%app_tenant_bound()%' OR with_check LIKE '%app_tenant_bound()%') LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I%s%s', r.policyname, r.schemaname, r.tablename,
      CASE WHEN r.qual IS NULL THEN '' ELSE ' USING (' || regexp_replace(r.qual, '(public\.)?app_tenant_bound\(\)', 'public.app_tenant()', 'g') || ')' END,
      CASE WHEN r.with_check IS NULL THEN '' ELSE ' WITH CHECK (' || regexp_replace(r.with_check, '(public\.)?app_tenant_bound\(\)', 'public.app_tenant()', 'g') || ')' END);
  END LOOP;
  FOR r IN SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('security_event_append', 'membership_assert_current', 'member_sign_out', 'member_admin_context') LOOP
    v_def := pg_get_functiondef(r.oid);
    EXECUTE replace(v_def, 'public.app_tenant_bound()', 'public.app_tenant()');
  END LOOP;
END
$$;

GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration reverts (revoked at its end); replacing a function needs it too
SET LOCAL ROLE telesphoros_capability;
CREATE OR REPLACE FUNCTION app_tenant() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
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
DROP FUNCTION app_tenant_bound();
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;
