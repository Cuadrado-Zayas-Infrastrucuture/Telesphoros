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
# SAFETY: this cluster uses trust authentication and listens on 127.0.0.1 only. It is for
# disposable synthetic data on a developer machine, never for anything real.
set -euo pipefail

PORT="${PG_DEV_PORT:-54329}"
BIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "${BIN:-/nonexistent}/postgres" ] || { echo "PostgreSQL server binaries not found (set PGBIN)" >&2; exit 1; }

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

case "${1:-}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      as_pg mkdir -p "$DATA"
      as_pg "$BIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
    fi
    as_pg mkdir -p "$SOCKETS"
    if as_pg "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then echo "already running on port $PORT"; exit 0; fi
    # fsync off: this data is disposable, and tests run much faster.
    as_pg "$BIN/pg_ctl" -D "$DATA" -l "$LOG" -w -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$SOCKETS -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null
    echo "started: postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop)   as_pg "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 && echo stopped || echo "not running" ;;
  status) as_pg "$BIN/pg_ctl" -D "$DATA" status 2>&1 | head -1 ;;
  url)    echo "postgres://postgres@127.0.0.1:$PORT/postgres" ;;
  reset)  "$0" stop || true; rm -rf "$DATA"; echo "data removed" ;;
  *) echo "usage: $0 start|stop|status|url|reset" >&2; exit 2 ;;
esac
