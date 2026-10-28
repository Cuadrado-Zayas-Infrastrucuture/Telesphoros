SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- A cancellation is part of a request's durable history: refuse rather than discard one. The migrator owns the table but cannot see through FORCE RLS; lift
-- FORCE only inside this transaction, as 0050's and 0051's downs do. A refusal rolls it all back.
SET LOCAL row_security = off;
LOCK TABLE evaluation_request_cancellations IN ACCESS EXCLUSIVE MODE;
ALTER TABLE evaluation_request_cancellations NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evaluation_request_cancellations) THEN
    RAISE EXCEPTION 'Durable evaluation work must be preserved; rollback refused.';
  END IF;
END $$;
ALTER TABLE evaluation_request_cancellations FORCE ROW LEVEL SECURITY;
DROP TABLE evaluation_request_cancellations;
DROP FUNCTION evaluation_cancellation_check();
SET LOCAL ROLE telesphoros_jobs;
DROP FUNCTION public.evaluation_job_cancel(uuid,uuid);
RESET ROLE;
