-- GUARD: this removes audit tables. A routine `db:migrate:down` must not be able to do that by accident.
-- Set it for one session on purpose: PGOPTIONS='-c telesphoros.allow_audit_drop=yes'. (This protects against accidents, not against a privileged owner.)
DO $$ BEGIN
  IF current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop the audit ledger: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;

SET LOCAL ROLE telesphoros_ledger; -- these objects are owned by it, and only an owner can drop them
DROP TABLE ledger_checkpoints;
DROP TABLE ledger_events;
DROP TABLE ledger_heads;
DROP FUNCTION ledger_record_checkpoint(text, bigint, text, text);
DROP FUNCTION ledger_append(uuid, text, text, uuid, text, smallint);
DROP FUNCTION ledger_append_internal(uuid, text, text, uuid, text, smallint);
DROP FUNCTION ledger_event_row_exists();
DROP FUNCTION ledger_row_has_event();
DROP FUNCTION ledger_heads_guard();
RESET ROLE;
DROP FUNCTION refuse_mutation();
-- Roles are cluster-wide and may serve other databases: they are left in place (as with telesphoros_app in 0002).
