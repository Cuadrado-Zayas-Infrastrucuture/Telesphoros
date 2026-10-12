-- Local synthetic intake journal. No pin backfill or production activation.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE reports ADD COLUMN upload_revision uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE report_upload_runs (
 run_id uuid PRIMARY KEY, tenant_id text NOT NULL, reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes BETWEEN 0 AND 104857600),
 last_reconciled_at timestamptz, cleanup_stalled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,run_id)
);
ALTER TABLE report_upload_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_upload_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_run_tenant ON report_upload_runs USING(tenant_id = current_setting('app.current_tenant_id',true)) WITH CHECK(tenant_id = current_setting('app.current_tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON report_upload_runs TO telesphoros_app;
CREATE TABLE report_upload_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL, run_id uuid NOT NULL,
  tenant_id text NOT NULL, report_id uuid NOT NULL, patient_id uuid NOT NULL, principal text NOT NULL CHECK(length(principal) BETWEEN 1 AND 128),
  revision uuid NOT NULL, declaration_revision uuid NOT NULL, type text NOT NULL CHECK(type IN ('lab-pdf','vcf','structured')),
  size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760), content_type text NOT NULL CHECK(length(content_type) BETWEEN 1 AND 128),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), storage_key text NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 1024),
  state text NOT NULL CHECK(state IN ('declared','intaking','stored','unresolved','cancelling','cancelled','committed','cleanup','cleaned')),
  cancel_requested boolean NOT NULL DEFAULT false,
  validated boolean NOT NULL DEFAULT false,
  object_version text CHECK(object_version IS NULL OR (length(object_version) BETWEEN 1 AND 1024 AND object_version <> 'null')),
  writer uuid, lease_until timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upload_attempt_request_uq UNIQUE(tenant_id,report_id,principal,request_id),
  CONSTRAINT upload_attempt_key_uq UNIQUE(storage_key),
  CONSTRAINT upload_attempt_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES report_upload_runs(tenant_id,run_id) ON DELETE RESTRICT,
  CONSTRAINT upload_attempt_report_fk FOREIGN KEY(tenant_id,patient_id,report_id) REFERENCES reports(tenant_id,patient_id,id) ON DELETE RESTRICT,
  CONSTRAINT upload_attempt_committed_pin CHECK(state <> 'committed' OR (object_version IS NOT NULL AND writer IS NULL))
);
CREATE INDEX upload_attempt_run_idx ON report_upload_attempts(tenant_id,run_id,state);
ALTER TABLE report_upload_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_upload_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_attempt_tenant ON report_upload_attempts USING(tenant_id = current_setting('app.current_tenant_id',true)) WITH CHECK(tenant_id = current_setting('app.current_tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON report_upload_attempts TO telesphoros_app;
-- Keep attribution/identity immutable and terminal pins frozen even for table-owner writes.
CREATE FUNCTION upload_attempt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF (NEW.id,NEW.request_id,NEW.run_id,NEW.tenant_id,NEW.report_id,NEW.patient_id,NEW.principal,NEW.revision,NEW.declaration_revision,NEW.type,NEW.size_bytes,NEW.content_type,NEW.sha256,NEW.storage_key,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.request_id,OLD.run_id,OLD.tenant_id,OLD.report_id,OLD.patient_id,OLD.principal,OLD.revision,OLD.declaration_revision,OLD.type,OLD.size_bytes,OLD.content_type,OLD.sha256,OLD.storage_key,OLD.created_at)
 OR (OLD.state IN ('committed','cleaned') AND NEW IS DISTINCT FROM OLD)
 OR (OLD.validated AND NOT NEW.validated)
 OR (OLD.object_version IS NOT NULL AND NEW.object_version IS DISTINCT FROM OLD.object_version)
 OR (OLD.state = 'cleanup' AND NEW.state NOT IN ('cleanup','cleaned')) THEN
  RAISE EXCEPTION 'Upload attempt identity or terminal state cannot be changed.' USING ERRCODE='integrity_constraint_violation';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION upload_attempt_guard() FROM PUBLIC;
CREATE TRIGGER upload_attempt_guard BEFORE UPDATE ON report_upload_attempts FOR EACH ROW EXECUTE FUNCTION upload_attempt_guard();
CREATE FUNCTION reports_upload_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF OLD.uploaded_at IS NOT NULL AND NEW.type IS DISTINCT FROM OLD.type THEN
  RAISE EXCEPTION 'An uploaded report cannot change its type.' USING ERRCODE='integrity_constraint_violation';
 END IF;
 IF (NEW.type,NEW.storage_key,NEW.sha256,NEW.content_type) IS DISTINCT FROM (OLD.type,OLD.storage_key,OLD.sha256,OLD.content_type) THEN
  NEW.upload_revision := gen_random_uuid();
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION reports_upload_revision_guard() FROM PUBLIC;
CREATE TRIGGER reports_upload_revision_guard BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION reports_upload_revision_guard();
