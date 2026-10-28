-- compat: breaking
-- H4 slice 2 (spec 007): the person who queued an evaluation request may cancel it while no worker has started it. All objects are new; the TRUNCATE guard
-- requires the conservative breaking label under current lint. No route, schedule, outbox route, model call or production consumer is enabled here.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- Only this narrow helper runs as the queue's owner. It cancels ONE evaluation-request job of the bound organization, queued by the person acting, that has
-- not started; it grants the application nothing else on the queue. It locks the row FOR UPDATE, and job_claim skips locked rows: while a cancel holds the
-- lock a claim passes the job by and then finds it cancelled, and while a claim holds it the cancel waits and then finds it running. The lock decides, never
-- the timing. A direct call can do no more than the rule allows: cancel the caller's own job that has not started.
GRANT CREATE ON SCHEMA public TO telesphoros_jobs;
SET LOCAL ROLE telesphoros_jobs;
CREATE FUNCTION evaluation_job_cancel(p_job uuid, p_request uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE v_state text;
BEGIN
  SELECT j.state INTO v_state FROM public.jobs j
   WHERE j.id = p_job AND j.tenant_id = public.app_tenant() AND j.type = 'evaluations.request'
     AND j.payload = jsonb_build_object('requestId', p_request) AND j.requested_by = public.app_actor()
     FOR UPDATE OF j;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evaluation request cancellation is not authorized.' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF v_state NOT IN ('queued', 'retry') THEN
    RAISE EXCEPTION 'Only a request that has not started can be cancelled.' USING ERRCODE = 'EC001';
  END IF;
  UPDATE public.jobs SET state = 'cancelled', finished_at = now(), updated_at = now() WHERE id = p_job;
END $$;
REVOKE ALL ON FUNCTION evaluation_job_cancel(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluation_job_cancel(uuid,uuid) TO telesphoros_app;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;

-- Who cancelled, and when: a person-attributed, append-only record, as the request itself is (founder decision D4). The request row is never updated.
CREATE TABLE evaluation_request_cancellations (
  request_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  cancelled_by text NOT NULL CONSTRAINT evaluation_request_cancellations_by_len CHECK (length(cancelled_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (request_id, tenant_id) REFERENCES evaluation_requests(id, tenant_id) ON DELETE RESTRICT
);

-- Invoker rights: every read below is the application's own, under row-level security. A cancellation is written only by the person who queued the request,
-- while they may still write, and only together with the job's cancellation: if the job has started, the record is refused with it.
CREATE FUNCTION evaluation_cancellation_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.evaluation_requests%ROWTYPE;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM public.app_tenant() OR NEW.cancelled_by IS DISTINCT FROM public.app_actor() THEN
    RAISE EXCEPTION 'Evaluation request cancellation is not authorized.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.evaluation_request_authorize(true);
  SELECT * INTO r FROM public.evaluation_requests WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evaluation request not found.' USING ERRCODE = 'no_data_found'; END IF;
  -- The job helper refuses unless the person acting queued it; with the check above, the record names the person who queued it.
  PERFORM public.evaluation_job_cancel(r.job_id, r.id);
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION evaluation_cancellation_check() FROM PUBLIC;
CREATE TRIGGER evaluation_cancellation_check BEFORE INSERT ON evaluation_request_cancellations FOR EACH ROW EXECUTE FUNCTION evaluation_cancellation_check();
CREATE TRIGGER evaluation_cancellations_append_only BEFORE UPDATE OR DELETE ON evaluation_request_cancellations FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER evaluation_cancellations_no_truncate BEFORE TRUNCATE ON evaluation_request_cancellations FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE evaluation_request_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_request_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY evaluation_cancellations_read ON evaluation_request_cancellations FOR SELECT TO telesphoros_app USING (tenant_id = (SELECT app_tenant()));
CREATE POLICY evaluation_cancellations_insert ON evaluation_request_cancellations FOR INSERT TO telesphoros_app WITH CHECK (tenant_id = (SELECT app_tenant()));
REVOKE ALL ON evaluation_request_cancellations FROM PUBLIC;
GRANT SELECT, INSERT ON evaluation_request_cancellations TO telesphoros_app;
