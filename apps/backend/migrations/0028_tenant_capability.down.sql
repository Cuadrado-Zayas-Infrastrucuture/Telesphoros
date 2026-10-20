-- GUARD: removes the capability issuance log, the record of every attempt to mint. See 0005 for how to allow it on purpose.
SET LOCAL ROLE telesphoros_capability; -- the owner can read its own tables; the migrator cannot
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM capability_issuance_log) AND current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop the capability issuance log: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;
DROP FUNCTION tenant_capabilities_sweep(integer);
DROP FUNCTION app_actor();
DROP FUNCTION app_tenant();
DROP FUNCTION tenant_capability_issue(text, text, bigint, text, bytea, text);
DROP TABLE tenant_binding_mode;
DROP TABLE capability_issuance_log;
DROP TABLE tenant_capabilities;
DROP TABLE capability_purposes;
RESET ROLE;

DROP POLICY tenant_memberships_capability ON tenant_memberships;
DROP POLICY tenants_capability ON tenants;
REVOKE REFERENCES ON tenants FROM telesphoros_capability;
REVOKE SELECT ON tenants, tenant_memberships FROM telesphoros_capability;
REVOKE USAGE ON SCHEMA public FROM telesphoros_capability, telesphoros_issuer;
-- The roles are cluster-wide and stay, like every other group role.
