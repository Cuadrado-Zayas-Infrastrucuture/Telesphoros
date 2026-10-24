-- The request ids on outbox events are traceability only: an event is relayed once, and a job already made keeps its payload (and its requestId). Dropping the column loses the
-- id of events not yet relayed and the record of which request an event came from, but no behaviour, so unlike the retry-identity rollbacks this one does not refuse.
SET LOCAL lock_timeout = '2s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_jobs;
-- The 0036 relay and the 0024 guard, as they were.
CREATE OR REPLACE FUNCTION outbox_relay(p_batch integer DEFAULT 50) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  e record;
  v_route record;
  v_count integer := 0;
BEGIN
  IF p_batch < 1 OR p_batch > 500 THEN RAISE EXCEPTION 'Batch out of range.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  FOR e IN SELECT o.id, o.tenant_id, o.event_type, o.subject_id FROM public.outbox_events o WHERE o.relayed_at IS NULL ORDER BY o.seq LIMIT p_batch FOR UPDATE SKIP LOCKED LOOP
    BEGIN
      SELECT r.job_type, r.subject_key, r.max_attempts INTO v_route FROM public.outbox_routes r WHERE r.event_type = e.event_type;
      IF NOT FOUND THEN
        UPDATE public.outbox_events SET relayed_at = now(), relay_outcome = 'no-route' WHERE id = e.id;
      ELSIF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = e.tenant_id) THEN
        UPDATE public.outbox_events SET relayed_at = now(), relay_outcome = 'no-organization' WHERE id = e.id;
      ELSE
        INSERT INTO public.jobs (tenant_id, type, payload, idempotency_key, max_attempts, requested_by)
        VALUES (e.tenant_id, v_route.job_type, jsonb_build_object(v_route.subject_key, e.subject_id::text), 'outbox-' || e.id::text, v_route.max_attempts, 'system:outbox')
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
CREATE OR REPLACE FUNCTION outbox_events_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'The outbox is append-only.' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.relayed_at IS NOT NULL THEN RAISE EXCEPTION 'A relayed event does not change.' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'An outbox event changes only by being relayed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
DROP FUNCTION outbox_append(text, uuid, text);
ALTER TABLE outbox_routes DROP COLUMN carry_request_id;
ALTER TABLE outbox_events DROP COLUMN request_id;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
