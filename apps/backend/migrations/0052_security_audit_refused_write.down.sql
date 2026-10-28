-- The rows are append-only, so a refused private-write row cannot be removed to make 0037's CHECK true. Without the explicit setting this refuses while any exists; with it
-- 0037's CHECK goes back NOT VALID (it is enforced for new rows and the existing refused rows stay, as evidence).
SET LOCAL lock_timeout = '2s';
SET LOCAL ROLE telesphoros_ledger;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.security_audit_events WHERE event_type = 'private-write' AND outcome = 'refused')
     AND coalesce(current_setting('telesphoros.allow_audit_drop', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing to narrow the access-audit CHECK while refused private-write evidence exists: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END
$$;
ALTER TABLE security_audit_events DROP CONSTRAINT security_audit_kind;
ALTER TABLE security_audit_events ADD CONSTRAINT security_audit_kind CHECK (
  (event_type = 'api-auth' AND outcome IN ('accepted','refused') AND subject_id IS NULL) OR
  (event_type IN ('private-read','download-link') AND outcome IN ('succeeded','refused')) OR
  (event_type = 'private-write' AND outcome = 'accepted')) NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.security_audit_events WHERE event_type = 'private-write' AND outcome = 'refused') THEN
    ALTER TABLE public.security_audit_events VALIDATE CONSTRAINT security_audit_kind;
  END IF;
END
$$;
RESET ROLE;
