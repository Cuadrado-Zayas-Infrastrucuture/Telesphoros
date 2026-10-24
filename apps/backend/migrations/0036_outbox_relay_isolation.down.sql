-- Puts back the 0024 body: one failing event raises out of the function and halts the relay, and drops outbox_stats(). Changes no data.
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
  END LOOP;
  RETURN v_count;
END
$$;
DROP FUNCTION outbox_stats();
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
