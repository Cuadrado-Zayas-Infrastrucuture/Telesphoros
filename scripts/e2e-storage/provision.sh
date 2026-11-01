#!/usr/bin/env bash
# Builds the disposable database the PostgreSQL browser suite (`pnpm --filter @telesphoros/frontend e2e:storage`) needs, from an empty server:
# the database, the migrations, a non-owner application login, the two organizations and the personas' memberships. It is the procedure of
# docs/ops/local-storage-browser.md ("Memberships") as one script, so the nightly workflow and a person run the same steps. Synthetic data only.
#
# Needs: E2E_OWNER_URL, the loopback superuser (or table owner) connection to the SERVER (any database, usually `postgres`), and a built backend
# (`pnpm --filter @telesphoros/backend build`), and E2E_ENV_FILE, a file to append the line `E2E_DATABASE_URL=...` to (in a workflow, "$GITHUB_ENV"; by
# hand, any file you then `source`). The URL carries the application login's throwaway password, so it goes to that file and is never printed.
# Refuses a database that already exists, a name or login the suite would reject, and a host that is not loopback: it creates a superuser-owned database and a role, which belongs only on a disposable server.
set -euo pipefail

DB="${E2E_DB_NAME:-synthetic_storage_nightly}"
APP_LOGIN="${E2E_APP_LOGIN:-e2e_storage_app}"
APP_PASSWORD="${E2E_APP_PASSWORD:-e2e-storage-synthetic}"

[ -n "${E2E_OWNER_URL:-}" ] || { echo "STOP: E2E_OWNER_URL is not set" >&2; exit 1; }
[ -n "${E2E_ENV_FILE:-}" ] || { echo "STOP: E2E_ENV_FILE is not set (the file that receives E2E_DATABASE_URL)" >&2; exit 1; }
[[ "$DB" =~ ^synthetic_storage_[a-z0-9_]+$ ]] || { echo "STOP: the database name must match synthetic_storage_<letters, digits, underscores> (the suite refuses any other)" >&2; exit 1; }
[[ "$APP_LOGIN" =~ ^[a-z][a-z0-9_]*$ && "$APP_LOGIN" != postgres ]] || { echo "STOP: the application login must be a plain lower-case name other than postgres" >&2; exit 1; }
[[ "$APP_PASSWORD" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "STOP: the throwaway password must be letters, digits, - or _" >&2; exit 1; }

# `node -e` rather than a shell parse of the URL: one reader of the host, port and user for the whole script. It must end its line, or `read` returns 1.
read -r HOST PORT OWNER_USER < <(node -e '
  const u = new URL(process.env.E2E_OWNER_URL);
  console.log([u.hostname, u.port || "5432", decodeURIComponent(u.username)].join(" "));
')
[ "$HOST" = 127.0.0.1 ] || { echo "STOP: the owner connection must be on 127.0.0.1 (found $HOST)" >&2; exit 1; }

# The same server, another database: swap only the path of the owner URL.
db_url() { node -e 'const u = new URL(process.env.E2E_OWNER_URL); u.pathname = "/" + process.argv[1]; process.stdout.write(u.toString());' "$1"; }
OWNER_DB_URL="$(db_url "$DB")"

# Reuse is refused: a database that already exists may hold rows from an earlier run, and the suite assumes it starts clean.
EXISTS="$(psql "$E2E_OWNER_URL" -v ON_ERROR_STOP=1 -Atc "SELECT 1 FROM pg_database WHERE datname = '$DB'" </dev/null)"
[ -z "$EXISTS" ] || { echo "STOP: database $DB already exists; drop it or set E2E_DB_NAME" >&2; exit 1; }
psql "$E2E_OWNER_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $DB" </dev/null

CLI="node apps/backend/dist/db/cli.js"
export DATABASE_MIGRATOR_URL="$OWNER_DB_URL"
$CLI migrate up </dev/null

# The login is created AFTER the migrations because the privilege role (telesphoros_app) is created by them. NOBYPASSRLS is the point: a login that
# bypasses row-level security would pass every tenant test whatever the policies did.
psql "$OWNER_DB_URL" -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE $APP_LOGIN LOGIN PASSWORD '$APP_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE telesphoros_app;
SQL
RLS="$(psql "$OWNER_DB_URL" -v ON_ERROR_STOP=1 -Atc "SELECT rolbypassrls::text || ',' || rolsuper::text FROM pg_roles WHERE rolname = '$APP_LOGIN'" </dev/null)"
[ "$RLS" = "false,false" ] || { echo "STOP: the application login is not a plain role (bypassrls,super = $RLS)" >&2; exit 1; }

# Since M2.1a a membership must name a registered organization.
$CLI tenant create --id alpha --name "Alpha synthetic clinic" --by browser-suite </dev/null
$CLI tenant create --id beta  --name "Beta synthetic clinic"  --by browser-suite </dev/null
grant() { $CLI membership grant --tenant "$1" --sub "$2" --roles "$3" --by browser-suite --reason "local acceptance persona" </dev/null; }
grant alpha 11111111-1111-4111-8111-111111111111 clinician            # alice
grant beta  22222222-2222-4222-8222-222222222222 reader               # bob
grant alpha 33333333-3333-4333-8333-333333333333 admin                # carol: administration only, refused the reports and the upload page
grant beta  44444444-4444-4444-8444-444444444444 ""                   # dave: signs in, holds no role
grant alpha 77777777-7777-4777-8777-777777777777 reviewer             # gina
grant alpha 88888888-8888-4888-8888-888888888888 clinician,reviewer   # hal
grant alpha 99999999-9999-4999-8999-999999999999 admin,reviewer       # ivy

# Read back from the database (as its owner) what the suite will rely on: seven active memberships in two organizations. A silent grant failure would
# otherwise show up as thirty confusing browser failures.
COUNTS="$(psql "$OWNER_DB_URL" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) || ',' || count(DISTINCT tenant_id) FROM tenant_memberships WHERE status = 'active'" </dev/null)"
[ "$COUNTS" = "7,2" ] || { echo "STOP: expected 7 active memberships in 2 organizations, found $COUNTS" >&2; exit 1; }

APP_URL="$(node -e '
  const u = new URL(process.env.E2E_OWNER_URL);
  u.username = process.argv[1]; u.password = process.argv[2]; u.pathname = "/" + process.argv[3];
  process.stdout.write(u.toString());
' "$APP_LOGIN" "$APP_PASSWORD" "$DB")"
echo "provisioned $DB on $HOST:$PORT (owner $OWNER_USER, application login $APP_LOGIN)" >&2
echo "E2E_DATABASE_URL=$APP_URL" >> "$E2E_ENV_FILE"
