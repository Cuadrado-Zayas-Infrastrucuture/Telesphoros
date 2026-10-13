-- M2.1b: patient identifiers (keyed digests only) and the recorded decision that a report's exact file version belongs to a patient.
-- See docs/design/plans/m2-1b-identifiers-and-patient-link.md.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Identifiers a clinic already uses for a patient (a record number, say). The value is never stored: only a keyed HMAC-SHA-256 digest of the
-- normalized value under a key derived for this organization (src/patient-identity/identifier-digest.ts). The digest is sensitive: it is
-- protected by row-level security and never leaves the API.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE patient_identifiers (
  seq          bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  patient_id   uuid NOT NULL,
  system       text NOT NULL,
  value_digest bytea NOT NULL,
  key_version  smallint NOT NULL DEFAULT 1,
  status       text NOT NULL DEFAULT 'active',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_by text,
  withdrawn_at timestamptz,
  CONSTRAINT patient_identifiers_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT patient_identifiers_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT patient_identifiers_system_shape CHECK (system ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  CONSTRAINT patient_identifiers_digest_len CHECK (octet_length(value_digest) = 32),
  CONSTRAINT patient_identifiers_key_version CHECK (key_version >= 1),
  CONSTRAINT patient_identifiers_status CHECK (status IN ('active', 'withdrawn')),
  CONSTRAINT patient_identifiers_withdrawal_shape CHECK ((status = 'active') = (withdrawn_by IS NULL AND withdrawn_at IS NULL)),
  CONSTRAINT patient_identifiers_withdrawn_by_len CHECK (withdrawn_by IS NULL OR length(withdrawn_by) BETWEEN 1 AND 128),
  CONSTRAINT patient_identifiers_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT patient_identifiers_id_tenant_patient_uq UNIQUE (id, tenant_id, patient_id)
);
-- One number identifies one patient at a time; a withdrawn identifier frees its number (a number typed onto the wrong patient can be corrected).
CREATE UNIQUE INDEX patient_identifiers_active_uq ON patient_identifiers (tenant_id, system, value_digest) WHERE status = 'active';
CREATE INDEX patient_identifiers_patient_idx ON patient_identifiers (tenant_id, patient_id, seq);

-- The only change a row ever takes: active to withdrawn, once, by a named person. Nothing else about it moves.
CREATE FUNCTION patient_identifiers_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_actor text := nullif(current_setting('app.current_actor', true), '');
BEGIN
  IF NEW.id <> OLD.id OR NEW.seq <> OLD.seq OR NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id OR NEW.system <> OLD.system
     OR NEW.value_digest <> OLD.value_digest OR NEW.key_version <> OLD.key_version OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An identifier can only be withdrawn, not edited.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (OLD.status = 'active' AND NEW.status = 'withdrawn') THEN
    RAISE EXCEPTION 'An identifier can only go from active to withdrawn, once.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_actor IS NOT NULL AND NEW.withdrawn_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'An identifier is withdrawn by the person making the request.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION patient_identifiers_guard() FROM PUBLIC;
CREATE TRIGGER patient_identifiers_guard BEFORE UPDATE ON patient_identifiers FOR EACH ROW EXECUTE FUNCTION patient_identifiers_guard();
CREATE TRIGGER patient_identifiers_no_delete BEFORE DELETE ON patient_identifiers FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER patient_identifiers_no_truncate BEFORE TRUNCATE ON patient_identifiers FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE patient_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_identifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_identifiers_tenant ON patient_identifiers FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
REVOKE ALL ON patient_identifiers FROM PUBLIC;
GRANT SELECT, INSERT ON patient_identifiers TO telesphoros_app;
GRANT UPDATE (status, withdrawn_by, withdrawn_at) ON patient_identifiers TO telesphoros_app;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- The decision that this report's exact file version belongs to this patient. A ledger record: append-only, one event each.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE report_patient_decisions (
  seq             bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  created_by      text NOT NULL,   -- the person who decided
  created_at      timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  report_id       uuid NOT NULL,
  patient_id      uuid NOT NULL,
  report_sha256   text NOT NULL,   -- the file the decision is about: its hash and its storage version
  object_version  text NOT NULL,
  decision        text NOT NULL,
  method          text NOT NULL,
  basis_code      text,
  identifier_id   uuid,
  CONSTRAINT report_patient_decisions_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT report_patient_decisions_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT report_patient_decisions_hash CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_patient_decisions_version_len CHECK (length(object_version) BETWEEN 1 AND 1024),
  CONSTRAINT report_patient_decisions_decision CHECK (decision IN ('verified', 'rejected')),
  CONSTRAINT report_patient_decisions_method CHECK (method IN ('identifier-match', 'person-confirmed')),
  -- The frozen vocabulary. A match is only ever a verification, names the identifier that matched and needs no stated reason; a person's own
  -- attestation always states a coded reason, from the list for the decision it supports. (IS NOT NULL is explicit: a NULL reason would make the
  -- whole expression NULL, and a CHECK accepts NULL.)
  CONSTRAINT report_patient_decisions_shape CHECK (
       (method = 'identifier-match' AND decision = 'verified' AND identifier_id IS NOT NULL AND basis_code IS NULL)
    OR (method = 'person-confirmed' AND identifier_id IS NULL AND basis_code IS NOT NULL AND (
         (decision = 'verified' AND basis_code IN ('no-identifier-on-report', 'identifier-not-registered', 'documented-clinic-procedure'))
      OR (decision = 'rejected' AND basis_code IN ('different-person', 'identifier-conflict', 'cannot-establish')))) ),
  CONSTRAINT report_patient_decisions_report_fk FOREIGN KEY (tenant_id, patient_id, report_id) REFERENCES reports (tenant_id, patient_id, id) ON DELETE RESTRICT,
  CONSTRAINT report_patient_decisions_identifier_fk FOREIGN KEY (identifier_id, tenant_id, patient_id) REFERENCES patient_identifiers (id, tenant_id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT report_patient_decisions_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT report_patient_decisions_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX report_patient_decisions_report_idx ON report_patient_decisions (tenant_id, report_id, seq);

-- A decision is about the report's file and patient AS THEY ARE NOW, and is made by someone who took no part in registering or uploading the
-- report (the service gives the clear answer first; this is the guarantee). The repository locks the report row for the writing transaction.
CREATE FUNCTION report_patient_decisions_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  r record;
  i record;
BEGIN
  SELECT created_by, upload_requested_by, uploaded_by, patient_id, sha256, object_version, uploaded_at, deleted_at INTO r
    FROM public.reports WHERE id = NEW.report_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR r.deleted_at IS NOT NULL OR r.uploaded_at IS NULL OR r.sha256 IS DISTINCT FROM NEW.report_sha256
     OR r.object_version IS DISTINCT FROM NEW.object_version OR r.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'A decision must be about the report''s current file and patient.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.created_by IN (r.created_by, r.upload_requested_by, r.uploaded_by) THEN
    RAISE EXCEPTION 'A report''s link is decided by someone other than the people who registered or uploaded it.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.method = 'identifier-match' THEN
    SELECT status, patient_id INTO i FROM public.patient_identifiers WHERE id = NEW.identifier_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR i.status <> 'active' OR i.patient_id <> NEW.patient_id THEN
      RAISE EXCEPTION 'A match must name an active identifier of this patient.' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION report_patient_decisions_check() FROM PUBLIC;
CREATE TRIGGER report_patient_decisions_check BEFORE INSERT ON report_patient_decisions FOR EACH ROW EXECUTE FUNCTION report_patient_decisions_check();

CREATE CONSTRAINT TRIGGER report_patient_decisions_has_event AFTER INSERT ON report_patient_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE TRIGGER report_patient_decisions_append_only BEFORE UPDATE OR DELETE ON report_patient_decisions FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER report_patient_decisions_no_truncate BEFORE TRUNCATE ON report_patient_decisions FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE report_patient_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_patient_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY report_patient_decisions_tenant ON report_patient_decisions FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY report_patient_decisions_ledger ON report_patient_decisions FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY report_patient_decisions_verifier ON report_patient_decisions FOR SELECT TO telesphoros_ledger_verifier USING (true);
REVOKE ALL ON report_patient_decisions FROM PUBLIC;
GRANT SELECT, INSERT ON report_patient_decisions TO telesphoros_app;
GRANT SELECT ON report_patient_decisions TO telesphoros_ledger, telesphoros_ledger_verifier;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- The ledger learns the new event type and the table it is about.
-- ---------------------------------------------------------------------------------------------------------------------------------
-- The ledger objects belong to the ledger role, so the migrator acts as it for these changes (the same way 0005, 0008 and 0011 do).
GRANT CREATE ON SCHEMA public TO telesphoros_ledger; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_ledger;

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_valid;
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_subject;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_valid CHECK (event_type IN
  ('capture', 'capture-decision', 'evaluation', 'correction', 'dispute', 'dispute-decision', 'patient-link-decision', 'redaction', 'checkpoint'));
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_subject CHECK (subject_table = CASE event_type
  WHEN 'capture'               THEN 'report_captures'
  WHEN 'capture-decision'      THEN 'capture_acceptances'
  WHEN 'evaluation'            THEN 'evaluations'
  WHEN 'correction'            THEN 'corrections'
  WHEN 'dispute'               THEN 'cell_disputes'
  WHEN 'dispute-decision'      THEN 'cell_dispute_decisions'
  WHEN 'patient-link-decision' THEN 'report_patient_decisions'
  WHEN 'redaction'             THEN 'event_notes'
  WHEN 'checkpoint'            THEN 'ledger_checkpoints'
END);

CREATE OR REPLACE FUNCTION ledger_event_row_exists() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ok boolean;
BEGIN
  CASE NEW.subject_table
    WHEN 'report_captures' THEN
      SELECT true INTO ok FROM public.report_captures r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'capture_acceptances' THEN
      SELECT true INTO ok FROM public.capture_acceptances r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'evaluations' THEN
      SELECT true INTO ok FROM public.evaluations r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'corrections' THEN
      SELECT true INTO ok FROM public.corrections r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'cell_disputes' THEN
      SELECT true INTO ok FROM public.cell_disputes r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'cell_dispute_decisions' THEN
      SELECT true INTO ok FROM public.cell_dispute_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'report_patient_decisions' THEN
      SELECT true INTO ok FROM public.report_patient_decisions r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'ledger_checkpoints' THEN
      SELECT true INTO ok FROM public.ledger_checkpoints r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.ledger_event_id = NEW.id AND r.created_by = NEW.actor_sub;
    WHEN 'event_notes' THEN
      -- A redaction event: the note exists in this tenant and is redacted by this very transaction.
      SELECT true INTO ok FROM public.event_notes r WHERE r.id = NEW.subject_id AND r.tenant_id = NEW.tenant_id AND r.redacted_at IS NOT NULL;
    ELSE
      ok := false;
  END CASE;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'A ledger event must describe an existing row of the same tenant, authored by the event actor.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_ledger;
