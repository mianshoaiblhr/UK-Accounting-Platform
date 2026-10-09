#!/usr/bin/env bash
# Production migration runner. Intended to run as a ONE-OFF task (the `migrate` image) before each deployment.
#
#   MIGRATION_DATABASE_URL   owner/migrator connection (never the runtime uk_app role)
#   BACKUP_SNAPSHOT_ID       REQUIRED when any pending migration is marked destructive-approved
#
# Safety properties:
#   * Prisma takes a PostgreSQL advisory lock => two concurrent runners cannot both migrate (second waits/fails).
#   * lock_timeout/statement_timeout come from the migrator ROLE settings (infra/db/bootstrap.sql), so a migration
#     can never block production traffic indefinitely.
#   * Migrations run one at a time, each inside its own transaction; a failure leaves earlier migrations applied
#     and marks this one as failed in _prisma_migrations (see docs/runbooks/migrations.md for recovery).
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"
cd "$(dirname "$0")/../../packages/db"
PRISMA="npx prisma"

echo "== status before =="
$PRISMA migrate status || true   # exits non-zero when migrations are pending: that is expected here

PENDING=$($PRISMA migrate status 2>&1 | sed -n '/have not yet been applied/,$p' | grep -E '^[0-9]{14}_' || true)
if [ -n "$PENDING" ]; then
  echo "== pending migrations =="; echo "$PENDING"
  DESTRUCTIVE=""
  for m in $PENDING; do
    if grep -qiE '^--[[:space:]]*destructive-approved:' "prisma/migrations/$m/migration.sql"; then DESTRUCTIVE="$DESTRUCTIVE $m"; fi
  done
  FIRST=$(ls prisma/migrations | grep -E '^[0-9]{14}_' | sort | head -1)
  if [ -n "$DESTRUCTIVE" ] && echo "$PENDING" | grep -qx "$FIRST"; then
    # The very first migration is pending, so nothing has ever been applied: this is a brand-new, empty database
    # (Prisma refuses to run against a non-empty database without a baseline). There is no data to protect.
    echo "fresh database detected (no migration applied yet): no backup required for:$DESTRUCTIVE"
  elif [ -n "$DESTRUCTIVE" ]; then
    echo "!! destructive-approved migrations pending:$DESTRUCTIVE"
    : "${BACKUP_SNAPSHOT_ID:?A verified backup/snapshot id (BACKUP_SNAPSHOT_ID) is required before destructive migrations}"
    echo "backup recorded: $BACKUP_SNAPSHOT_ID"
  fi
fi

echo "== applying =="
$PRISMA migrate deploy
echo "== status after =="
$PRISMA migrate status
