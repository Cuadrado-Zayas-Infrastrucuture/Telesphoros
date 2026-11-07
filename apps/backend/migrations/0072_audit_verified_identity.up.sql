-- compat: breaking
-- DATA-01 slice 4 (specs/001-tenant-capability, T028; decision D6): the access-audit row records who the database verified, beside who the caller said.
--
--   * security_audit_events gains verified_tenant_id and verified_actor_sub. The existing tenant_id and actor_sub keep what the API passes and are, from
--     here on, the claimed identity: their constraints, index and readers are unchanged.
--   * security_audit_capability() is the writer's own lookup, owned by telesphoros_capability like app_tenant(). It answers the organization and person of
--     the capability in app.capability, only while that capability is current and not revoked, and nothing otherwise. Unlike app_tenant() it never falls
--     back to the settings in the guc or dual modes, so a forged setting is never recorded as verified, and like app_tenant_bound() it checks no
--     organization status, so a suspended organization's requests are still attributed. Only telesphoros_ledger, the writer's owner, may call it.
--   * security_audit_record keeps its signature and its callers; it now fills the two verified columns from that lookup. A row with no capability, or an
--     expired or revoked one, is still written, with NULL verified fields (D6).
-- Labelled breaking because the writer is redefined. An older image calls the same signature and keeps working; its rows have no verified identity.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

SET LOCAL ROLE telesphoros_ledger;
ALTER TABLE security_audit_events ADD COLUMN verified_tenant_id text, ADD COLUMN verified_actor_sub text;
RESET ROLE;

GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration runs (revoked below)
SET LOCAL ROLE telesphoros_capability;
CREATE FUNCTION security_audit_capability(OUT tenant_id text, OUT sub text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_token text := nullif(current_setting('app.capability', true), '');
BEGIN
  IF v_token IS NULL OR length(v_token) > 128 THEN
    RETURN;
  END IF;
  SELECT c.tenant_id, c.sub INTO tenant_id, sub FROM public.tenant_capabilities c
   WHERE c.token_hash = sha256(convert_to(v_token, 'UTF8')) AND c.expires_at > statement_timestamp() AND c.revoked_at IS NULL;
END
$$;
REVOKE ALL ON FUNCTION security_audit_capability() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security_audit_capability() TO telesphoros_ledger;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked below), as in 0016
SET LOCAL ROLE telesphoros_ledger;
CREATE OR REPLACE FUNCTION security_audit_record(p_type text, p_outcome text, p_tenant text, p_actor text,
                                                 p_route text, p_subject uuid, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant text;
  v_actor  text;
BEGIN
  -- DATA-01 slice 4: verified from the capability alone; p_tenant and p_actor are stored as the caller's claim.
  SELECT b.tenant_id, b.sub INTO v_tenant, v_actor FROM public.security_audit_capability() b;
  INSERT INTO public.security_audit_events (event_type, outcome, tenant_id, actor_sub, route_key, subject_id, request_id, verified_tenant_id, verified_actor_sub)
  VALUES (p_type, p_outcome, p_tenant, p_actor, p_route, p_subject, p_request_id, v_tenant, v_actor);
END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
