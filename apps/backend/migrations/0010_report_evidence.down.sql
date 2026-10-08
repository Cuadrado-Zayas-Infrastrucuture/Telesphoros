-- GUARD: removes who uploaded a report and which stored version was verified. See 0005 for how to allow it on purpose.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM reports WHERE object_version IS NOT NULL OR uploaded_by IS NOT NULL OR upload_requested_by IS NOT NULL)
     AND current_setting('telesphoros.allow_audit_drop', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to drop report evidence columns that hold data: set telesphoros.allow_audit_drop=yes for this session if you really mean it.';
  END IF;
END $$;

DROP TRIGGER reports_evidence_guard ON reports;
DROP FUNCTION reports_evidence_guard();

CREATE OR REPLACE FUNCTION report_captures_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT type, sha256, uploaded_at INTO r FROM public.reports WHERE id = NEW.report_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;
  IF NOT FOUND OR r.type <> 'lab-pdf' OR r.uploaded_at IS NULL OR r.sha256 IS DISTINCT FROM NEW.pdf_sha256 THEN
    RAISE EXCEPTION 'A capture must belong to an uploaded lab PDF and carry its hash.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION capture_acceptances_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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

ALTER TABLE reports
  DROP CONSTRAINT reports_lab_pdf_pinned,
  DROP CONSTRAINT reports_pin_after_upload,
  DROP CONSTRAINT reports_uploaded_by_len,
  DROP CONSTRAINT reports_upload_requested_by_len,
  DROP CONSTRAINT reports_object_version_valid;
ALTER TABLE reports DROP COLUMN uploaded_by, DROP COLUMN upload_requested_by, DROP COLUMN object_version;
