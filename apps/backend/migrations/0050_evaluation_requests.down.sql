SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- Refuse rather than count RLS-hidden rows as empty if the operator is not a bypass role.
SET LOCAL row_security = off;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evaluation_requests) OR EXISTS (SELECT 1 FROM evaluation_request_completions)
    OR EXISTS (SELECT 1 FROM jobs WHERE type = 'evaluations.request') THEN
    RAISE EXCEPTION 'Durable evaluation work must be preserved; rollback refused.';
  END IF;
END $$;
DROP TABLE evaluation_request_completions;
DROP TABLE evaluation_requests;
DROP FUNCTION evaluation_request_check();
DROP FUNCTION evaluation_request_profile_valid(jsonb);
DROP FUNCTION evaluation_request_fingerprint(jsonb);
DROP FUNCTION evaluation_request_basis(uuid,uuid,uuid);
DROP FUNCTION evaluation_request_authorize(boolean);
DROP FUNCTION evaluation_request_lock();
