-- Restores 0047's security_event_append (organization and person from app_tenant_bound() and app_actor()) and drops the grace check. No data is touched.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_oid oid := 'public.security_event_append(text, text, text, text, jsonb, text)'::regprocedure;
  v_def text := pg_get_functiondef(v_oid);
  v_old text := E'  v_tenant text := public.app_tenant_bound();\n  v_actor  text := public.app_actor();\nBEGIN\n';
  v_new text := E'  v_tenant text;\n  v_actor  text;\nBEGIN\n'
             || E'  -- Spec 015: from the capability, which may have expired within the grace window, never from the settings when one is set.\n'
             || E'  SELECT b.tenant_id, b.sub INTO v_tenant, v_actor FROM public.security_event_capability() b;\n';
BEGIN
  IF position(v_new IN v_def) = 0 THEN
    RAISE EXCEPTION 'Migration 0059 down: security_event_append is not the definition 0059 left';
  END IF;
  EXECUTE replace(v_def, v_new, v_old);
END
$$;

SET LOCAL ROLE telesphoros_capability;
DROP FUNCTION security_event_capability();
RESET ROLE;
