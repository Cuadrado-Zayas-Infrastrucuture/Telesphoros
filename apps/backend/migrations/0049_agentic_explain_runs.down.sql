-- Drops the explanation runs (0049). A drop cannot be undone, so it refuses to run while the table holds a row.
-- Like 0029 and 0048, it runs as the NOLOGIN owner telesphoros_jobs, whose policy (USING true) shows it every row although the table is FORCE ROW LEVEL SECURITY, so the count
-- below sees what the table holds when the migrating login (no superuser, no BYPASSRLS) runs it. Dropping needs ownership, not CREATE on the schema.
-- Note: DROP TABLE fires no row trigger, so the setting below is the only thing that protects the retention floor against the migrator.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE telesphoros_jobs;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agentic_explain_runs)
     AND current_setting('telesphoros.allow_runs_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop agentic_explain_runs: it holds rows. Set telesphoros.allow_runs_drop=yes for this session if you really mean to lose them.';
  END IF;
END $$;

DROP FUNCTION public.agentic_explain_run_admit(text, text, text, bigint);
DROP FUNCTION public.agentic_explain_run_get(uuid);
DROP FUNCTION public.agentic_explain_run_advance(uuid, jsonb, text);
DROP FUNCTION public.agentic_explain_run_cancel(uuid);
DROP FUNCTION public.agentic_explain_run_sweep();
DROP FUNCTION public.agentic_explain_run_purge(text);
-- The row-shaped helper depends on the table's type, so it goes first.
DROP FUNCTION public.agentic_explain_run_json(public.agentic_explain_runs);
DROP TABLE public.agentic_explain_runs;
DROP FUNCTION public.agentic_explain_run_guard();
DROP FUNCTION public.agentic_explain_transition_ok(text, text);

RESET ROLE;
