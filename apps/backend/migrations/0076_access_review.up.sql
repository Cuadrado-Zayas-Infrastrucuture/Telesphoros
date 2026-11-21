-- compat: expand
-- Spec 046 (audit decision #2, option a): an organisation administrator's review of the application access audit (security_audit_events, 0016,
-- widened by 0037, 0052 and 0072). No table changes: the audit keeps its writer, its grants (only the ledger verifier reads it) and its
-- fail-closed read path. This adds two functions and nothing else, so an older image is unaffected (expand).
--
--   * access_review_admin_current(tenant, sub): is this person a current administrator of this active organisation? Owned by the migrator, which
--     owns tenants and tenant_memberships (row-level security not forced), as membership_current_in (0073) is. Only the ledger role may call it.
--   * security_audit_review(...): owned by the audit table's owner, telesphoros_ledger. It takes the organisation and the caller from the
--     transaction (app_tenant(), app_actor()), never from its arguments, refuses anyone but a current administrator, and returns only that
--     organisation's private-read and download-link rows, newest first, at most 201 per call. The application role may call it; it still cannot
--     read the table itself. Patients are resolved by the API, under its own row-level security, so the ledger role reads no other table.
--
-- Working number: the local follow-up closure branch (spec 045) also holds 0076; whichever merges later renumbers (versions are contiguous,
-- apps/backend/src/db/migrator.ts:81).
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.access_review_admin_current(p_tenant text, p_sub text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_tenant IS NULL OR p_tenant = '' OR p_sub IS NULL OR p_sub = '' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant AND t.status = 'active')
     AND EXISTS (SELECT 1 FROM public.tenant_memberships m
                  WHERE m.tenant_id = p_tenant AND m.sub = p_sub AND m.status = 'active' AND 'admin' = ANY (m.roles));
END $$;
REVOKE ALL ON FUNCTION public.access_review_admin_current(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.access_review_admin_current(text, text) TO telesphoros_ledger;

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked below), as in 0016
SET LOCAL ROLE telesphoros_ledger;
CREATE FUNCTION public.security_audit_review(p_actor text, p_subjects uuid[], p_from timestamptz, p_to timestamptz, p_limit integer, p_offset integer)
RETURNS TABLE (event_type text, outcome text, actor_sub text, route_key text, subject_id uuid, occurred_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tenant text := public.app_tenant();
  v_actor text := public.app_actor();
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL OR NOT public.access_review_admin_current(v_tenant, v_actor) THEN
    RAISE EXCEPTION 'Only a current administrator of the organization may review access.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'An access review needs a window whose start comes before its end.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT e.event_type, e.outcome, e.actor_sub, e.route_key, e.subject_id, e.occurred_at
      FROM public.security_audit_events e
     WHERE e.tenant_id = v_tenant
       AND e.event_type IN ('private-read', 'download-link')
       AND (p_actor IS NULL OR e.actor_sub = p_actor)
       AND (p_subjects IS NULL OR e.subject_id = ANY (p_subjects))
       AND e.occurred_at >= p_from AND e.occurred_at < p_to
     ORDER BY e.occurred_at DESC, e.id
     LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 201)
    OFFSET GREATEST(coalesce(p_offset, 0), 0);
END $$;
REVOKE ALL ON FUNCTION public.security_audit_review(text, uuid[], timestamptz, timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.security_audit_review(text, uuid[], timestamptz, timestamptz, integer, integer) TO telesphoros_app;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
