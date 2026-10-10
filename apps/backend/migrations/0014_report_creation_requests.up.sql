-- Retry identity is separate from editable metadata. Legacy rows remain unkeyed; no data is rewritten.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE reports
  ADD COLUMN creation_request_id uuid,
  ADD COLUMN creation_request_hash text,
  ADD CONSTRAINT reports_creation_request_pair CHECK (
    (creation_request_id IS NULL AND creation_request_hash IS NULL)
    OR (creation_request_id IS NOT NULL AND creation_request_hash IS NOT NULL
        AND creation_request_hash ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT reports_creation_request_uq UNIQUE (tenant_id, created_by, creation_request_id);

-- Soft deletion keeps the reservation. Existing tenant/creator guards protect the other key columns.
CREATE FUNCTION reports_creation_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.creation_request_id IS DISTINCT FROM OLD.creation_request_id
     OR NEW.creation_request_hash IS DISTINCT FROM OLD.creation_request_hash THEN
    RAISE EXCEPTION 'A report creation retry identity cannot be changed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION reports_creation_request_guard() FROM PUBLIC;
CREATE TRIGGER reports_creation_request_guard BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION reports_creation_request_guard();
