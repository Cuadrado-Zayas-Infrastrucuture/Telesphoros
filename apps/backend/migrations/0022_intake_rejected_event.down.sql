DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM security_events WHERE event_type = 'intake.rejected') AND current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
  RAISE EXCEPTION 'Refusing to drop recorded intake rejections; explicit disposable-fixture opt-in (telesphoros.allow_audit_drop) required.';
 END IF;
END $$;
-- Explicit migration rollback on a disposable local database only; loses every recorded intake rejection.
ALTER TABLE security_events DISABLE TRIGGER security_events_append_only;
DELETE FROM security_events WHERE event_type = 'intake.rejected';
ALTER TABLE security_events ENABLE TRIGGER security_events_append_only;
DROP INDEX security_events_intake_idx;
ALTER TABLE security_events DROP CONSTRAINT security_events_type_check;
ALTER TABLE security_events ADD CONSTRAINT security_events_type_check CHECK (event_type IN (
  'membership.granted', 'membership.reinstated', 'membership.roles-changed', 'membership.removed', 'membership.sessions-revoked',
  'access.refused'));
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
  IF p_event_type <> 'access.refused' THEN
    RAISE EXCEPTION 'The application may not record this kind of security event.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_event_type = 'access.refused' AND EXISTS (
       SELECT 1 FROM public.security_events e
        WHERE e.event_type = 'access.refused' AND e.tenant_id = v_tenant AND e.actor_ref = v_actor
          AND e.details ->> 'reason' IS NOT DISTINCT FROM p_details ->> 'reason'
          AND e.occurred_at > clock_timestamp() - interval '60 seconds') THEN
    RETURN;
  END IF;
  INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, request_id, details)
  VALUES (v_tenant, p_event_type, p_outcome, 'person', v_actor, p_subject_kind, p_subject_ref, p_request_id, coalesce(p_details, '{}'::jsonb));
END
$$;
