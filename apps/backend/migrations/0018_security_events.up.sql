-- The security-event audit store (docs/design/plans/m1-6-security-events.md): an append-only record of who changed who may do what and why a valid
-- token was refused, kept apart from the clinical ledger, from diagnostic logs and from the application access audit (security_audit_events, 0016),
-- which already records every file link, so links are deliberately not recorded here.
--
--   * Nobody updates, deletes or truncates a row (the owner included; refuse_mutation, as on the ledger tables).
--   * The application role has NO privilege on the table. It can only call security_event_append(), which takes the organization and the person from
--     the transaction's own settings (never from its arguments) and refuses every event type the application is not meant to write.
--   * Membership changes are recorded by a trigger on tenant_memberships, in the same transaction as the change.
--   * Only the auditor role reads (its login is provisioned outside the repository, like the ledger operator).
--   * Nothing that could carry a token, a URL, a file name or a patient value fits in an event: details is limited to a short allowlist of keys,
--     and every string in it must be at most 64 letters, digits or hyphens.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_security_auditor') THEN
    CREATE ROLE telesphoros_security_auditor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

CREATE TABLE security_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint      GENERATED ALWAYS AS IDENTITY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  tenant_id    text,
  event_type   text        NOT NULL,
  outcome      text        NOT NULL,
  actor_kind   text        NOT NULL,
  actor_ref    text        NOT NULL,
  subject_kind text        NOT NULL,
  subject_ref  text        NOT NULL,
  request_id   text,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  db_user      text        NOT NULL DEFAULT session_user,
  CONSTRAINT security_events_seq_uq UNIQUE (seq),
  CONSTRAINT security_events_tenant_id_len CHECK (tenant_id IS NULL OR length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT security_events_type_check CHECK (event_type IN (
    'membership.granted', 'membership.reinstated', 'membership.roles-changed', 'membership.removed', 'membership.sessions-revoked',
    'access.refused')),
  CONSTRAINT security_events_outcome_check CHECK (outcome IN ('succeeded', 'refused')),
  CONSTRAINT security_events_actor_kind_check CHECK (actor_kind IN ('person', 'operator', 'system')),
  CONSTRAINT security_events_actor_ref_len CHECK (length(actor_ref) BETWEEN 1 AND 128),
  CONSTRAINT security_events_subject_kind_check CHECK (subject_kind = 'person'),
  CONSTRAINT security_events_subject_ref_len CHECK (length(subject_ref) BETWEEN 1 AND 128),
  CONSTRAINT security_events_request_id_len CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT security_events_db_user_len CHECK (length(db_user) BETWEEN 1 AND 128),
  -- Small, a fixed set of keys, and nothing but short letter-digit-hyphen strings (so no URL, token, dotted name, space or query string can be stored).
  CONSTRAINT security_events_details_shape CHECK (
    jsonb_typeof(details) = 'object'
    AND pg_column_size(details) <= 2048
    AND (details - ARRAY['reason', 'roles', 'before', 'after']) = '{}'::jsonb
    AND NOT jsonb_path_exists(details, '$.** ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9-]{1,64}$"))')
  )
);

CREATE INDEX security_events_tenant_time_idx ON security_events (tenant_id, occurred_at);
CREATE INDEX security_events_refusal_idx ON security_events (tenant_id, actor_ref, (details ->> 'reason'), occurred_at DESC) WHERE event_type = 'access.refused';

CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE ON security_events FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER security_events_no_truncate BEFORE TRUNCATE ON security_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

REVOKE ALL ON security_events FROM PUBLIC;
GRANT SELECT ON security_events TO telesphoros_security_auditor;
GRANT USAGE ON SCHEMA public TO telesphoros_security_auditor;

-- The application's only way in. The organization and the person come from the transaction (Database.withTenant sets both), so a request cannot record an
-- event for another organization or in someone else's name; the membership event types are written by the trigger below and never through here.
CREATE FUNCTION security_event_append(p_event_type text, p_outcome text, p_subject_kind text, p_subject_ref text, p_details jsonb, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');
  v_actor  text := nullif(current_setting('app.current_actor', true), '');
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'A security event needs an organization and a person bound to the transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_event_type <> 'access.refused' THEN
    RAISE EXCEPTION 'The application may not record this kind of security event.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A refused caller must not be able to flood the table: one event per person, organization and reason per minute.
  IF p_event_type = 'access.refused' AND EXISTS (
       SELECT 1 FROM public.security_events e
        WHERE e.event_type = 'access.refused' AND e.tenant_id = v_tenant AND e.actor_ref = v_actor
          AND e.details ->> 'reason' IS NOT DISTINCT FROM p_details ->> 'reason'
          AND e.occurred_at > clock_timestamp() - interval '60 seconds') THEN
    RETURN;
  END IF;
  INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, request_id, details)
  VALUES (v_tenant, p_event_type, p_outcome, 'person', v_actor, p_subject_kind, p_subject_ref, p_request_id, coalesce(p_details, '{}'::jsonb));
END
$$;
REVOKE ALL ON FUNCTION security_event_append(text, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security_event_append(text, text, text, text, jsonb, text) TO telesphoros_app;

-- Membership changes are recorded in the same transaction as the change, so none can happen without its event (whoever makes it, with the operator command
-- or with hand-written SQL by the owner). The operator name is the row's changed_by; free-text reasons stay on the row and are not copied here.
CREATE FUNCTION tenant_memberships_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, 'membership.granted', 'succeeded', 'operator', NEW.changed_by, 'person', NEW.sub, jsonb_build_object('after', to_jsonb(NEW.roles)));
    RETURN NEW;
  END IF;
  IF OLD.status = 'removed' AND NEW.status = 'active' THEN
    v_type := 'membership.reinstated';
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, v_type, 'succeeded', 'operator', NEW.changed_by, 'person', NEW.sub, jsonb_build_object('after', to_jsonb(NEW.roles)));
  ELSIF OLD.status = 'active' AND NEW.status = 'removed' THEN
    v_type := 'membership.removed';
    INSERT INTO public.security_events (tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, details)
    VALUES (NEW.tenant_id, v_type, 'succeeded', 'operator', NEW.changed_by, 'person', NEW.sub, jsonb_build_object('before', to_jsonb(OLD.roles)));
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
REVOKE ALL ON FUNCTION tenant_memberships_audit() FROM PUBLIC;
CREATE TRIGGER tenant_memberships_audit AFTER INSERT OR UPDATE ON tenant_memberships FOR EACH ROW EXECUTE FUNCTION tenant_memberships_audit();
