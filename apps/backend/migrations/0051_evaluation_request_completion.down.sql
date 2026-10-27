SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- A completion is durable clinical history: refuse rather than discard one. The migrator owns the table but cannot see through FORCE RLS; lift FORCE only
-- inside this transaction, as 0050's down does. A refusal rolls it all back.
SET LOCAL row_security = off;
LOCK TABLE evaluation_request_completions IN ACCESS EXCLUSIVE MODE;
ALTER TABLE evaluation_request_completions NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evaluation_request_completions) THEN
    RAISE EXCEPTION 'Durable evaluation work must be preserved; rollback refused.';
  END IF;
END $$;
ALTER TABLE evaluation_request_completions FORCE ROW LEVEL SECURITY;
REVOKE INSERT ON evaluation_request_completions FROM telesphoros_app;
DROP POLICY evaluation_completions_insert ON evaluation_request_completions;
DROP TRIGGER evaluation_completion_check ON evaluation_request_completions;
DROP FUNCTION evaluation_completion_check();
ALTER TABLE evaluation_request_completions DROP COLUMN worker_id, DROP COLUMN job_id;
SET LOCAL ROLE telesphoros_jobs;
DROP FUNCTION public.evaluation_job_fence(uuid,text);
RESET ROLE;
