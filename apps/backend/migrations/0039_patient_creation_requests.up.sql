-- compat: breaking
-- Audit item 25: POST /patients could not be retried. A retry of a create that had succeeded answered 409 (the label exists), and a clinician who then changed the label
-- made a second record for one person. Same cure as the report create (0014): an optional retry identity per creator, kept apart from the editable label. Legacy rows are
-- unkeyed and nothing is rewritten. The hash is of the original request, so the same id with a different body is refused rather than silently replayed.
-- It adds a CHECK, a UNIQUE constraint and a trigger to an existing table, which the lint classes as breaking (an older image does not know the id, but it refuses nothing
-- it did before; the class is about taking the constraint on a live table, so a release that includes this is a breaking release).
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE patients
  ADD COLUMN creation_request_id uuid,
  ADD COLUMN creation_request_hash text,
  ADD CONSTRAINT patients_creation_request_pair CHECK (
    (creation_request_id IS NULL AND creation_request_hash IS NULL)
    OR (creation_request_id IS NOT NULL AND creation_request_hash IS NOT NULL
        AND creation_request_hash ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT patients_creation_request_uq UNIQUE (tenant_id, created_by, creation_request_id);

-- Soft deletion keeps the reservation. The identity, once stored, is never changed.
CREATE FUNCTION patients_creation_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.creation_request_id IS DISTINCT FROM OLD.creation_request_id
     OR NEW.creation_request_hash IS DISTINCT FROM OLD.creation_request_hash THEN
    RAISE EXCEPTION 'A patient creation retry identity cannot be changed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION patients_creation_request_guard() FROM PUBLIC;
CREATE TRIGGER patients_creation_request_guard BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_creation_request_guard();
