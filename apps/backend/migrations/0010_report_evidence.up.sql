-- The stored file of a lab report is evidence: a capture, a reviewer's decision and an evaluation all rest on its exact bytes
-- (slice 5B-3.2a). This migration pins those bytes in the database itself, so no service, script or later feature has to remember to.
--
--   object_version        the storage version id of the verified object (the version, not just the key: a key can be overwritten)
--   upload_requested_by   who asked for the FIRST upload link (set once)
--   uploaded_by           who completed the upload (set once, with the hash)
-- Together with reports.created_by and the capture's creator, these are the four identities that cannot accept the capture.

ALTER TABLE reports
  ADD COLUMN object_version      text,
  ADD COLUMN upload_requested_by text,
  ADD COLUMN uploaded_by         text;

ALTER TABLE reports
  -- S3 reports the literal 'null' for an object written before versioning was enabled; that is NOT a version we can pin.
  ADD CONSTRAINT reports_object_version_valid CHECK (object_version IS NULL OR (length(object_version) BETWEEN 1 AND 1024 AND object_version <> 'null')),
  ADD CONSTRAINT reports_upload_requested_by_len CHECK (upload_requested_by IS NULL OR length(upload_requested_by) BETWEEN 1 AND 128),
  ADD CONSTRAINT reports_uploaded_by_len CHECK (uploaded_by IS NULL OR length(uploaded_by) BETWEEN 1 AND 128),
  ADD CONSTRAINT reports_pin_after_upload CHECK ((object_version IS NULL AND uploaded_by IS NULL) OR uploaded_at IS NOT NULL),
  -- A lab PDF is only "uploaded" with a pinned version and a named uploader.
  ADD CONSTRAINT reports_lab_pdf_pinned CHECK (type <> 'lab-pdf' OR uploaded_at IS NULL OR (object_version IS NOT NULL AND uploaded_by IS NOT NULL));

-- Rules about what may change, enforced where nothing can skip them.
--   1. Once uploaded, the file's identity (hash, key, version, type, size, time, uploader) can never change.
--   2. The first upload requester is set once.
--   3. Once any capture exists, the report's type, file name, patient and deletion mark are frozen as well.
-- (Rule 3 reads report_captures as the calling role, so it sees the captures the caller's tenant can see: every application path.)
CREATE FUNCTION reports_evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.upload_requested_by IS NOT NULL AND NEW.upload_requested_by IS DISTINCT FROM OLD.upload_requested_by THEN
    RAISE EXCEPTION 'The first upload requester of a report cannot be changed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.uploaded_at IS NOT NULL AND (
       NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.object_version IS DISTINCT FROM OLD.object_version
    OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by) THEN
    RAISE EXCEPTION 'The stored file of a report cannot be changed once it is uploaded.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.type IS DISTINCT FROM OLD.type OR NEW.original_filename IS DISTINCT FROM OLD.original_filename OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
      OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     AND EXISTS (SELECT 1 FROM public.report_captures c WHERE c.report_id = OLD.id AND c.tenant_id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'A report with a capture cannot change its type, file name, patient or deletion mark.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reports_evidence_guard BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION reports_evidence_guard();

-- A capture belongs to an uploaded, pinned, live lab PDF and carries its hash. The report row is locked FOR SHARE for the rest of the
-- capture's transaction: a concurrent change to the report waits for the capture to finish and is then refused by the guard above,
-- and a change that committed first is seen here (READ COMMITTED re-reads the locked row), so the capture is refused instead.
CREATE OR REPLACE FUNCTION report_captures_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT type, sha256, uploaded_at, object_version, deleted_at INTO r
    FROM public.reports WHERE id = NEW.report_id AND tenant_id = NEW.tenant_id FOR SHARE;
  IF NOT FOUND OR r.deleted_at IS NOT NULL OR r.type <> 'lab-pdf' OR r.uploaded_at IS NULL OR r.object_version IS NULL OR r.sha256 IS DISTINCT FROM NEW.pdf_sha256 THEN
    RAISE EXCEPTION 'A capture must belong to an uploaded, pinned lab PDF and carry its hash.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- An acceptance repeats the capture's hash and Poppler version, and whoever ACCEPTS is none of: the report's creator, the person who
-- asked for the first upload link, the person who completed the upload, the capture's creator (separation of duties; decision 12).
-- A rejection is open to anyone: it records disagreement and releases nothing.
CREATE OR REPLACE FUNCTION capture_acceptances_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record;
BEGIN
  SELECT c0.text_sha256, c0.poppler_version, c0.created_by AS capturer, r.created_by AS creator, r.upload_requested_by AS requester, r.uploaded_by AS uploader INTO c
    FROM public.report_captures c0 JOIN public.reports r ON r.id = c0.report_id AND r.tenant_id = c0.tenant_id
   WHERE c0.id = NEW.capture_id AND c0.tenant_id = NEW.tenant_id;
  IF NOT FOUND OR c.text_sha256 <> NEW.text_sha256 OR c.poppler_version <> NEW.poppler_version THEN
    RAISE EXCEPTION 'An acceptance must repeat its capture''s text hash and Poppler version.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.decision = 'accepted' AND NEW.created_by IN (c.capturer, c.creator, c.requester, c.uploader) THEN
    RAISE EXCEPTION 'A capture cannot be accepted by the person who created, uploaded or captured the report.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
