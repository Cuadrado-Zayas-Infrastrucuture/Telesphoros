-- Puts 'vcf' back in both report-type CHECKs, exactly as 0004 and 0015 defined them. Widening a CHECK cannot fail on existing rows.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE reports DROP CONSTRAINT reports_type_valid;
ALTER TABLE reports ADD CONSTRAINT reports_type_valid CHECK (type IN ('vcf', 'structured', 'lab-pdf'));
ALTER TABLE report_upload_attempts DROP CONSTRAINT report_upload_attempts_type_check;
ALTER TABLE report_upload_attempts ADD CONSTRAINT report_upload_attempts_type_check CHECK (type IN ('lab-pdf', 'vcf', 'structured'));
