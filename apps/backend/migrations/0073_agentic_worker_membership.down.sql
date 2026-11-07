-- Restores the 0029 body of agentic_synthetic_member_current verbatim and drops membership_current_in. Nothing is guarded: it changes no data.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs;
SET LOCAL ROLE telesphoros_jobs;
CREATE OR REPLACE FUNCTION public.agentic_synthetic_member_current(p_tenant text, p_sub text, p_version bigint) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_old text := current_setting('app.current_tenant_id', true);
  v_ok boolean;
BEGIN
  PERFORM set_config('app.current_tenant_id', p_tenant, true);
  v_ok := public.membership_assert_current(p_sub, p_version);
  PERFORM set_config('app.current_tenant_id', coalesce(v_old, ''), true);
  RETURN coalesce(v_ok, false);
END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
DROP FUNCTION public.membership_current_in(text, text, bigint);
