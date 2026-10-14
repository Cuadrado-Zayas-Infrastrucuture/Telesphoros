DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM tenant_memberships) AND current_setting('telesphoros.allow_membership_drop', true) IS DISTINCT FROM 'yes' THEN
  RAISE EXCEPTION 'Refusing to drop populated memberships (they are the authority and the revocation record); explicit disposable-fixture opt-in required.';
 END IF;
END $$;
-- Explicit migration rollback on a disposable local database only; loses every membership and revocation record.
DROP FUNCTION membership_assert_current(text, bigint);
DROP TABLE tenant_memberships;
DROP FUNCTION tenant_memberships_refuse_delete();
DROP FUNCTION tenant_memberships_guard();
