-- compat: breaking
-- The product does not store raw genomic data (founder decision, 2026-10-28: "we will not store raw data, for research purposes a curated database
-- has way more value"). A VCF upload was accepted and stored but never interpreted (M0.1 plan, I2); it is now refused. The two CHECKs that list
-- the report types lose 'vcf'; 'structured' (a curated JSON report) and 'lab-pdf' stay.
--
-- Existing data is never rewritten. Adding a CHECK validates every row, whatever row-level security would let the migrator see, so a database that
-- holds a VCF report or upload attempt refuses here and nothing changes. Nothing is deployed and every row is synthetic, so none is expected.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  ALTER TABLE reports DROP CONSTRAINT reports_type_valid;
  ALTER TABLE reports ADD CONSTRAINT reports_type_valid CHECK (type IN ('structured', 'lab-pdf'));
  ALTER TABLE report_upload_attempts DROP CONSTRAINT report_upload_attempts_type_check;
  ALTER TABLE report_upload_attempts ADD CONSTRAINT report_upload_attempts_type_check CHECK (type IN ('lab-pdf', 'structured'));
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'Refusing to remove the vcf report type: a VCF report or upload attempt exists. Nothing was changed; such rows are never rewritten.'
    USING ERRCODE = 'check_violation';
END $$;
