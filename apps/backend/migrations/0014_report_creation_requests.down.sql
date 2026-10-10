-- Report rows survive, but a populated rollback loses retry protection. Require explicit operator intent.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM reports WHERE creation_request_id IS NOT NULL)
     AND current_setting('telesphoros.allow_report_retry_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop populated report creation retry identities: set telesphoros.allow_report_retry_drop=yes only after reviewing the loss of retry protection.';
  END IF;
END $$;
DROP TRIGGER reports_creation_request_guard ON reports;
DROP FUNCTION reports_creation_request_guard();
ALTER TABLE reports
  DROP CONSTRAINT reports_creation_request_uq,
  DROP CONSTRAINT reports_creation_request_pair,
  DROP COLUMN creation_request_id,
  DROP COLUMN creation_request_hash;
