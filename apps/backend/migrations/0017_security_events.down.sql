DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM security_events) AND current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
  RAISE EXCEPTION 'Refusing to drop the security-event record; explicit disposable-fixture opt-in (telesphoros.allow_audit_drop) required.';
 END IF;
END $$;
-- Explicit migration rollback on a disposable local database only; loses every security event.
DROP TRIGGER tenant_memberships_audit ON tenant_memberships;
DROP FUNCTION tenant_memberships_audit();
DROP FUNCTION security_event_append(text, text, text, text, jsonb, text);
DROP TABLE security_events;
