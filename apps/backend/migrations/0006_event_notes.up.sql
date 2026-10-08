-- Free text lives here and nowhere else (specification 3.7). The ledger and the record tables carry only body_sha256, so a note that
-- contains something it should not can be redacted without breaking the chain. Redaction is the ONE update this table allows.
--
--   telesphoros_redactor         NOLOGIN. Owns only the redaction function; may UPDATE only the three redaction columns of a note.
--   telesphoros_ledger_operator  NOLOGIN group. May execute the redaction function. A login is provisioned outside the repository.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_redactor') THEN
    CREATE ROLE telesphoros_redactor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_ledger_operator') THEN
    CREATE ROLE telesphoros_ledger_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT pg_has_role(current_user, 'telesphoros_redactor', 'SET') THEN
    EXECUTE format('GRANT telesphoros_redactor TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  END IF;
END
$$;

CREATE TABLE event_notes (
  seq                  bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            text NOT NULL,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  body                 text NOT NULL,
  -- SHA-256 of the body as first written (UTF-8). Immutable. The parent record commits to this value, not to the text.
  body_sha256          text NOT NULL,
  redacted_at          timestamptz,
  redaction_basis_code text,
  CONSTRAINT event_notes_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT event_notes_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT event_notes_body_len CHECK (length(body) BETWEEN 1 AND 1000),
  CONSTRAINT event_notes_digest_format CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_notes_basis CHECK (redaction_basis_code IS NULL OR redaction_basis_code IN ('phi-in-note', 'legal-order', 'other-approved')),
  CONSTRAINT event_notes_redaction_consistent CHECK ((redacted_at IS NULL) = (redaction_basis_code IS NULL) AND (redacted_at IS NULL OR body = '[redacted]')),
  CONSTRAINT event_notes_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX event_notes_tenant_seq_idx ON event_notes (tenant_id, seq);

CREATE TRIGGER event_notes_no_delete BEFORE DELETE ON event_notes FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER event_notes_no_truncate BEFORE TRUNCATE ON event_notes FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

GRANT CREATE ON SCHEMA public TO telesphoros_ledger, telesphoros_redactor; -- only while this migration runs
SET LOCAL ROLE telesphoros_ledger;

-- The only allowed update: unredacted -> redacted, once, with the tombstone, and ONLY if this very transaction appended the
-- note's redaction event (so an event from an earlier transaction can never be reused). Everything else is refused for every role.
CREATE FUNCTION event_notes_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This note is already redacted.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.redacted_at IS NULL OR NEW.redaction_basis_code IS NULL OR NEW.body <> '[redacted]'
     OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.body_sha256 <> OLD.body_sha256 OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'The only change allowed to a note is its redaction.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_events e
                  WHERE e.subject_table = 'event_notes' AND e.subject_id = OLD.id AND e.event_type = 'redaction'
                    AND e.tenant_id = OLD.tenant_id AND e.xmin = pg_catalog.pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'A redaction needs its ledger event, appended in the same transaction.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
GRANT EXECUTE ON FUNCTION ledger_append_internal(uuid, text, text, uuid, text, smallint) TO telesphoros_redactor;
REVOKE ALL ON FUNCTION event_notes_guard() FROM PUBLIC;
DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION event_notes_guard() TO %I', session_user); END $$; -- the migrator creates the trigger

RESET ROLE;
CREATE TRIGGER event_notes_guard BEFORE UPDATE ON event_notes FOR EACH ROW EXECUTE FUNCTION event_notes_guard();

SET LOCAL ROLE telesphoros_redactor;

-- Run by an operator as a runbook procedure (never an API). Atomic: the event, the tombstone and the basis commit together or not at all.
-- The event's payload is sha256(note id : original body digest : basis code), which the verifier recomputes.
CREATE FUNCTION redact_event_note(p_note uuid, p_event uuid, p_basis text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n record;
BEGIN
  SELECT * INTO n FROM public.event_notes WHERE id = p_note FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such note.' USING ERRCODE = 'no_data_found';
  END IF;
  IF n.redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This note is already redacted.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM public.ledger_append_internal(p_event, 'redaction', 'event_notes', p_note,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_note::text || ':' || n.body_sha256 || ':' || p_basis, 'UTF8')), 'hex'), 1::smallint);
  UPDATE public.event_notes SET body = '[redacted]', redacted_at = pg_catalog.now(), redaction_basis_code = p_basis WHERE id = p_note;
END $$;
REVOKE ALL ON FUNCTION redact_event_note(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redact_event_note(uuid, uuid, text) TO telesphoros_ledger_operator;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger, telesphoros_redactor;

ALTER TABLE event_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY event_notes_tenant ON event_notes FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY event_notes_ledger ON event_notes FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY event_notes_redactor_read ON event_notes FOR SELECT TO telesphoros_redactor USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY event_notes_redactor_update ON event_notes FOR UPDATE TO telesphoros_redactor
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY event_notes_verifier ON event_notes FOR SELECT TO telesphoros_ledger_verifier USING (true);

REVOKE ALL ON event_notes FROM PUBLIC;
GRANT SELECT, INSERT ON event_notes TO telesphoros_app;
GRANT SELECT ON event_notes TO telesphoros_ledger, telesphoros_ledger_verifier;
GRANT SELECT, UPDATE (body, redacted_at, redaction_basis_code) ON event_notes TO telesphoros_redactor;
