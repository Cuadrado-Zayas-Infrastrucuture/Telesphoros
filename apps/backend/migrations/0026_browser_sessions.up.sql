-- M5.1a: short-lived credential custody. No auth route consumes this table yet.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE browser_sessions (
  tenant_id text NOT NULL,
  handle_hash text NOT NULL,
  sub text NOT NULL,
  issued_at bigint NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  credential text NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, handle_hash),
  CONSTRAINT browser_sessions_membership_fk FOREIGN KEY (tenant_id, sub) REFERENCES tenant_memberships (tenant_id, sub) ON DELETE RESTRICT,
  CONSTRAINT browser_sessions_handle_hash_shape CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT browser_sessions_issued_at_range CHECK (issued_at >= 0 AND issued_at <= extract(epoch FROM created_at) + 30),
  CONSTRAINT browser_sessions_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CONSTRAINT browser_sessions_created_at_bound CHECK (created_at <= clock_timestamp() + interval '30 seconds'),
  CONSTRAINT browser_sessions_credential_shape CHECK (octet_length(credential) BETWEEN 1 AND 16384 AND credential ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'),
  CONSTRAINT browser_sessions_revoked_at_bound CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX browser_sessions_expiry_idx ON browser_sessions (tenant_id, expires_at, handle_hash);

-- Identity, lifetime and sealed credentials never change. Revocation is terminal and database-timed.
CREATE FUNCTION browser_sessions_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Session custody can only be revoked once.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.revoked_at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION browser_sessions_guard() FROM PUBLIC;
CREATE TRIGGER browser_sessions_guard BEFORE UPDATE ON browser_sessions FOR EACH ROW EXECUTE FUNCTION browser_sessions_guard();

CREATE FUNCTION browser_sessions_expired_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Session custody cannot be truncated.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Only expired session custody can be removed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION browser_sessions_expired_only() FROM PUBLIC;
CREATE TRIGGER browser_sessions_expired_only BEFORE DELETE ON browser_sessions FOR EACH ROW EXECUTE FUNCTION browser_sessions_expired_only();
CREATE TRIGGER browser_sessions_no_truncate BEFORE TRUNCATE ON browser_sessions FOR EACH STATEMENT EXECUTE FUNCTION browser_sessions_expired_only();

ALTER TABLE browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_sessions_read ON browser_sessions FOR SELECT TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY browser_sessions_create ON browser_sessions FOR INSERT TO telesphoros_app
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY browser_sessions_revoke ON browser_sessions FOR UPDATE TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY browser_sessions_cleanup ON browser_sessions FOR DELETE TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true) AND expires_at <= clock_timestamp());
REVOKE ALL ON browser_sessions FROM PUBLIC;
GRANT SELECT, DELETE ON browser_sessions TO telesphoros_app;
GRANT INSERT (tenant_id, handle_hash, sub, issued_at, created_at, expires_at, credential), UPDATE (revoked_at) ON browser_sessions TO telesphoros_app;
