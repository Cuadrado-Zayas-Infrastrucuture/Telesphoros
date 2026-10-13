-- Tenant registry and member administration (docs/design/plans/m2-1-onboarding-patient-identity.md, slice M2.1a).
--
--   * tenants: which organizations exist. A membership must name a registered one (foreign key), so a typo can no longer create a ghost organization.
--   * invitations: a record that an organization administrator wants a person to join. The address is kept only as a keyed digest and a masked hint.
--     No application path creates an identity: an operator creates the account and fulfils the invitation (docs/ops/membership.md).
--   * member administration: an organization administrator changes roles and removes people through SECURITY DEFINER functions that enforce the rules
--     in the database (own organization only, never oneself, never the last administrator). The application role still has NO write privilege on
--     tenant_memberships; it can only execute these functions.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE tenants (
  id           text        PRIMARY KEY,
  display_name text        NOT NULL,
  status       text        NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  changed_by   text        NOT NULL,
  CONSTRAINT tenants_id_len CHECK (length(id) BETWEEN 1 AND 128),
  CONSTRAINT tenants_display_name_len CHECK (length(display_name) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]]'),
  CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended')),
  CONSTRAINT tenants_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT tenants_changed_by_len CHECK (length(changed_by) BETWEEN 1 AND 128)
);

-- Organizations that already have people (M1.5 memberships) are registered under their own id. An organization that has records but no member has
-- nobody who can sign in; the operator registers it with `db tenant create` if it is ever needed.
INSERT INTO tenants (id, display_name, created_by, changed_by)
SELECT DISTINCT tenant_id, tenant_id, 'migration-0018', 'migration-0018' FROM tenant_memberships;

ALTER TABLE tenant_memberships ADD CONSTRAINT tenant_memberships_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION tenants_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'An organization cannot change its id or its creation record.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.changed_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION tenants_guard() FROM PUBLIC;
CREATE TRIGGER tenants_guard BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_guard();
CREATE FUNCTION tenants_refuse_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$ BEGIN RAISE EXCEPTION 'Organizations are never deleted; suspend them instead.' USING ERRCODE = 'integrity_constraint_violation'; END $$;
REVOKE ALL ON FUNCTION tenants_refuse_delete() FROM PUBLIC;
CREATE TRIGGER tenants_no_delete BEFORE DELETE ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_refuse_delete();
CREATE TRIGGER tenants_no_truncate BEFORE TRUNCATE ON tenants FOR EACH STATEMENT EXECUTE FUNCTION tenants_refuse_delete();

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_own ON tenants FOR SELECT TO telesphoros_app USING (id = current_setting('app.current_tenant_id', true));
GRANT SELECT ON tenants TO telesphoros_app;

CREATE TABLE invitations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text        NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  email_digest bytea       NOT NULL,
  email_hint   text        NOT NULL,
  roles        text[]      NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'pending',
  expires_at   timestamptz NOT NULL,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_by   text,
  decided_at   timestamptz,
  fulfilled_sub text,
  CONSTRAINT invitations_digest_len CHECK (octet_length(email_digest) = 32),
  CONSTRAINT invitations_hint_len CHECK (length(email_hint) BETWEEN 3 AND 80 AND email_hint !~ '[[:cntrl:]]'),
  CONSTRAINT invitations_roles_check CHECK (roles <@ ARRAY['reader', 'clinician', 'admin', 'reviewer']::text[] AND cardinality(roles) <= 4),
  CONSTRAINT invitations_status_check CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  CONSTRAINT invitations_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT invitations_decided_shape CHECK ((status = 'pending') = (decided_at IS NULL AND decided_by IS NULL AND fulfilled_sub IS NULL) OR status <> 'pending'),
  CONSTRAINT invitations_fulfilled_sub_len CHECK (fulfilled_sub IS NULL OR length(fulfilled_sub) BETWEEN 1 AND 128)
);
-- One pending invitation per person per organization.
CREATE UNIQUE INDEX invitations_one_pending_uq ON invitations (tenant_id, email_digest) WHERE status = 'pending';
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id, created_at);

CREATE FUNCTION invitations_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'A decided invitation cannot change.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.email_digest IS DISTINCT FROM OLD.email_digest
     OR NEW.email_hint IS DISTINCT FROM OLD.email_hint OR NEW.roles IS DISTINCT FROM OLD.roles OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'An invitation can only be decided, not edited.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION invitations_guard() FROM PUBLIC;
CREATE TRIGGER invitations_guard BEFORE UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION invitations_guard();
CREATE FUNCTION invitations_refuse_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$ BEGIN RAISE EXCEPTION 'Invitations are never deleted; cancel them instead.' USING ERRCODE = 'integrity_constraint_violation'; END $$;
REVOKE ALL ON FUNCTION invitations_refuse_delete() FROM PUBLIC;
CREATE TRIGGER invitations_no_delete BEFORE DELETE ON invitations FOR EACH ROW EXECUTE FUNCTION invitations_refuse_delete();
CREATE TRIGGER invitations_no_truncate BEFORE TRUNCATE ON invitations FOR EACH STATEMENT EXECUTE FUNCTION invitations_refuse_delete();

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_own ON invitations FOR SELECT TO telesphoros_app USING (tenant_id = current_setting('app.current_tenant_id', true));
GRANT SELECT ON invitations TO telesphoros_app;

-- The caller of every member-administration function: an active administrator of an active organization, both taken from the transaction
-- (Database.withTenant sets them), never from an argument. Not executable by the application role.
CREATE FUNCTION member_admin_context(OUT o_tenant text, OUT o_actor text) LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  o_tenant := nullif(current_setting('app.current_tenant_id', true), '');
  o_actor := nullif(current_setting('app.current_actor', true), '');
  IF o_tenant IS NULL OR o_actor IS NULL THEN
    RAISE EXCEPTION 'member-admin-context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = o_tenant AND status = 'active') THEN
    RAISE EXCEPTION 'tenant-inactive' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenant_memberships WHERE tenant_id = o_tenant AND sub = o_actor AND status = 'active' AND 'admin' = ANY (roles)) THEN
    RAISE EXCEPTION 'not-administrator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One administrative change at a time per organization, so two administrators cannot demote each other past the last-administrator rule.
  PERFORM pg_advisory_xact_lock(hashtext('member-admin:' || o_tenant));
END
$$;
REVOKE ALL ON FUNCTION member_admin_context() FROM PUBLIC;

CREATE FUNCTION member_change_roles(p_sub text, p_roles text[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_ctx record;
  v_old text[];
  v_new text[];
BEGIN
  SELECT * INTO v_ctx FROM public.member_admin_context();
  IF p_sub = v_ctx.o_actor THEN RAISE EXCEPTION 'member-self' USING ERRCODE = 'P0001'; END IF;
  SELECT roles INTO v_old FROM public.tenant_memberships WHERE tenant_id = v_ctx.o_tenant AND sub = p_sub AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member-not-found' USING ERRCODE = 'P0002'; END IF;
  v_new := ARRAY(SELECT x FROM unnest(p_roles) WITH ORDINALITY u (x, o) GROUP BY x ORDER BY min(o));
  IF v_new IS NOT DISTINCT FROM v_old THEN RETURN; END IF;
  IF 'admin' = ANY (v_old) AND NOT 'admin' = ANY (v_new)
     AND NOT EXISTS (SELECT 1 FROM public.tenant_memberships WHERE tenant_id = v_ctx.o_tenant AND status = 'active' AND 'admin' = ANY (roles) AND sub <> p_sub) THEN
    RAISE EXCEPTION 'last-administrator' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.tenant_memberships SET roles = v_new, changed_by = v_ctx.o_actor, reason = 'changed by an administrator'
   WHERE tenant_id = v_ctx.o_tenant AND sub = p_sub;
END
$$;

CREATE FUNCTION member_remove(p_sub text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_ctx record;
  v_old text[];
BEGIN
  SELECT * INTO v_ctx FROM public.member_admin_context();
  IF p_sub = v_ctx.o_actor THEN RAISE EXCEPTION 'member-self' USING ERRCODE = 'P0001'; END IF;
  SELECT roles INTO v_old FROM public.tenant_memberships WHERE tenant_id = v_ctx.o_tenant AND sub = p_sub AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member-not-found' USING ERRCODE = 'P0002'; END IF;
  IF 'admin' = ANY (v_old)
     AND NOT EXISTS (SELECT 1 FROM public.tenant_memberships WHERE tenant_id = v_ctx.o_tenant AND status = 'active' AND 'admin' = ANY (roles) AND sub <> p_sub) THEN
    RAISE EXCEPTION 'last-administrator' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.tenant_memberships SET status = 'removed', changed_by = v_ctx.o_actor, reason = 'removed by an administrator',
         tokens_valid_after = greatest(tokens_valid_after, now())
   WHERE tenant_id = v_ctx.o_tenant AND sub = p_sub;
END
$$;

CREATE FUNCTION invitation_create(p_email_digest bytea, p_email_hint text, p_roles text[]) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_ctx record;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM public.member_admin_context();
  IF (SELECT count(*) FROM public.invitations WHERE tenant_id = v_ctx.o_tenant AND status = 'pending' AND expires_at > now()) >= 100 THEN
    RAISE EXCEPTION 'invitation-limit' USING ERRCODE = 'P0001';
  END IF;
  -- A pending invitation that has expired no longer blocks a new one for the same person.
  UPDATE public.invitations SET status = 'cancelled', decided_by = 'expired', decided_at = now()
   WHERE tenant_id = v_ctx.o_tenant AND email_digest = p_email_digest AND status = 'pending' AND expires_at <= now();
  INSERT INTO public.invitations (tenant_id, email_digest, email_hint, roles, expires_at, created_by)
  VALUES (v_ctx.o_tenant, p_email_digest, p_email_hint, ARRAY(SELECT x FROM unnest(p_roles) WITH ORDINALITY u (x, o) GROUP BY x ORDER BY min(o)), now() + interval '14 days', v_ctx.o_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

CREATE FUNCTION invitation_cancel(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_ctx record;
BEGIN
  SELECT * INTO v_ctx FROM public.member_admin_context();
  UPDATE public.invitations SET status = 'cancelled', decided_by = v_ctx.o_actor, decided_at = now()
   WHERE id = p_id AND tenant_id = v_ctx.o_tenant AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation-not-found' USING ERRCODE = 'P0002'; END IF;
END
$$;

REVOKE ALL ON FUNCTION member_change_roles(text, text[]), member_remove(text), invitation_create(bytea, text, text[]), invitation_cancel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_change_roles(text, text[]), member_remove(text), invitation_create(bytea, text, text[]), invitation_cancel(uuid) TO telesphoros_app;

-- Membership events say who did it as a person when an administrator did it through the application (the transaction names them), and as an
-- operator when the operator command or hand-written SQL did.
CREATE OR REPLACE FUNCTION tenant_memberships_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_kind text := CASE WHEN nullif(current_setting('app.current_actor', true), '') = NEW.changed_by THEN 'person' ELSE 'operator' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.granted', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub, jsonb_build_object('after', to_jsonb(NEW.roles)));
    RETURN NEW;
  END IF;
  IF OLD.status = 'removed' AND NEW.status = 'active' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.reinstated', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub, jsonb_build_object('after', to_jsonb(NEW.roles)));
  ELSIF OLD.status = 'active' AND NEW.status = 'removed' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.removed', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub, jsonb_build_object('before', to_jsonb(OLD.roles)));
  ELSE
    IF NEW.roles IS DISTINCT FROM OLD.roles THEN
      INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
      VALUES (NEW.tenant_id, 'membership.roles-changed', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub,
              jsonb_build_object('before', to_jsonb(OLD.roles), 'after', to_jsonb(NEW.roles)));
    END IF;
    IF NEW.tokens_valid_after IS DISTINCT FROM OLD.tokens_valid_after THEN
      INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
      VALUES (NEW.tenant_id, 'membership.sessions-revoked', 'succeeded', v_kind, NEW.changed_by, 'person', NEW.sub, '{}'::jsonb);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
