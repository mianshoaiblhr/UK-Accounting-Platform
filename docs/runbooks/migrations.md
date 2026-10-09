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

### 4.1 Reversing the architecture change set (20260103*)
`docs/runbooks/rollback/20260103-architecture-change-set.down.sql` reverses migrations `20260103000000_v0_practice_and_company_roles` and `20260103000100_v0_workflow_and_ai_states` (renames, practice tables, per-company roles, workflow/AI columns, AI status mapping). It is **not** run automatically, refuses to run while the new roles or practice memberships are in use, and loses only data that has no representation in the old model (listed in the script header). `tests/db/upgrade.test.ts` proves it restores the previous schema *exactly* (columns, constraints, policies, triggers, enums, system roles). Remove the two rows from `_prisma_migrations` afterwards.

### 4.2 Owner role and row-level security
Tables use `FORCE ROW LEVEL SECURITY`, which also applies to the **table owner** (the migrator). A migration that inserts/updates/deletes data in a tenant table must lift RLS on that table for the migration's own transaction (`ALTER TABLE … NO FORCE ROW LEVEL SECURITY` … `FORCE ROW LEVEL SECURITY`) or the statements fail (INSERT) or silently affect zero rows (UPDATE/DELETE). `tests/db/upgrade.test.ts` applies every migration as a non-superuser owner to guard this.

## 5. Backups before destructive migrations
Required whenever a pending migration carries `-- destructive-approved:` (except on a brand-new, empty database - `migrate.sh` detects this because the first migration is still pending):
1. Take a manual RDS snapshot (`aws rds create-db-snapshot`) **and** confirm the latest AWS Backup recovery point is < 24 h old.
2. Verify restorability for high-risk changes (restore to staging, run smoke checks).
3. Export the snapshot id to the pipeline as `BACKUP_SNAPSHOT_ID`. `infra/db/migrate.sh` **refuses to run** destructive migrations without it (verified), and records the id in the log.
4. Approval: DBA + engineering lead sign-off recorded in the ticket named in the marker.
5. Keep the snapshot for ≥ 30 days after the change.

## 6. Authoring checklist
Additive only · RLS enabled+forced for any new tenant table (the classification test fails otherwise) · register the table in `packages/db/src/classification.ts` · grants for `uk_app` · new permissions added to system roles by a **new** migration · update `docs/architecture/database-architecture.md`.

## Tranche A migrations (V0 completion)
`20260104000000_v0_audit_framework` … `20260104000400_v0_task_engine` are additive. Notes for operators:
* **Forward-only items:** `20260104000400` adds the value `IN_REVIEW` to the `TaskStatus` enum. PostgreSQL cannot drop an enum value, so there is no down-script; rolling the *application* back is safe (older code never writes the new value, and tasks already `IN_REVIEW` remain readable as a string).
* **Existing rows:** tasks keep working (`source` defaults to `MANUAL`, no reviewer, no review step). The migration adds the composite foreign key `(organisation_id, company_id)` to `task`; it validates against existing rows, so check `SELECT count(*) FROM task t WHERE company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM company c WHERE c.organisation_id = t.organisation_id AND c.id = t.company_id)` returns 0 before the production run (the API has always checked this, so it is expected to be 0).
* **Verified by:** `tests/db/upgrade.test.ts` (populated database upgrade as a non-superuser owner).
