-- Row-level security and least-privilege grants.
--
-- The application connects as a login role that is a MEMBER of `telesphoros_app` (the login role
-- and its password are provisioned outside this repository). It never owns the tables, is not a
-- superuser and does not have BYPASSRLS, so these policies bind it.
--
-- Every request runs inside a transaction that first sets `app.current_owner_id`
-- (see src/db/database.ts). If it is not set, current_setting(..., true) is NULL, the comparison
-- is never true, and the role sees no rows: the policy fails closed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_app') THEN
    CREATE ROLE telesphoros_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

ALTER TABLE patients        ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients        FORCE  ROW LEVEL SECURITY;
ALTER TABLE reports         ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports         FORCE  ROW LEVEL SECURITY;
ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations FORCE  ROW LEVEL SECURITY;

CREATE POLICY patients_owner ON patients FOR ALL TO telesphoros_app
  USING      (owner_id = current_setting('app.current_owner_id', true))
  WITH CHECK (owner_id = current_setting('app.current_owner_id', true));
CREATE POLICY reports_owner ON reports FOR ALL TO telesphoros_app
  USING      (owner_id = current_setting('app.current_owner_id', true))
  WITH CHECK (owner_id = current_setting('app.current_owner_id', true));
CREATE POLICY recommendations_owner ON recommendations FOR ALL TO telesphoros_app
  USING      (owner_id = current_setting('app.current_owner_id', true))
  WITH CHECK (owner_id = current_setting('app.current_owner_id', true));

-- No DELETE or TRUNCATE for the application: removal is soft (UPDATE deleted_at). Recommendations
-- are written only by the rules engine and are never updated.
REVOKE ALL ON patients, reports, recommendations FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO telesphoros_app;
GRANT SELECT, INSERT, UPDATE ON patients, reports TO telesphoros_app;
GRANT SELECT, INSERT ON recommendations TO telesphoros_app;
-- Lets the readiness probe see whether migrations are pending.
GRANT SELECT ON schema_migrations TO telesphoros_app;
