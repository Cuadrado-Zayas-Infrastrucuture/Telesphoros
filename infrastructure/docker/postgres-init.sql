-- Local development only. Runs once when the Postgres container is first created.
-- Creates the application's login role. It is a MEMBER of telesphoros_app (the group the migrations
-- grant privileges to), is not a superuser and does not bypass row-level security, exactly as in production.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_app') THEN
    CREATE ROLE telesphoros_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telesphoros_app_user') THEN
    CREATE ROLE telesphoros_app_user LOGIN PASSWORD 'dev-only-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_app;
  END IF;
END
$$;
