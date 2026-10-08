# Production migration runbook

**Principle: migrations are additive and non-destructive by default.** Breaking changes use *expand → migrate → contract* across at least two releases. A CI test (`tests/unit/migrations.test.ts`) rejects `DROP TABLE/COLUMN`, column type changes, renames, `TRUNCATE` and `DELETE` unless the file carries a reviewed marker `-- destructive-approved: <ticket> backup-required`.

## 1. Execution
Migrations are an **application deployment step**, not a service start-up side effect.
1. CI builds the `migrate` image (same git SHA as api/worker).
2. The pipeline runs it as a one-off Fargate task (private subnets, `uk_migrator` credentials from the RDS-managed secret) **before** updating services:
   `infra/db/migrate.sh` → `prisma migrate status` → (destructive gate) → `prisma migrate deploy` → status.
3. Only if the task exits 0 does the pipeline roll out api/worker/web. Non-zero ⇒ deployment stops; the running version keeps serving (migrations are backward compatible with the previous release by rule).
Dry-run: `MIGRATION_DATABASE_URL=… prisma migrate status` shows what is pending. Staging always receives the migration first (and a restore of the latest prod snapshot is the pre-release rehearsal for any non-trivial migration).

## 2. Locking
- **Concurrency:** `prisma migrate deploy` takes a PostgreSQL advisory lock; a second concurrent runner waits and then no-ops. The pipeline additionally serialises the migrate task per environment.
- **Table locks:** the migrator role has `lock_timeout=10s` (`infra/db/bootstrap.sql`). A DDL statement that cannot get its lock fails fast instead of queueing behind long transactions and blocking all traffic. Write large changes as: `CREATE INDEX CONCURRENTLY` (in a dedicated non-transactional migration), `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT`, add-nullable-then-backfill-then-set-NOT-NULL.
- `statement_timeout=15min`, `idle_in_transaction_session_timeout=5min` bound runaway migrations.

## 3. Failed migration handling
Each migration file runs in a transaction; a failure rolls that file back and records it as failed in `_prisma_migrations`.
1. Stop the deployment (automatic). Production keeps running the previous release.
2. Read the task log for the SQL error (`lock_timeout` ⇒ retry off-peak; constraint violation ⇒ data fix needed).
3. Verify state: `prisma migrate status` and `SELECT migration_name, finished_at, logs FROM _prisma_migrations ORDER BY started_at DESC LIMIT 3`.
4. Fix **forward**: add a new migration or correct the data; if the failed file never applied any change, mark it rolled back — `prisma migrate resolve --rolled-back <name>` — then re-run. If it partially applied (non-transactional statements such as `CONCURRENTLY`), repair manually to the intended end state and `prisma migrate resolve --applied <name>`.
5. Never edit an applied migration file; never run `migrate dev/reset` against shared environments.
6. Post-incident note in the release log.

## 4. Rollback strategy
- **Application rollback is the primary lever:** ECS circuit breaker / redeploy previous image. Because every migration is additive and the previous release ignores new columns/tables, rolling the app back needs **no** database rollback.
- **Database rollback = roll forward.** Prisma has no down-migrations by design. For a bad *additive* migration, ship a corrective migration. For data corruption, use **point-in-time recovery** (RDS PITR, 35 days) into a new instance and cut over per `backup-restore.md`.
- Destructive steps are the last release of an expand/contract cycle, only after the code that used the old structure has been out for a full retention window.

## 5. Backups before destructive migrations
Required whenever a pending migration carries `-- destructive-approved:`:
1. Take a manual RDS snapshot (`aws rds create-db-snapshot`) **and** confirm the latest AWS Backup recovery point is < 24 h old.
2. Verify restorability for high-risk changes (restore to staging, run smoke checks).
3. Export the snapshot id to the pipeline as `BACKUP_SNAPSHOT_ID`. `infra/db/migrate.sh` **refuses to run** destructive migrations without it (verified), and records the id in the log.
4. Approval: DBA + engineering lead sign-off recorded in the ticket named in the marker.
5. Keep the snapshot for ≥ 30 days after the change.

## 6. Authoring checklist
Additive only · RLS enabled+forced for any new tenant table (the classification test fails otherwise) · register the table in `packages/db/src/classification.ts` · grants for `uk_app` · new permissions added to system roles by a **new** migration · update `docs/architecture/database-architecture.md`.
