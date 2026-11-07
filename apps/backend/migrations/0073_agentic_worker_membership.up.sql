-- compat: breaking
-- DATA-01 slice 5 readiness R2 (specs/001-tenant-capability, tasks.md "Slice 5 readiness"): the P2 worker side checks the requester's membership without
-- the tenant setting, so a worker step works in the capability binding mode.
--
-- Before: agentic_synthetic_member_current (0029, worker side, run by telesphoros_jobs inside the worker's definer functions) wrote app.current_tenant_id and
-- called membership_assert_current, which reads the organization through app_tenant(). With no capability (the worker has none) that is the setting in the
-- guc and dual modes and nothing in capability mode, so every worker step of a run would be refused as NOT_AUTHORIZED once the mode flips. It cannot bind
-- through tenant_capability_bind_internal instead: membership_assert_current then compares the capability's membership version, which is 0 for an internal
-- binding, with the run's.
-- Now:
--   * membership_current_in(tenant, sub, version) is row-sourced: the organization is an argument, which every caller takes from a row it has locked
--     (agentic_synthetic_authority reads it from the run). It answers whether that person is an active member at that version of an active organization,
--     and takes the same FOR SHARE row lock as membership_assert_current, so a removal still waits for the step's commit. It is owned like
--     membership_assert_current, by the migrating login, and only telesphoros_jobs may call it; no login can.
--   * agentic_synthetic_member_current calls it and no longer reads or writes any setting. Its signature, owner and grants are unchanged.
-- Labelled breaking because a function is redefined. An older image calls the same functions and keeps working.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- Precondition: the body being replaced is the one 0029 left.
DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.agentic_synthetic_member_current(text, text, bigint)'))
     IS DISTINCT FROM '7125c26a77d525ee83b855830fee0bb5' THEN
    RAISE EXCEPTION 'Migration 0073 expects the 0029 body of agentic_synthetic_member_current and found another.';
  END IF;
END
$$;

CREATE FUNCTION public.membership_current_in(p_tenant text, p_sub text, p_version bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_tenant IS NULL OR p_tenant = '' OR p_sub IS NULL OR p_version IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant AND t.status = 'active') THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.tenant_memberships
   WHERE tenant_id = p_tenant AND sub = p_sub AND status = 'active' AND version = p_version
     FOR SHARE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.membership_current_in(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.membership_current_in(text, text, bigint) TO telesphoros_jobs;

GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked below), as in 0030
SET LOCAL ROLE telesphoros_jobs;
CREATE OR REPLACE FUNCTION public.agentic_synthetic_member_current(p_tenant text, p_sub text, p_version bigint) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- DATA-01 R2: from the organization of the run, never the tenant setting, so it holds in every binding mode.
  RETURN coalesce(public.membership_current_in(p_tenant, p_sub, p_version), false);
END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
