-- A lab report arrives as a PDF. The database accepts the new type now; the API accepts it with the endpoints (slice 5B-3.2).
-- Existing rows are unaffected.
ALTER TABLE reports DROP CONSTRAINT reports_type_valid;
ALTER TABLE reports ADD CONSTRAINT reports_type_valid CHECK (type IN ('vcf', 'structured', 'lab-pdf'));
