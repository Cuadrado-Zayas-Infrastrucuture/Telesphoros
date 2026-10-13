-- Live membership (docs/design/plans/m1-5-live-membership-revocation.md): who belongs to which organization, with which roles, as the
-- DATABASE says, checked on every protected request. The identity provider still proves WHO a person is; this table says what they may do now.
--
--   * One row per person per organization, NEVER deleted: a removed person's row is the tombstone that keeps an old token dead.
--   * The application role can only READ it (and only its own organization's rows). It can never grant, remove or re-role anyone;
--     changes come from the operator command (`db membership ...`, run with the migration login).
--   * Writes made on behalf of a person re-check their row in their own transaction through membership_assert_current(), so no write
--     commits after the person's removal commits (see Database.withTenant).
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE tenant_memberships (
  tenant_id          text        NOT NULL,
  sub                text        NOT NULL,
  status             text        NOT NULL,
  roles              text[]      NOT NULL DEFAULT '{}',
  -- A token issued at or before this instant (whole seconds) is refused. 'epoch' means no token has ever been revoked.
  tokens_valid_after timestamptz NOT NULL DEFAULT 'epoch',
  version            bigint      NOT NULL DEFAULT 1,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  changed_by         text        NOT NULL,
  reason             text        NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_memberships_pkey PRIMARY KEY (tenant_id, sub),
  CONSTRAINT tenant_memberships_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT tenant_memberships_sub_len CHECK (length(sub) BETWEEN 1 AND 128),
  CONSTRAINT tenant_memberships_status_check CHECK (status IN ('active', 'removed')),
  CONSTRAINT tenant_memberships_roles_check CHECK (roles <@ ARRAY['reader', 'clinician', 'admin', 'reviewer']::text[] AND cardinality(roles) <= 4),
  CONSTRAINT tenant_memberships_version_check CHECK (version >= 1),
  CONSTRAINT tenant_memberships_changed_by_len CHECK (length(changed_by) BETWEEN 1 AND 128),
  CONSTRAINT tenant_memberships_reason_len CHECK (length(reason) <= 500)
);

-- A person belongs to exactly one organization at a time (the same rule the token's tenant group enforces).
CREATE UNIQUE INDEX tenant_memberships_one_active_uq ON tenant_memberships (sub) WHERE status = 'active';

-- Row-level security binds the application role to its own organization's rows. NOT forced: the owner (the migration login the operator
-- command uses) must read and write across organizations, and it is a login used only by one-off tasks.
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_memberships_tenant ON tenant_memberships FOR SELECT TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true));
GRANT SELECT ON tenant_memberships TO telesphoros_app;

-- Every change bumps the version and the change time, and the key never moves.
CREATE FUNCTION tenant_memberships_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.sub IS DISTINCT FROM OLD.sub OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A membership cannot change its organization, person or creation time.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.tokens_valid_after < OLD.tokens_valid_after THEN
    RAISE EXCEPTION 'A revocation instant cannot move backwards.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.changed_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION tenant_memberships_guard() FROM PUBLIC;
CREATE TRIGGER tenant_memberships_guard BEFORE UPDATE ON tenant_memberships FOR EACH ROW EXECUTE FUNCTION tenant_memberships_guard();

-- A removed person's row is the record that their old tokens stay dead: nobody deletes or truncates it.
CREATE FUNCTION tenant_memberships_refuse_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$ BEGIN RAISE EXCEPTION 'Memberships are never deleted; remove the person instead.' USING ERRCODE = 'integrity_constraint_violation'; END $$;
REVOKE ALL ON FUNCTION tenant_memberships_refuse_delete() FROM PUBLIC;
CREATE TRIGGER tenant_memberships_no_delete BEFORE DELETE ON tenant_memberships FOR EACH ROW EXECUTE FUNCTION tenant_memberships_refuse_delete();
CREATE TRIGGER tenant_memberships_no_truncate BEFORE TRUNCATE ON tenant_memberships FOR EACH STATEMENT EXECUTE FUNCTION tenant_memberships_refuse_delete();

-- The write boundary. Locks the caller's membership row SHARED and answers whether it is still the active row the request was admitted
-- under (same version). A removal or role change is an UPDATE of that row: it waits for every holder of the share lock, and anything that
-- locks afterwards sees the change. So a transaction that calls this just before COMMIT either commits before the change does or is refused.
-- It reads only the organization the transaction is bound to (never a parameter), so it reveals nothing about another organization.
CREATE FUNCTION membership_assert_current(p_sub text, p_version bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_tenant text := current_setting('app.current_tenant_id', true);
BEGIN
  IF v_tenant IS NULL OR v_tenant = '' OR p_sub IS NULL OR p_version IS NULL THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.tenant_memberships
   WHERE tenant_id = v_tenant AND sub = p_sub AND status = 'active' AND version = p_version
     FOR SHARE;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION membership_assert_current(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION membership_assert_current(text, bigint) TO telesphoros_app;
