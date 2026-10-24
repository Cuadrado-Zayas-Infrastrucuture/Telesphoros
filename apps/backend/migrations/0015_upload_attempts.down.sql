SET LOCAL lock_timeout = '2s';
-- report_upload_attempts has FORCE ROW LEVEL SECURITY and every policy on it is for another role, so the migrator (its owner, but not a superuser and without BYPASSRLS)
-- sees no rows, and the check below would always read "empty". The owner may lift FORCE inside this transaction; the table is dropped below, and a refusal rolls the change back.
ALTER TABLE report_upload_attempts NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM report_upload_attempts) AND current_setting('telesphoros.allow_upload_attempt_drop',true) IS DISTINCT FROM 'yes' THEN
  RAISE EXCEPTION 'Refusing to drop populated upload attempts; explicit disposable-fixture opt-in required.';
 END IF;
END $$;
-- Explicit migration rollback on a disposable local database only; loses attempt journal/revisions.
DROP TRIGGER reports_upload_revision_guard ON reports;
DROP FUNCTION reports_upload_revision_guard();
DROP TABLE report_upload_attempts;
DROP FUNCTION upload_attempt_guard();
DROP TABLE report_upload_runs;
ALTER TABLE reports DROP COLUMN upload_revision;
