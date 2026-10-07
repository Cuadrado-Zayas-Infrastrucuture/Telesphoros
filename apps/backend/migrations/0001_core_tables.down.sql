DROP TABLE IF EXISTS recommendations;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS patients;
DROP FUNCTION IF EXISTS block_report_soft_delete();
DROP FUNCTION IF EXISTS block_patient_soft_delete();
DROP FUNCTION IF EXISTS set_updated_at();
