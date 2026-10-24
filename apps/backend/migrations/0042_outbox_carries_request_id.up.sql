-- compat: breaking
-- Audit item 50: a job cannot be traced to the request that caused it. The request id is in the logs and in the security events, but not in the outbox event or the job the
-- upload commit leads to, so a stored-file check cannot be matched to the upload request. This carries it: the event gets a nullable request_id, written by the API inside the
-- commit's own transaction; the relay copies it into the job's payload (`requestId`), which the worker already accepts (stored-file check payload, merged before this).
--
--   * outbox_events.request_id: nullable text, no CHECK (a CHECK on a populated table is `breaking` for a reason this does not need): outbox_append keeps only an id of the shape
--     the jobs table accepts for a payload string (letters, digits and hyphens, 1 to 64), and stores NULL for anything else, so an id with a dot or an underscore (a caller may
--     supply the X-Request-Id header) cannot make the job insert fail and leave a poison event. The guard trigger now also refuses changing it.
--   * outbox_routes.carry_request_id: a route says whether its job's payload schema takes a requestId (a strict schema would refuse the key and dead-letter the job). Only
--     report.file-committed, whose job type accepts it, is switched on.
--   * outbox_append(text, uuid, text): the new form. The two-argument form stays for images that call it (they carry no id).
--   * outbox_relay: same signature, owner and grants; copies the id for an opted-in route.
--
-- CREATE OR REPLACE of two function bodies makes this `breaking` under the migration lint (as 0036 was): an older image keeps running but a replaced relay would hand an older
-- worker a payload key its schema refuses, so the worker with the optional requestId must be running first. It is (merged earlier); nothing is deployed yet.
SET LOCAL lock_timeout = '2s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_jobs;

ALTER TABLE outbox_events ADD COLUMN request_id text;
ALTER TABLE outbox_routes ADD COLUMN carry_request_id boolean NOT NULL DEFAULT false;
UPDATE outbox_routes SET carry_request_id = true WHERE event_type = 'report.file-committed';

CREATE OR REPLACE FUNCTION outbox_events_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'The outbox is append-only.' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.relayed_at IS NOT NULL THEN RAISE EXCEPTION 'A relayed event does not change.' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'An outbox event changes only by being relayed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION outbox_append(p_type text, p_subject uuid, p_request text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'An outbox event needs an organization bound to the transaction.' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.outbox_events (tenant_id, event_type, subject_id, request_id)
  VALUES (v_tenant, p_type, p_subject, CASE WHEN p_request ~ '^[A-Za-z0-9-]{1,64}$' THEN p_request END)
  ON CONFLICT (tenant_id, event_type, subject_id) DO NOTHING;
END
$$;
REVOKE ALL ON FUNCTION outbox_append(text, uuid, text) FROM PUBLIC; -- as the owner: the migrator cannot revoke what telesphoros_jobs holds
GRANT EXECUTE ON FUNCTION outbox_append(text, uuid, text) TO telesphoros_app;

CREATE OR REPLACE FUNCTION outbox_relay(p_batch integer DEFAULT 50) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  e record;
  v_route record;
  v_count integer := 0;
BEGIN
  IF p_batch < 1 OR p_batch > 500 THEN RAISE EXCEPTION 'Batch out of range.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  FOR e IN SELECT o.id, o.tenant_id, o.event_type, o.subject_id, o.request_id FROM public.outbox_events o WHERE o.relayed_at IS NULL ORDER BY o.seq LIMIT p_batch FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      SELECT r.job_type, r.subject_key, r.max_attempts, r.carry_request_id INTO v_route FROM public.outbox_routes r WHERE r.event_type = e.event_type;
      IF NOT FOUND THEN
        UPDATE public.outbox_events SET relayed_at = now(), relay_outcome = 'no-route' WHERE id = e.id;
      ELSIF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = e.tenant_id) THEN
        UPDATE public.outbox_events SET relayed_at = now(), relay_outcome = 'no-organization' WHERE id = e.id;
      ELSE
        INSERT INTO public.jobs (tenant_id, type, payload, idempotency_key, max_attempts, requested_by)
        VALUES (e.tenant_id, v_route.job_type,
                jsonb_build_object(v_route.subject_key, e.subject_id::text)
                  || CASE WHEN v_route.carry_request_id AND e.request_id IS NOT NULL THEN jsonb_build_object('requestId', e.request_id) ELSE '{}'::jsonb END,
                'outbox-' || e.id::text, v_route.max_attempts, 'system:outbox')
        ON CONFLICT (tenant_id, type, idempotency_key) DO NOTHING;
        UPDATE public.outbox_events SET relayed_at = now(), relay_outcome = 'relayed' WHERE id = e.id;
        v_count := v_count + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'outbox event % was not relayed (SQLSTATE %)', e.id, SQLSTATE;
    END;
  END LOOP;
  RETURN v_count;
END
$$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
