-- A capture is one text read from one stored PDF; an acceptance is a person's decision about it (specification 3.2 and 3.3).
-- The text itself lives in object storage (its key and SHA-256 are recorded here). Both tables are append-only record tables:
-- each row has its own ledger event, committed in the same transaction.

CREATE TABLE report_captures (
  seq              bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ledger_event_id  uuid NOT NULL,
  report_id        uuid NOT NULL,
  pdf_sha256       text NOT NULL,
  text_storage_key text NOT NULL,
  text_sha256      text NOT NULL,
  text_scalars     integer NOT NULL,
  poppler_version  text NOT NULL,
  runner           text NOT NULL,
  CONSTRAINT report_captures_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT report_captures_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT report_captures_hashes CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$' AND text_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_captures_scalars CHECK (text_scalars BETWEEN 0 AND 100000),
  CONSTRAINT report_captures_poppler CHECK (poppler_version ~ '^[0-9]+(\.[0-9]+){1,3}$'),
  CONSTRAINT report_captures_runner CHECK (runner IN ('fake', 'poppler')),
  CONSTRAINT report_captures_key_len CHECK (length(text_storage_key) BETWEEN 1 AND 1024),
  CONSTRAINT report_captures_report_fk FOREIGN KEY (report_id, tenant_id) REFERENCES reports (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT report_captures_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  -- Capturing the same text again returns the existing row.
  CONSTRAINT report_captures_identity_uq UNIQUE (tenant_id, report_id, text_sha256, poppler_version),
  CONSTRAINT report_captures_text_key_uq UNIQUE (text_storage_key),
  CONSTRAINT report_captures_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX report_captures_tenant_report_idx ON report_captures (tenant_id, report_id, seq);
CREATE INDEX report_captures_report_idx ON report_captures (report_id);

CREATE TABLE capture_acceptances (
  seq             bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  created_by      text NOT NULL,            -- the reviewer
  created_at      timestamptz NOT NULL DEFAULT now(),
  ledger_event_id uuid NOT NULL,
  capture_id      uuid NOT NULL,
  decision        text NOT NULL,
  text_sha256     text NOT NULL,            -- copied from the capture and checked equal by a trigger
  poppler_version text NOT NULL,
  note_id         uuid,
  CONSTRAINT capture_acceptances_tenant_id_len CHECK (length(tenant_id) BETWEEN 1 AND 128),
  CONSTRAINT capture_acceptances_created_by_len CHECK (length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT capture_acceptances_decision CHECK (decision IN ('accepted', 'rejected')),
  CONSTRAINT capture_acceptances_text_hash CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT capture_acceptances_poppler CHECK (poppler_version ~ '^[0-9]+(\.[0-9]+){1,3}$'),
  CONSTRAINT capture_acceptances_capture_fk FOREIGN KEY (capture_id, tenant_id) REFERENCES report_captures (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT capture_acceptances_note_fk FOREIGN KEY (note_id, tenant_id) REFERENCES event_notes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT capture_acceptances_event_fk FOREIGN KEY (ledger_event_id, tenant_id)
    REFERENCES ledger_events (id, tenant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT capture_acceptances_id_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX capture_acceptances_tenant_capture_idx ON capture_acceptances (tenant_id, capture_id, seq);
CREATE INDEX capture_acceptances_capture_idx ON capture_acceptances (capture_id);

-- A capture belongs to a stored lab PDF, and says so truthfully.
CREATE FUNCTION report_captures_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT type, sha256, uploaded_at INTO r FROM public.reports WHERE id = NEW.report_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;
  IF NOT FOUND OR r.type <> 'lab-pdf' OR r.uploaded_at IS NULL OR r.sha256 IS DISTINCT FROM NEW.pdf_sha256 THEN
    RAISE EXCEPTION 'A capture must belong to an uploaded lab PDF and carry its hash.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_captures_check BEFORE INSERT ON report_captures FOR EACH ROW EXECUTE FUNCTION report_captures_check();

-- An acceptance repeats the capture's hash and Poppler version exactly, and the reviewer who ACCEPTS is not the person who uploaded the report
-- (separation of duties; the service checks first to give a clear message, this is the guarantee).
CREATE FUNCTION capture_acceptances_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record;
BEGIN
  SELECT c0.text_sha256, c0.poppler_version, r.created_by AS uploader INTO c
    FROM public.report_captures c0 JOIN public.reports r ON r.id = c0.report_id AND r.tenant_id = c0.tenant_id
   WHERE c0.id = NEW.capture_id AND c0.tenant_id = NEW.tenant_id;
  IF NOT FOUND OR c.text_sha256 <> NEW.text_sha256 OR c.poppler_version <> NEW.poppler_version THEN
    RAISE EXCEPTION 'An acceptance must repeat its capture''s text hash and Poppler version.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.decision = 'accepted' AND c.uploader = NEW.created_by THEN
    RAISE EXCEPTION 'A capture cannot be accepted by the person who uploaded the report.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_acceptances_check BEFORE INSERT ON capture_acceptances FOR EACH ROW EXECUTE FUNCTION capture_acceptances_check();

-- Each record is described by its own ledger event (checked at COMMIT, from the record's side).
CREATE CONSTRAINT TRIGGER report_captures_has_event AFTER INSERT ON report_captures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
CREATE CONSTRAINT TRIGGER capture_acceptances_has_event AFTER INSERT ON capture_acceptances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_row_has_event();
-- Append-only, tenant-scoped, readable by the ledger functions and the verifier.
CREATE TRIGGER report_captures_append_only BEFORE UPDATE OR DELETE ON report_captures FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER report_captures_no_truncate BEFORE TRUNCATE ON report_captures FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER capture_acceptances_append_only BEFORE UPDATE OR DELETE ON capture_acceptances FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
CREATE TRIGGER capture_acceptances_no_truncate BEFORE TRUNCATE ON capture_acceptances FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();

ALTER TABLE report_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_captures FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY report_captures_tenant ON report_captures FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY report_captures_ledger ON report_captures FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY report_captures_verifier ON report_captures FOR SELECT TO telesphoros_ledger_verifier USING (true);
CREATE POLICY capture_acceptances_tenant ON capture_acceptances FOR ALL TO telesphoros_app
  USING (tenant_id = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY capture_acceptances_ledger ON capture_acceptances FOR SELECT TO telesphoros_ledger USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY capture_acceptances_verifier ON capture_acceptances FOR SELECT TO telesphoros_ledger_verifier USING (true);

REVOKE ALL ON report_captures, capture_acceptances FROM PUBLIC;
GRANT SELECT, INSERT ON report_captures, capture_acceptances TO telesphoros_app;
GRANT SELECT ON report_captures, capture_acceptances TO telesphoros_ledger, telesphoros_ledger_verifier;
