-- compat: breaking
-- Audit finding A2: a write refused for its role left no access-audit row. RolesGuard runs before the interceptor that records an accepted write, and it recorded only a
-- refused GET, so privilege probing on a write route left no trace. The guard now records `private-write` `refused` with the route and the opaque id in the path (never a body,
-- a field or a value), and this widens the CHECK from 0037 to allow it; without it the row is refused and the request answers 503 instead of 403.
-- Added NOT VALID so that no request waits on a scan of the table (every request writes to it); migration 0053 validates it without blocking writers. Labelled breaking only
-- because the lint treats any DROP as such: nothing an older image does is refused.
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE telesphoros_ledger;
ALTER TABLE security_audit_events DROP CONSTRAINT security_audit_kind;
ALTER TABLE security_audit_events ADD CONSTRAINT security_audit_kind CHECK (
  (event_type = 'api-auth' AND outcome IN ('accepted','refused') AND subject_id IS NULL) OR
  (event_type IN ('private-read','download-link') AND outcome IN ('succeeded','refused')) OR
  (event_type = 'private-write' AND outcome IN ('accepted','refused'))) NOT VALID;
RESET ROLE;
