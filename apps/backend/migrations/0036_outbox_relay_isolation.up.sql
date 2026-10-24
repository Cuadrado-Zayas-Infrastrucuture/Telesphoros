-- compat: breaking
-- Audit finding (production-readiness audit 2026-10-23, item 44): one event the relay cannot turn into a job halts the relay for every organization. outbox_relay
-- ran its whole loop in one block with no error handling, so a failure while making the job for ONE event (a constraint or trigger on jobs refusing it, a value
-- that does not fit) raised out of the function, rolled back the batch, and the next call picked the same earliest event again, for ever. Events of every other
-- organization queued behind it and no job was made.
--
-- Now each event is handled in its own sub-block. If it fails, only that event's changes are undone, a WARNING names the event (its id and the SQLSTATE, never the
-- message, which could quote data) and the loop goes on. The event is NOT marked relayed and NOT given a new outcome: it stays pending, so a failure that was
-- transient is retried on the next call, and one that is not is visible as the oldest pending event. Timeouts and cancellations are not caught (WHEN OTHERS does not
-- catch query_canceled), so a statement that runs too long still ends the call.
--
-- Limits: an event that keeps failing is retried on every call and, if as many of them sit at the head as the batch size, still crowds the rest out; nothing counts
-- or alarms on pending events yet (the queue statistics count jobs, not events). Both are recorded in docs/ops/jobs.md.
--
-- Because a failing event is now quiet (the call returns, so the worker logs no failure for it), the same migration adds outbox_stats(): how many events are pending
-- and how long the oldest has waited, cross-tenant like job_stats() (the worker's login cannot read the table itself). The worker puts both on its queue-stats line
-- and an alarm reads the age. A new function, granted to the worker's role and nobody else.
--
-- One function body replaced (outbox_relay): same signature, owner and grants. CREATE OR REPLACE makes this `breaking` under the migration lint: an older image keeps running but
-- would relay with the old behaviour until it is replaced. Nothing is deployed yet.
SET LOCAL lock_timeout = '2s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_jobs;
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
CREATE FUNCTION outbox_stats() RETURNS TABLE (pending bigint, oldest_pending_seconds double precision)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
  SELECT count(*), max(extract(epoch FROM now() - o.occurred_at))::double precision FROM public.outbox_events o WHERE o.relayed_at IS NULL
$$;
REVOKE ALL ON FUNCTION outbox_stats() FROM PUBLIC; -- as the owner: the migrator cannot revoke what telesphoros_jobs holds
GRANT EXECUTE ON FUNCTION outbox_stats() TO telesphoros_worker;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
