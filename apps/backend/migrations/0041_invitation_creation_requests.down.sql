-- Invitation rows survive, but a populated rollback loses retry protection. Require explicit operator intent.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM invitations WHERE creation_request_id IS NOT NULL)
     AND current_setting('telesphoros.allow_invitation_retry_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop populated invitation creation retry identities: set telesphoros.allow_invitation_retry_drop=yes only after reviewing the loss of retry protection.';
  END IF;
END $$;
DROP FUNCTION invitation_create_keyed(bytea, text, text[], uuid, text);
DROP TRIGGER invitations_creation_request_guard ON invitations;
DROP FUNCTION invitations_creation_request_guard();
ALTER TABLE invitations
  DROP CONSTRAINT invitations_creation_request_uq,
  DROP CONSTRAINT invitations_creation_request_pair,
  DROP COLUMN creation_request_id,
  DROP COLUMN creation_request_hash;
