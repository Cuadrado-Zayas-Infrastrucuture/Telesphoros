-- GUARD: removes audit records. See 0005 for how to allow it on purpose.
DO $$ BEGIN
  IF current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop correction and dispute records: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;
DROP TABLE cell_dispute_decisions;
DROP TABLE cell_disputes;
DROP TABLE corrections;
DROP FUNCTION cell_dispute_decisions_check();
DROP FUNCTION corrections_check();
