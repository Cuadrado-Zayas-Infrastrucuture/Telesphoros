-- Spec 046 down: the two review functions go; the access audit and its rows are untouched (this migration never changed them), so there is
-- nothing to refuse. The review function is dropped as its owner, the ledger role, as 0072's down drops its functions.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE telesphoros_ledger;
DROP FUNCTION public.security_audit_review(text, uuid[], timestamptz, timestamptz, integer, integer);
RESET ROLE;
DROP FUNCTION public.access_review_admin_current(text, text);
