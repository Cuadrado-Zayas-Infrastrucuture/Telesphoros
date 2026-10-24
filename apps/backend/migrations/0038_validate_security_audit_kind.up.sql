-- compat: expand
-- Validates the CHECK that 0037 added NOT VALID. VALIDATE takes a lock that does not block writers, so the scan runs while requests keep recording their audit rows.
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE telesphoros_ledger;
ALTER TABLE security_audit_events VALIDATE CONSTRAINT security_audit_kind;
RESET ROLE;
