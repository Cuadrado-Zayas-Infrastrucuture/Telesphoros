-- Authorized rollback only: this removes session custody, requiring affected browsers to sign in again.
SET LOCAL lock_timeout = '2s';
DROP TABLE browser_sessions;
DROP FUNCTION browser_sessions_guard();
DROP FUNCTION browser_sessions_expired_only();
