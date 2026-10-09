-- V0 pre-V1 bundle / S1 (V0-4.7): workflow deadlines and one-time overdue notification. Additive only.
--   due_at              deadline of the instance (set at start from the caller or the definition's SLA, or later through the API)
--   overdue_notified_at set, atomically with the notification, when the one-time overdue notification was delivered
--   overdue_attempts / overdue_retry_at / overdue_last_error   failure accounting for the sweeper (same model as task_reminder)
-- An instance is overdue when due_at < now() and completed_at IS NULL. No data statements and no new foreign keys: nothing to
-- backfill, existing instances simply have no deadline.
ALTER TABLE "workflow_instance"
  ADD COLUMN "due_at" TIMESTAMPTZ(3),
  ADD COLUMN "overdue_notified_at" TIMESTAMPTZ(3),
  ADD COLUMN "overdue_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "overdue_retry_at" TIMESTAMPTZ(3),
  ADD COLUMN "overdue_last_error" TEXT;

ALTER TABLE "workflow_instance" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_instance" ADD CONSTRAINT workflow_instance_overdue_attempts_ck CHECK (overdue_attempts >= 0);
ALTER TABLE "workflow_instance" FORCE ROW LEVEL SECURITY;

-- Sweeper: open instances with a deadline that have not been notified (and have not been abandoned).
CREATE INDEX "workflow_instance_overdue_due_idx" ON "workflow_instance"((coalesce(overdue_retry_at, due_at)))
  WHERE due_at IS NOT NULL AND completed_at IS NULL AND overdue_notified_at IS NULL;
-- Overdue filter / gauge.
CREATE INDEX "workflow_instance_due_at_idx" ON "workflow_instance"("organisation_id", "due_at") WHERE due_at IS NOT NULL AND completed_at IS NULL;

-- The trusted system context may READ workflow instances (the overdue sweeper lists candidates, the metrics gauge counts them); every
-- write still runs in the owning tenant's context. Same model as task_reminder.
CREATE POLICY system_select ON "workflow_instance" FOR SELECT USING (app_system());
