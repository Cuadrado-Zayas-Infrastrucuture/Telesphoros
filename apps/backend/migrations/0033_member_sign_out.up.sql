-- compat: expand
-- AUTH-03 (security audit 2026-10-19): a person who signs out, or whose session is ended on purpose, must not keep using a token issued before that moment.
-- The application role may only read tenant_memberships (0017), so the cut-off is a SECURITY DEFINER function that changes the caller's own row and nothing else.
-- The caller comes from app_tenant() and app_actor() (0028), so a presented capability decides who it is, not a raw setting. Nothing is dropped or rewritten.
CREATE FUNCTION member_sign_out() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_tenant text := public.app_tenant();
  v_actor  text := public.app_actor();
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'member-admin-context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Idempotent: a person who has no active membership here has nothing to cut off, and the caller has already been admitted.
  UPDATE public.tenant_memberships
     SET tokens_valid_after = greatest(tokens_valid_after, now()), changed_by = v_actor, reason = 'signed out'
   WHERE tenant_id = v_tenant AND sub = v_actor AND status = 'active';
END
$$;
REVOKE ALL ON FUNCTION member_sign_out() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_sign_out() TO telesphoros_app;
