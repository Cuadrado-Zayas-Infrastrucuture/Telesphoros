-- compat: breaking
-- H3 fenced completion. An evaluation request completes only in the transaction that stores its evaluation, and only while the caller holds the request's
-- job: a worker whose lease ran out stores nothing. Adds columns, a trigger, a policy and an INSERT grant to evaluation_request_completions (0050 created it
-- with no writer, so it is empty: the NOT NULL columns below fail on any row, without needing to see through its FORCE row-level security).
-- No route, schedule, outbox route, model call or production consumer is enabled by this migration.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- Which worker completed it, under which job: the fence names both, and they stay with the receipt as evidence.
ALTER TABLE evaluation_request_completions
  ADD COLUMN job_id uuid NOT NULL,
  ADD COLUMN worker_id text NOT NULL CONSTRAINT evaluation_request_completions_worker_len CHECK (length(worker_id) BETWEEN 1 AND 128);

-- Only this narrow helper runs as the queue's owner: it reads and share-locks ONE job of the bound organization, and grants the application nothing on the
-- queue. While the lock is held the job cannot be claimed again (job_claim skips locked rows), so the lease cannot pass to another worker before COMMIT.
GRANT CREATE ON SCHEMA public TO telesphoros_jobs;
SET LOCAL ROLE telesphoros_jobs;
CREATE FUNCTION evaluation_job_fence(p_job uuid, p_worker text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE v_request uuid;
BEGIN
  SELECT (j.payload ->> 'requestId')::uuid INTO v_request FROM public.jobs j
   WHERE j.id = p_job AND j.tenant_id = public.app_tenant() AND j.type = 'evaluations.request'
     AND j.state = 'running' AND j.locked_by = p_worker AND j.lease_until >= clock_timestamp()
     FOR SHARE OF j;
  IF NOT FOUND THEN RAISE EXCEPTION 'The caller does not hold that job.' USING ERRCODE = 'EJ001'; END IF;
  RETURN v_request;
END $$;
REVOKE ALL ON FUNCTION evaluation_job_fence(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluation_job_fence(uuid,text) TO telesphoros_app;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;

-- Invoker rights: every read below is the application's own, under row-level security. A completion is accepted only for the person who asked, while they
-- may still write, from the worker holding the request's job, for an evaluation of exactly what the request named under its pinned profile.
CREATE FUNCTION evaluation_completion_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.evaluation_requests%ROWTYPE; e public.evaluations%ROWTYPE;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() THEN
    RAISE EXCEPTION 'Evaluation completion is not authorized.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM public.evaluation_requests WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF NOT FOUND OR r.job_id IS DISTINCT FROM NEW.job_id OR r.requested_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Evaluation completion is not authorized.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF public.evaluation_job_fence(NEW.job_id, NEW.worker_id) IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION 'The caller does not hold that job.' USING ERRCODE = 'EJ001';
  END IF;
  PERFORM public.evaluation_request_authorize(true);
  SELECT * INTO e FROM public.evaluations WHERE tenant_id = NEW.tenant_id AND id = NEW.evaluation_id;
  IF NOT FOUND OR e.report_id IS DISTINCT FROM r.report_id OR e.capture_id IS DISTINCT FROM r.capture_id
    OR e.capture_acceptance_id IS DISTINCT FROM r.acceptance_id OR e.patient_id::text IS DISTINCT FROM r.basis ->> 'patientId'
    OR e.binding ->> 'textSha256' IS DISTINCT FROM r.basis ->> 'textSha256'
    OR e.binding ->> 'recordingsSha256' IS DISTINCT FROM r.execution_profile ->> 'recordingsSha256'
    -- A dispute overlay changes the effective set; the pinned profile names the base set the overlay was built on.
    OR coalesce(e.binding -> 'overlay' ->> 'baseKnowledgeSetId', e.knowledge_set_id) IS DISTINCT FROM r.execution_profile ->> 'knowledgeSetId' THEN
    RAISE EXCEPTION 'The evaluation is not the one this request asked for.' USING ERRCODE = 'ER001';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION evaluation_completion_check() FROM PUBLIC;
CREATE TRIGGER evaluation_completion_check BEFORE INSERT ON evaluation_request_completions FOR EACH ROW EXECUTE FUNCTION evaluation_completion_check();

CREATE POLICY evaluation_completions_insert ON evaluation_request_completions FOR INSERT TO telesphoros_app WITH CHECK (tenant_id = (SELECT app_tenant()));
GRANT INSERT ON evaluation_request_completions TO telesphoros_app;
