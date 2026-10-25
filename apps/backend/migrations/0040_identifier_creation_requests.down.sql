-- Identifier rows survive, but a populated rollback loses retry protection. Require explicit operator intent.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- patient_identifiers has FORCE ROW LEVEL SECURITY and every policy on it is for another role, so the migrator (its owner, but not a superuser and without BYPASSRLS)
-- sees no rows, and the check below would always read "empty". The owner may lift FORCE inside this transaction; it is put back straight after the check (and a refusal rolls it back with everything else).
ALTER TABLE patient_identifiers NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM patient_identifiers WHERE creation_request_id IS NOT NULL)
     AND current_setting('telesphoros.allow_identifier_retry_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop populated identifier creation retry identities: set telesphoros.allow_identifier_retry_drop=yes only after reviewing the loss of retry protection.';
  END IF;
END $$;
ALTER TABLE patient_identifiers FORCE ROW LEVEL SECURITY;
DROP TRIGGER patient_identifiers_creation_request_guard ON patient_identifiers;
DROP FUNCTION patient_identifiers_creation_request_guard();
ALTER TABLE patient_identifiers
  DROP CONSTRAINT patient_identifiers_creation_request_uq,
  DROP CONSTRAINT patient_identifiers_creation_request_pair,
  DROP COLUMN creation_request_id,
  DROP COLUMN creation_request_hash;
