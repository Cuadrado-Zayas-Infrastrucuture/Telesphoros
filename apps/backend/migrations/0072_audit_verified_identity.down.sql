-- The rows are append-only evidence. Without the explicit setting this refuses while any row holds a verified identity; with it the two columns go,
-- and the writer is restored to the 0016 definition (same owner, same grants, which CREATE OR REPLACE keeps). The check runs as the table's owner:
-- the migrator login cannot read the table.
SET LOCAL lock_timeout = '2s';
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked below)
SET LOCAL ROLE telesphoros_ledger;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.security_audit_events WHERE verified_tenant_id IS NOT NULL OR verified_actor_sub IS NOT NULL)
     AND coalesce(current_setting('telesphoros.allow_audit_drop', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop verified access-audit identity while rows hold it: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION security_audit_record(p_type text, p_outcome text, p_tenant text, p_actor text,
                                                 p_route text, p_subject uuid, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.security_audit_events (event_type, outcome, tenant_id, actor_sub, route_key, subject_id, request_id)
  VALUES (p_type, p_outcome, p_tenant, p_actor, p_route, p_subject, p_request_id);
END $$;
ALTER TABLE security_audit_events DROP COLUMN verified_tenant_id, DROP COLUMN verified_actor_sub;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
SET LOCAL ROLE telesphoros_capability;
DROP FUNCTION security_audit_capability();
RESET ROLE;
