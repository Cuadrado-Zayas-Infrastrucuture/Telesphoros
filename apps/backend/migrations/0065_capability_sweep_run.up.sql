-- compat: expand
-- Spec 026 (specs/026-capability-sweep, founder 2026-10-31, D1 to D5 as recommended): expired capabilities are removed on a schedule.
--
--   * tenant_capabilities_sweep (0028) removes capabilities that expired more than five minutes ago, but nothing called it, while every internal binding
--     (0032: job_held, uploads_sweep, the ledger-verifier paths and redaction) mints a 60-second row. capabilities_sweep_run(p_limit) is the worker's way
--     to call it: the worker runs it on its own timer, separate from job_schedule_tick (D1), because the sweep belongs to no organization.
--   * It returns how many rows were removed and whether a full batch was, which means more may be waiting. It does not count what is left: its owner,
--     the queue's definer role, can run the sweep but cannot read the capability table, and this migration gives it nothing more.
--   * Owned by telesphoros_jobs, the only role allowed to run the sweep (0028); only the worker login may execute it. A batch outside 1 to 10000 is
--     refused. The sweep itself, its five-minute retention (which spec 015's grace depends on) and every other function are unchanged.
-- Additive only: one function.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_jobs;

CREATE FUNCTION capabilities_sweep_run(p_limit integer) RETURNS TABLE (removed integer, behind boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'The batch must be between 1 and 10000.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_removed := public.tenant_capabilities_sweep(p_limit);
  RETURN QUERY SELECT v_removed, v_removed >= p_limit;
END
$$;
REVOKE ALL ON FUNCTION capabilities_sweep_run(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION capabilities_sweep_run(integer) TO telesphoros_worker;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
