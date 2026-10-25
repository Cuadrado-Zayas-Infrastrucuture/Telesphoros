-- Dispute rows survive, but a populated rollback loses retry protection. Require explicit operator intent.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- cell_disputes has FORCE ROW LEVEL SECURITY and every policy on it is for another role, so the migrator (its owner, but not a superuser and without BYPASSRLS)
-- sees no rows, and the check below would always read "empty". The owner may lift FORCE inside this transaction; it is put back straight after the check (and a refusal rolls it back with everything else).
ALTER TABLE cell_disputes NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cell_disputes WHERE creation_request_id IS NOT NULL)
     AND current_setting('telesphoros.allow_dispute_retry_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop populated dispute creation retry identities: set telesphoros.allow_dispute_retry_drop=yes only after reviewing the loss of retry protection.';
  END IF;
END $$;
ALTER TABLE cell_disputes FORCE ROW LEVEL SECURITY;
ALTER TABLE cell_disputes
  DROP CONSTRAINT cell_disputes_creation_request_uq,
  DROP CONSTRAINT cell_disputes_creation_request_pair,
  DROP COLUMN creation_request_id,
  DROP COLUMN creation_request_hash;
