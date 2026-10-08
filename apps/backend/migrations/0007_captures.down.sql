-- GUARD: removes audit records. See 0005 for how to allow it on purpose.
DO $$ BEGIN
  IF current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop capture records: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;
DROP TABLE capture_acceptances;
DROP TABLE report_captures;
DROP FUNCTION capture_acceptances_check();
DROP FUNCTION report_captures_check();
