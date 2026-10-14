GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_jobs;
CREATE OR REPLACE FUNCTION job_stats() RETURNS TABLE (type text, state text, n bigint, oldest_ready_seconds double precision)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
  SELECT j.type, j.state, count(*),
         max(CASE WHEN j.state IN ('queued', 'retry') AND j.run_after <= now() THEN extract(epoch FROM now() - j.run_after) END)::double precision
    FROM public.jobs j GROUP BY j.type, j.state
$$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
