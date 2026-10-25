-- Decision rows survive, but a populated rollback loses retry protection. Require explicit operator intent.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- capture_acceptances has FORCE ROW LEVEL SECURITY and every policy on it is for another role, so the migrator (its owner, but not a superuser and without BYPASSRLS)
-- sees no rows, and the check below would always read "empty". The owner may lift FORCE inside this transaction; it is put back straight after the check (and a refusal rolls it back with everything else).
ALTER TABLE capture_acceptances NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM capture_acceptances WHERE creation_request_id IS NOT NULL)
     AND current_setting('telesphoros.allow_capture_decision_retry_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop populated capture decision retry identities: set telesphoros.allow_capture_decision_retry_drop=yes only after reviewing the loss of retry protection.';
  END IF;
END $$;
ALTER TABLE capture_acceptances FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_acceptances
  DROP CONSTRAINT capture_acceptances_creation_request_uq,
  DROP CONSTRAINT capture_acceptances_creation_request_pair,
  DROP COLUMN creation_request_id,
  DROP COLUMN creation_request_hash;
