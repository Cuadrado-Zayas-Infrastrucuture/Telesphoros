-- compat: breaking
-- Spec 015 (specs/015-security-event-grace, audit A3 in capability mode): a refusal made after the request's capability expired is still recorded, as
-- the person the capability names.
--
--   * security_event_capability() is security_event_append's own capability check. It accepts a capability that is not revoked and expired no more
--     than five minutes ago, the retention of tenant_capabilities_sweep (0028), so a capability inside the window still exists to be checked. Like
--     app_tenant_bound() it checks no organization status (0047 points the event writer at the bound form so a suspended organization's refusal is
--     recorded), returns nothing when the settings name another organization, and falls back to the settings only in the guc and dual modes when no
--     capability is set. Only the owner of security_event_append may call it.
--   * security_event_append takes the organization and the person from it, in place of app_tenant_bound() and app_actor(). The function is restated
--     from its live definition, which 0047 rewrote in place, and the migration refuses to run if that definition is not the expected one.
--   * Nothing else sees the grace: app_tenant_bound(), app_actor(), every policy and every other function are unchanged.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_capability;

CREATE FUNCTION security_event_capability(OUT tenant_id text, OUT sub text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_token   text := nullif(current_setting('app.capability', true), '');
  v_setting text := nullif(current_setting('app.current_tenant_id', true), '');
  v_tenant  text;
  v_sub     text;
BEGIN
  IF v_token IS NULL THEN
    IF (SELECT b.mode FROM public.tenant_binding_mode b) IN ('guc', 'dual') THEN
      tenant_id := v_setting;
      sub := nullif(current_setting('app.current_actor', true), '');
    END IF;
    RETURN;
  END IF;
  IF length(v_token) > 128 THEN
    RETURN;
  END IF;
  -- The grace window: no longer than the sweep's retention (a guard in test/db/security-event-grace.pg-spec.ts holds the two together).
  SELECT c.tenant_id, c.sub INTO v_tenant, v_sub FROM public.tenant_capabilities c
   WHERE c.token_hash = sha256(convert_to(v_token, 'UTF8')) AND c.expires_at > statement_timestamp() - interval '5 minutes' AND c.revoked_at IS NULL;
  IF v_tenant IS NULL OR (v_setting IS NOT NULL AND v_setting <> v_tenant) THEN
    RETURN;
  END IF;
  tenant_id := v_tenant;
  sub := v_sub;
END
$$;
REVOKE ALL ON FUNCTION security_event_capability() FROM PUBLIC;
DO $$
DECLARE
  v_owner text := (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'security_event_append');
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Migration 0059: security_event_append not found';
  END IF;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.security_event_capability() TO %I', v_owner);
END
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;

DO $$
DECLARE
  v_oid oid := 'public.security_event_append(text, text, text, text, jsonb, text)'::regprocedure;
  v_def text := pg_get_functiondef(v_oid);
  v_old text := E'  v_tenant text := public.app_tenant_bound();\n  v_actor  text := public.app_actor();\nBEGIN\n';
  v_new text := E'  v_tenant text;\n  v_actor  text;\nBEGIN\n'
             || E'  -- Spec 015: from the capability, which may have expired within the grace window, never from the settings when one is set.\n'
             || E'  SELECT b.tenant_id, b.sub INTO v_tenant, v_actor FROM public.security_event_capability() b;\n';
BEGIN
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Migration 0059: security_event_append is not the definition 0047 left';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$$;
