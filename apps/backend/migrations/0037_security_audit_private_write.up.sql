-- compat: breaking
-- Audit item 46: a write to private data leaves no access-audit row of its own. Every request already records `api-auth` `accepted`, but that row cannot carry the id of what
-- the request touches (its CHECK requires subject_id IS NULL), and the access-audit interceptor skipped everything but GET. This adds one event type, `private-write`, recorded
-- BEFORE the write runs (so a write that cannot be recorded does not happen) with the route and the opaque id in the path, never a body, a field or a value.
-- The change is widening one CHECK, which means dropping it and adding the new one. It is added NOT VALID so that no request waits on a scan of the table (every request writes to
-- it); migration 0038 validates it without blocking writers. Labelled breaking only because the lint treats any DROP as such: nothing an older image does is refused.
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE telesphoros_ledger;
ALTER TABLE security_audit_events DROP CONSTRAINT security_audit_kind;
ALTER TABLE security_audit_events ADD CONSTRAINT security_audit_kind CHECK (
  (event_type = 'api-auth' AND outcome IN ('accepted','refused') AND subject_id IS NULL) OR
  (event_type IN ('private-read','download-link') AND outcome IN ('succeeded','refused')) OR
  (event_type = 'private-write' AND outcome = 'accepted')) NOT VALID;
RESET ROLE;
