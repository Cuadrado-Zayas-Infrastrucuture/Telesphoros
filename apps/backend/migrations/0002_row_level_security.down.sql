REVOKE ALL ON patients, reports, recommendations FROM telesphoros_app;
REVOKE ALL ON schema_migrations FROM telesphoros_app;
DROP POLICY IF EXISTS recommendations_owner ON recommendations;
DROP POLICY IF EXISTS reports_owner ON reports;
DROP POLICY IF EXISTS patients_owner ON patients;
ALTER TABLE recommendations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE recommendations DISABLE ROW LEVEL SECURITY;
ALTER TABLE reports         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE reports         DISABLE ROW LEVEL SECURITY;
ALTER TABLE patients        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE patients        DISABLE ROW LEVEL SECURITY;
-- The telesphoros_app role is deliberately kept: roles are cluster-wide and may be shared.
