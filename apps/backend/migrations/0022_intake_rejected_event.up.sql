-- M2.2a: the validated intake records a file it refused as a security event (`intake.rejected`): who tried and a short code for why, never the
-- file, its name, its hash or the report. The application's only way in stays security_event_append, which now allows this one more type and
-- keeps the one-per-minute throttle per person, organization, type and reason. See docs/design/plans/m2-2-durable-intake.md (DI-4).
SET LOCAL lock_timeout = '2s';

ALTER TABLE security_events DROP CONSTRAINT security_events_type_check;
ALTER TABLE security_events ADD CONSTRAINT security_events_type_check CHECK (event_type IN (
  'membership.granted', 'membership.reinstated', 'membership.roles-changed', 'membership.removed', 'membership.sessions-revoked',
  'access.refused', 'intake.rejected'));

CREATE INDEX security_events_intake_idx ON security_events (tenant_id, actor_ref, (details ->> 'reason'), occurred_at DESC) WHERE event_type = 'intake.rejected';

CREATE OR REPLACE FUNCTION security_event_append(p_event_type text, p_outcome text, p_subject_kind text, p_subject_ref text, p_details jsonb, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
  v_actor  text := nullif(current_setting('app.current_actor', true), '');
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'A security event needs an organization and a person bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_event_type NOT IN ('access.refused', 'intake.rejected') THEN
    RAISE EXCEPTION 'The application may not record this kind of security event.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A refused caller must not be able to flood the table: one event per person, organization, type and reason per minute.
  IF EXISTS (
       SELECT 1 FROM public.security_events e
        WHERE e.event_type = p_event_type AND e.tenant_id = v_tenant AND e.actor_ref = v_actor
          AND e.details ->> 'reason' IS NOT DISTINCT FROM p_details ->> 'reason'
          AND e.occurred_at > clock_timestamp() - interval '60 seconds') THEN
    RETURN;
  END IF;
  INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, request_id, details)
  VALUES (v_tenant, p_event_type, p_outcome, 'person', v_actor, p_subject_kind, p_subject_ref, p_request_id, coalesce(p_details, '{}'::jsonb));
END
$$;
