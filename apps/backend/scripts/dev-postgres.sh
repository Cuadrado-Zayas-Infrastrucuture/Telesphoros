#!/usr/bin/env bash
# Throwaway local PostgreSQL for development and tests when Docker is not available.
# (With Docker, use infrastructure/docker/docker-compose.yml instead.)
#
#   scripts/dev-postgres.sh start    # create (first time) and start the cluster
#   scripts/dev-postgres.sh stop
#   scripts/dev-postgres.sh status
#   scripts/dev-postgres.sh url      # print the admin connection URL
#   scripts/dev-postgres.sh reset    # stop and delete all data
#
# SAFETY: this cluster checks passwords (scram-sha-256) exactly as CI's does, so the specs that expect a wrong password
# to be refused run for real. Its admin password is the well-known test value `postgres`, and it listens on 127.0.0.1
# only. It is for disposable synthetic data on a developer machine, never for anything real.
# macOS (Homebrew): PGBIN=/opt/homebrew/opt/postgresql@16/bin scripts/dev-postgres.sh start
set -euo pipefail
# initdb and the server need a UTF-8 locale in the environment; on macOS, without one the postmaster fails with
# "postmaster became multithreaded during startup".
export LC_ALL="${LC_ALL:-C.UTF-8}"

PORT="${PG_DEV_PORT:-54329}"
BIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "${BIN:-/nonexistent}/postgres" ] || { echo "PostgreSQL server binaries not found; set PGBIN to the directory holding postgres and initdb (Homebrew: /opt/homebrew/opt/postgresql@16/bin)" >&2; exit 1; }

if [ "$(id -u)" = "0" ]; then
  # PostgreSQL refuses to run as root; use the postgres OS user and its home directory.
  DATA="${PG_DEV_DATA:-/var/lib/postgresql/telesphoros-dev}"
  as_pg() { runuser -u postgres -- "$@"; }
else
  DATA="${PG_DEV_DATA:-$HOME/.local/share/telesphoros/pgdata}"
  as_pg() { "$@"; }
fi
SOCKETS="$DATA/sockets"
LOG="$DATA/postgres.log"
URL="postgres://postgres:postgres@127.0.0.1:$PORT/postgres"

case "${1:-}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      as_pg mkdir -p "$DATA"
      # The password goes through a file, never the command line; the file is the postgres user's and is removed at once.
      PWFILE="$(as_pg mktemp)"
      printf 'postgres\n' | as_pg tee "$PWFILE" >/dev/null
      as_pg "$BIN/initdb" -D "$DATA" -U postgres --auth=scram-sha-256 --pwfile="$PWFILE" --encoding=UTF8 --locale=C.UTF-8 >/dev/null || { as_pg rm -f "$PWFILE"; exit 1; }
      as_pg rm -f "$PWFILE"
    fi
    # A cluster made before passwords were checked would let the wrong-password specs connect and fail.
    if as_pg grep -Eq '^[[:space:]]*(local|host)[^#]*[[:space:]]trust([[:space:]]|$)' "$DATA/pg_hba.conf"; then
      echo "this cluster ($DATA) was created with trust authentication; run '$0 reset', then '$0 start'" >&2
      exit 1
    fi
    as_pg mkdir -p "$SOCKETS"
    if as_pg "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then echo "already running on port $PORT"; exit 0; fi
    # fsync off: this data is disposable, and tests run much faster.
    as_pg "$BIN/pg_ctl" -D "$DATA" -l "$LOG" -w -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$SOCKETS -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null
    echo "started: $URL"
    ;;
  stop)   as_pg "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 && echo stopped || echo "not running" ;;
  status) as_pg "$BIN/pg_ctl" -D "$DATA" status 2>&1 | head -1 ;;
  url)    echo "$URL" ;;
  reset)  "$0" stop || true; rm -rf "$DATA"; echo "data removed" ;;
  *) echo "usage: $0 start|stop|status|url|reset" >&2; exit 2 ;;
esac
