-- GUARD: removes the record of every stored-file re-check and any outbox event not yet turned into a job. See 0005 for how to allow it on purpose.
SET LOCAL ROLE telesphoros_jobs; -- the owner can read its own tables; the migrator cannot
DO $$ BEGIN
  IF (EXISTS (SELECT 1 FROM file_verifications) OR EXISTS (SELECT 1 FROM outbox_events WHERE relayed_at IS NULL))
     AND current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop recorded file verifications or unrelayed outbox events: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;
-- Jobs the consumers created would be left with no handler; they are cancelled, never deleted.
UPDATE jobs SET state = 'cancelled', lease_until = NULL, locked_by = NULL, finished_at = now(), updated_at = now()
 WHERE type IN ('files.verify-stored', 'files.verify-stale', 'uploads.sweep') AND state IN ('queued', 'retry', 'running');
DELETE FROM job_schedules WHERE type IN ('uploads.sweep', 'files.verify-stale');
DROP FUNCTION job_uploads_sweep(uuid, text);
DROP FUNCTION uploads_sweep(text, integer, boolean);
DROP FUNCTION uploads_organization_run_id(text);
DROP FUNCTION file_verification_record(uuid, text, uuid, text, text, text);
DROP FUNCTION file_verification_stale(uuid, text, integer, integer);
DROP FUNCTION file_verification_target(uuid, text);
DROP FUNCTION job_held(uuid, text, text[]);
DROP TABLE file_verifications;
DROP FUNCTION outbox_relay(integer);
DROP FUNCTION outbox_append(text, uuid);
DROP TABLE outbox_events;
DROP FUNCTION outbox_events_guard();
DROP TABLE outbox_routes;
RESET ROLE;

DO $$
DECLARE
  t text;
  owner_role name;
BEGIN
  FOREACH t IN ARRAY ARRAY['reports', 'report_captures', 'report_upload_attempts', 'report_upload_runs'] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = ('public.' || t)::regclass;
    EXECUTE format('SET LOCAL ROLE %I', owner_role);
    IF t = 'reports' THEN
      EXECUTE 'DROP POLICY reports_jobs ON public.reports';
      EXECUTE 'REVOKE SELECT, REFERENCES ON public.reports FROM telesphoros_jobs';
    ELSIF t = 'report_captures' THEN
      EXECUTE 'DROP POLICY report_captures_jobs ON public.report_captures';
      EXECUTE 'REVOKE SELECT ON public.report_captures FROM telesphoros_jobs';
    ELSE
      EXECUTE format('REVOKE SELECT, UPDATE ON public.%I FROM telesphoros_jobs', t);
    END IF;
    RESET ROLE;
  END LOOP;
END
$$;
