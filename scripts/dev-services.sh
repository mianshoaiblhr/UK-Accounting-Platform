#!/usr/bin/env bash
# Starts local PostgreSQL + Redis when Docker is unavailable (CI uses service containers instead).
# Idempotent. Usage: bash scripts/dev-services.sh
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=${PGDATA:-/tmp/pgdata}
if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  if [ ! -d "$PGDATA" ]; then
    mkdir -p "$PGDATA"; chown postgres "$PGDATA"
    su postgres -c "$PGBIN/initdb -D $PGDATA -A trust >/dev/null"
  fi
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p 5432 -c unix_socket_directories=/tmp' -l /tmp/pg.log start" >/dev/null
fi
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --port 6379 >/dev/null
for i in $(seq 1 20); do pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break; sleep 0.5; done
echo "postgres + redis ready"
