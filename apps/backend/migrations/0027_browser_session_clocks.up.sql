-- Creation uses the application's clock; revocation is stamped by PostgreSQL's clock.
-- Comparing their order prevents immediate revocation under accepted creation skew.
-- Keep the actual database revocation time, rather than inventing a future timestamp.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_revoked_at_bound;
ALTER TABLE browser_sessions ADD CONSTRAINT browser_sessions_revoked_at_bound
  CHECK (revoked_at IS NULL OR isfinite(revoked_at));
-- The existing trigger still stamps every terminal revocation and forbids all other updates.
-- The application cannot supply revoked_at on INSERT; no privileges or policies change.
