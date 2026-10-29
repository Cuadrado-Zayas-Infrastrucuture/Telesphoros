-- compat: breaking
-- Spec 012 slice 1 (specs/012-worker-capability): the database issues a capability for the requester of a queued evaluation, to the worker holding its job.
--
--   * tenant_capability_issue_for_job(job, worker, token_hash) is the issuer's way in for a background worker, which has no sign-in token. It reads the
--     job and its evaluation request, requires the named worker to hold the job's lease, requires the requester to be an active clinician or reviewer
--     (plan D3), and then issues through tenant_capability_issue at the requester's current membership version, so the organization and membership
--     checks, the limits, the log row and the stored capability stay in one place. Purpose 'evaluation-job' (60 s); the job id is the request id.
--   * The issuer login has no organization binding, so the definer reads jobs and evaluation_requests as their owner's grantee: SELECT plus a
--     read-only policy for telesphoros_capability on each, as 0028 did for tenants and tenant_memberships. No login holds that role.
--   * Two refusals are new, so the issuance log's reason check gains 'job-not-held' and 'role-not-allowed'. That replaces a CHECK on an existing table,
--     which the lint counts as breaking. Older code never writes either reason, so an older image keeps working against this schema.
--   * The lease is read without a row lock (FOR SHARE would need UPDATE on jobs, which this owner must not have). A lease that ends during issuance
--     leaves a capability the worker cannot use: every completion asks for the lease again (0051, evaluation_job_fence).
-- Nothing calls this function yet: the issuer serves it in slice 2, and the worker uses it in slice 3.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

SET LOCAL ROLE telesphoros_jobs;
GRANT SELECT ON jobs TO telesphoros_capability;
CREATE POLICY jobs_capability ON jobs FOR SELECT TO telesphoros_capability USING (true);
RESET ROLE;

GRANT SELECT ON evaluation_requests TO telesphoros_capability;
CREATE POLICY evaluation_requests_capability ON evaluation_requests FOR SELECT TO telesphoros_capability USING (true);

GRANT CREATE ON SCHEMA public TO telesphoros_capability; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_capability;

ALTER TABLE capability_issuance_log DROP CONSTRAINT capability_issuance_reason;
ALTER TABLE capability_issuance_log ADD CONSTRAINT capability_issuance_reason CHECK ((outcome = 'issued') = (reason IS NULL)
  AND (reason IS NULL OR reason IN ('malformed', 'unknown-purpose', 'tenant-inactive', 'membership-not-current', 'rate-limited', 'job-not-held', 'role-not-allowed')));

-- Limits as for 'request' (counted, not enforced): a worker asks once per transaction of a job (plan D2).
INSERT INTO capability_purposes (purpose, lifetime_seconds, burst_limit, burst_seconds, sustained_limit, sustained_seconds)
VALUES ('evaluation-job', 60, 120, 60, 3000, 3600);

-- Returns the requester's organization and person with the capability, so the worker binds exactly what the capability names. A refusal is returned
-- (and logged), not raised, so the log row survives. A job that is not held is logged with the organization and person when the job exists.
CREATE FUNCTION tenant_capability_issue_for_job(p_job uuid, p_worker text, p_token_hash bytea)
RETURNS TABLE (expires_at timestamptz, refusal text, membership_version bigint, tenant_id text, sub text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_tenant   text;
  v_sub      text;
  v_held     boolean := false;
  v_version  bigint;
  v_allowed  boolean;
  v_expires  timestamptz;
  v_refusal  text;
BEGIN
  IF p_job IS NULL OR p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128 OR p_token_hash IS NULL OR length(p_token_hash) <> 32 THEN
    v_refusal := 'malformed';
  ELSE
    -- The same test as evaluation_job_fence (0051). jobs_running_shape (0023) already ties a worker and a lease to the running state; the state is
    -- named anyway so this does not depend on that constraint.
    SELECT j.tenant_id, r.requested_by, (j.state = 'running' AND j.locked_by = p_worker AND j.lease_until >= clock_timestamp())
      INTO v_tenant, v_sub, v_held
      FROM public.jobs j
      JOIN public.evaluation_requests r ON r.tenant_id = j.tenant_id AND r.job_id = j.id
     WHERE j.id = p_job AND j.type = 'evaluations.request';
    IF NOT coalesce(v_held, false) THEN
      v_refusal := 'job-not-held';
    ELSE
      SELECT m.version, m.roles && ARRAY['clinician', 'reviewer']::text[] INTO v_version, v_allowed
        FROM public.tenant_memberships m WHERE m.tenant_id = v_tenant AND m.sub = v_sub AND m.status = 'active';
      -- No active membership falls through to tenant_capability_issue at version 0, which refuses and logs it as 'membership-not-current'.
      IF FOUND AND NOT v_allowed THEN v_refusal := 'role-not-allowed'; END IF;
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    INSERT INTO public.capability_issuance_log (occurred_at, tenant_id, sub, purpose, membership_version, request_id, outcome, reason)
    VALUES (clock_timestamp(), v_tenant, v_sub, 'evaluation-job', v_version, p_job::text, 'refused', v_refusal);
    RETURN QUERY SELECT NULL::timestamptz, v_refusal, NULL::bigint, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT i.expires_at, i.refusal INTO v_expires, v_refusal
    FROM public.tenant_capability_issue(v_tenant, v_sub, coalesce(v_version, 0), 'evaluation-job', p_token_hash, p_job::text) i;
  IF v_refusal IS NOT NULL THEN
    RETURN QUERY SELECT NULL::timestamptz, v_refusal, NULL::bigint, NULL::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_expires, NULL::text, v_version, v_tenant, v_sub;
END
$$;
REVOKE ALL ON FUNCTION tenant_capability_issue_for_job(uuid, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_capability_issue_for_job(uuid, text, bytea) TO telesphoros_issuer;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_capability;
