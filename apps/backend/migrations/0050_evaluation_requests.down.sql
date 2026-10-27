SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- Lock before inspecting, so admission cannot race an empty-table decision. The migrator
-- owns the new tables but cannot see through FORCE RLS; lift FORCE only inside this
-- transaction, like the existing retry-identity guards. A refusal rolls it all back.
SET LOCAL row_security = off;
LOCK TABLE evaluation_requests, evaluation_request_completions IN ACCESS EXCLUSIVE MODE;
ALTER TABLE evaluation_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE evaluation_request_completions NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evaluation_requests) OR EXISTS (SELECT 1 FROM evaluation_request_completions) THEN
    RAISE EXCEPTION 'Durable evaluation work must be preserved; rollback refused.';
  END IF;
END $$;
-- The queue belongs to its NOLOGIN owner, not the migration login. SHARE blocks an
-- enqueue while checking for unbound jobs; no runtime queue privileges are added.
SET LOCAL ROLE telesphoros_jobs;
-- Its existing owner policy sees every queued row even with FORCE RLS enabled.
SET LOCAL row_security = on;
LOCK TABLE public.jobs IN SHARE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs WHERE type = 'evaluations.request') THEN
    RAISE EXCEPTION 'Durable evaluation work must be preserved; rollback refused.';
  END IF;
END $$;
RESET ROLE;
DROP TABLE evaluation_request_completions;
DROP TABLE evaluation_requests;
DROP FUNCTION evaluation_request_check();
DROP FUNCTION evaluation_request_profile_valid(jsonb);
DROP FUNCTION evaluation_request_fingerprint(jsonb);
DROP FUNCTION evaluation_request_basis(uuid,uuid,uuid);
DROP FUNCTION evaluation_request_authorize(boolean);
SET LOCAL ROLE telesphoros_ledger;
DROP FUNCTION public.evaluation_request_lock();
RESET ROLE;
