-- GUARD: removes the job queue, including the record of every attempt. See 0005 for how to allow it on purpose.
SET LOCAL ROLE telesphoros_jobs; -- the owner can read its own tables; the migrator cannot
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM job_attempts) AND current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop recorded job attempts: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  t text;
  owner_role name;
BEGIN
  FOREACH t IN ARRAY ARRAY['capture_acceptances', 'cell_disputes', 'cell_dispute_decisions', 'corrections', 'report_patient_decisions', 'patient_merge_proposals', 'patient_merge_decisions'] LOOP
    SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = ('public.' || t)::regclass;
    EXECUTE format('SET LOCAL ROLE %I', owner_role);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_created_by_human');
    RESET ROLE;
  END LOOP;
END
$$;
ALTER TABLE patient_identifiers DROP CONSTRAINT patient_identifiers_created_by_human;
ALTER TABLE tenant_memberships DROP CONSTRAINT tenant_memberships_sub_human;

SET LOCAL ROLE telesphoros_jobs;
DROP FUNCTION job_stats();
DROP FUNCTION job_worker_seen(text);
DROP FUNCTION job_schedule_tick(timestamptz);
DROP FUNCTION job_release(uuid, text);
DROP FUNCTION job_fail(uuid, text, text, boolean);
DROP FUNCTION job_succeed(uuid, text);
DROP FUNCTION job_heartbeat(uuid, text, integer);
DROP FUNCTION job_claim(text, text[], integer, integer, integer);
DROP FUNCTION job_enqueue(text, jsonb, text, timestamptz, integer);
DROP TABLE job_workers;
DROP TABLE job_schedules;
DROP TABLE job_attempts;
DROP TABLE jobs;
RESET ROLE;
DROP POLICY tenants_jobs ON tenants;
REVOKE SELECT, REFERENCES ON tenants FROM telesphoros_jobs;
