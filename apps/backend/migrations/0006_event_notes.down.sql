-- GUARD: removes audit data. See 0005 for how to allow it on purpose.
DO $$ BEGIN
  IF current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop audit notes: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;

SET LOCAL ROLE telesphoros_redactor;
DROP FUNCTION redact_event_note(uuid, uuid, text);
RESET ROLE;
DROP TABLE event_notes;
SET LOCAL ROLE telesphoros_ledger;
DROP FUNCTION event_notes_guard();
REVOKE EXECUTE ON FUNCTION ledger_append_internal(uuid, text, text, uuid, text, smallint) FROM telesphoros_redactor;
RESET ROLE;
