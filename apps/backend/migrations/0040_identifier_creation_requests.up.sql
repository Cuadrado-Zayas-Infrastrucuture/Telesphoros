-- compat: breaking
-- Audit item 25: POST /patients/:id/identifiers could not be retried. A retry of a registration that had succeeded answered 409 (the number is held), and the caller could not tell
-- that from a number held by someone else. Same cure as the report create (0014) and the patient create (0039): an optional retry identity per creator, with a fingerprint of the
-- original request (the patient, the assigning system and the keyed digest, never the value). Legacy rows are unkeyed and nothing is rewritten.
-- A CHECK, a UNIQUE constraint and a trigger on an existing table make this migration `breaking` under the lint: a release that includes it is a breaking release.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE patient_identifiers
  ADD COLUMN creation_request_id uuid,
  ADD COLUMN creation_request_hash text,
  ADD CONSTRAINT patient_identifiers_creation_request_pair CHECK (
    (creation_request_id IS NULL AND creation_request_hash IS NULL)
    OR (creation_request_id IS NOT NULL AND creation_request_hash IS NOT NULL
        AND creation_request_hash ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT patient_identifiers_creation_request_uq UNIQUE (tenant_id, created_by, creation_request_id);

-- The existing guard (0020) names the columns an update may not touch; this one covers the retry identity, which is set at insert and never changes.
CREATE FUNCTION patient_identifiers_creation_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.creation_request_id IS DISTINCT FROM OLD.creation_request_id
     OR NEW.creation_request_hash IS DISTINCT FROM OLD.creation_request_hash THEN
    RAISE EXCEPTION 'An identifier creation retry identity cannot be changed.' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION patient_identifiers_creation_request_guard() FROM PUBLIC;
CREATE TRIGGER patient_identifiers_creation_request_guard BEFORE UPDATE ON patient_identifiers
  FOR EACH ROW EXECUTE FUNCTION patient_identifiers_creation_request_guard();
