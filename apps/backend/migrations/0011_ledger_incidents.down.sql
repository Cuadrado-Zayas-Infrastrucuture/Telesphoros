-- GUARD: removes audit data (incidents and their clearances). See 0005 for how to allow it on purpose.
DO $$ BEGIN
  IF current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop ledger incidents: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;

GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (replacing a function needs it)
SET LOCAL ROLE telesphoros_ledger;
-- Back to the 0005 gate (no incident check).
CREATE OR REPLACE FUNCTION ledger_append(p_event uuid, p_type text, p_table text, p_subject uuid, p_payload text, p_projection_version smallint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_type IN ('redaction', 'checkpoint') THEN
    RAISE EXCEPTION 'This event type cannot be appended by the application.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.ledger_append_internal(p_event, p_type, p_table, p_subject, p_payload, p_projection_version);
END $$;

DROP FUNCTION ledger_clear_incident(uuid, text);
DROP FUNCTION ledger_set_global_hold(text);
DROP FUNCTION ledger_record_incident(text, text, bigint, text);
DROP FUNCTION ledger_record_checkpoint(text, bigint, text, text, timestamptz);
DROP TABLE ledger_incident_clearances;
DROP TABLE ledger_incidents;
ALTER TABLE ledger_checkpoints DROP COLUMN walk_started_at;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
