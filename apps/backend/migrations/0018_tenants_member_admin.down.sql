DO $$ BEGIN
 IF (EXISTS (SELECT 1 FROM invitations) OR EXISTS (SELECT 1 FROM tenants WHERE created_by <> 'migration-0018')) AND current_setting('telesphoros.allow_membership_drop', true) IS DISTINCT FROM 'yes' THEN
  RAISE EXCEPTION 'Refusing to drop the tenant registry or invitations (they hold organizations and pending invitations); explicit disposable-fixture opt-in (telesphoros.allow_membership_drop) required.';
 END IF;
END $$;
-- Explicit migration rollback on a disposable local database only.
DROP FUNCTION invitation_cancel(uuid);
DROP FUNCTION invitation_create(bytea, text, text[]);
DROP FUNCTION member_remove(text);
DROP FUNCTION member_change_roles(text, text[]);
DROP FUNCTION member_admin_context();
DROP TABLE invitations;
DROP FUNCTION invitations_refuse_delete();
DROP FUNCTION invitations_guard();
ALTER TABLE tenant_memberships DROP CONSTRAINT tenant_memberships_tenant_fk;
DROP TABLE tenants;
DROP FUNCTION tenants_refuse_delete();
DROP FUNCTION tenants_guard();
-- Restore the 0017 form of the membership audit trigger function (it names every actor an operator).
CREATE OR REPLACE FUNCTION tenant_memberships_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.granted', 'succeeded', 'operator', NEW.changed_by, 'person', NEW.sub, jsonb_build_object('after', to_jsonb(NEW.roles)));
    RETURN NEW;
  END IF;
  IF OLD.status = 'removed' AND NEW.status = 'active' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.reinstated', 'succeeded', 'operator', NEW.changed_by, 'person', NEW.sub, jsonb_build_object('after', to_jsonb(NEW.roles)));
  ELSIF OLD.status = 'active' AND NEW.status = 'removed' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.removed', 'succeeded', 'operator', NEW.changed_by, 'person', NEW.sub, jsonb_build_object('before', to_jsonb(OLD.roles)));
  ELSE
    IF NEW.roles IS DISTINCT FROM OLD.roles THEN
      INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
      VALUES (NEW.tenant_id, 'membership.roles-changed', 'succeeded', 'operator', NEW.changed_by, 'person', NEW.sub,
              jsonb_build_object('before', to_jsonb(OLD.roles), 'after', to_jsonb(NEW.roles)));
    END IF;
    IF NEW.tokens_valid_after IS DISTINCT FROM OLD.tokens_valid_after THEN
      INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
      VALUES (NEW.tenant_id, 'membership.sessions-revoked', 'succeeded', 'operator', NEW.changed_by, 'person', NEW.sub, '{}'::jsonb);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
