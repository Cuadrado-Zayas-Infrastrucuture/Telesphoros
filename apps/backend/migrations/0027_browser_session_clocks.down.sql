-- Authorized rollback only. Restoring the old rule refuses incompatible retained rows;
-- the migration transaction rolls back without altering them. Allow ordinary expired
-- cleanup to remove those rows before retrying; never rewrite their revocation times.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_revoked_at_bound;
ALTER TABLE browser_sessions ADD CONSTRAINT browser_sessions_revoked_at_bound
  CHECK (revoked_at IS NULL OR revoked_at >= created_at);
