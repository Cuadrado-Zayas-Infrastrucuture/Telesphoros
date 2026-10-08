-- Fails (on purpose) if a lab-pdf report exists: those rows are clinical history and are not rewritten.
ALTER TABLE reports DROP CONSTRAINT reports_type_valid;
ALTER TABLE reports ADD CONSTRAINT reports_type_valid CHECK (type IN ('vcf', 'structured'));
