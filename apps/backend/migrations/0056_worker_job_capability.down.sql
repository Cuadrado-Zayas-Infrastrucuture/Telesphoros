SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- A job capability, issued or refused, is part of the issuance record: refuse rather than discard one. The owner role sees its own tables (RLS is
-- enabled on them, not forced). A refusal rolls it all back.
SET LOCAL ROLE telesphoros_capability;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.capability_issuance_log WHERE purpose = 'evaluation-job' OR reason IN ('job-not-held', 'role-not-allowed'))
     OR EXISTS (SELECT 1 FROM public.tenant_capabilities WHERE purpose = 'evaluation-job') THEN
    RAISE EXCEPTION 'Capability issuance records must be preserved; rollback refused.';
  END IF;
END $$;
DROP FUNCTION tenant_capability_issue_for_job(uuid, text, bytea);
DELETE FROM capability_purposes WHERE purpose = 'evaluation-job';
ALTER TABLE capability_issuance_log DROP CONSTRAINT capability_issuance_reason;
ALTER TABLE capability_issuance_log ADD CONSTRAINT capability_issuance_reason CHECK ((outcome = 'issued') = (reason IS NULL)
  AND (reason IS NULL OR reason IN ('malformed', 'unknown-purpose', 'tenant-inactive', 'membership-not-current', 'rate-limited')));
RESET ROLE;

DROP POLICY evaluation_requests_capability ON evaluation_requests;
REVOKE SELECT ON evaluation_requests FROM telesphoros_capability;

SET LOCAL ROLE telesphoros_jobs;
DROP POLICY jobs_capability ON jobs;
REVOKE SELECT ON jobs FROM telesphoros_capability;
RESET ROLE;
