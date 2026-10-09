-- V0 Tranche A / increment 6 verification: findings F1 and F2.
--
-- F1  Append-only records were protected by triggers ONLY. Default privileges (20260101000100) give the runtime role full DML on every new
--     table, so audit_event kept UPDATE/DELETE and document_version kept DELETE. A trigger is the second line of defence; the first must be
--     the privilege itself. Revoke what the application never needs. (A table owner or superuser can still bypass triggers - that is why the
--     runtime role must never own tables; tests/db/privileges.test.ts asserts it.)
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_event" FROM uk_app;
REVOKE DELETE, TRUNCATE ON "document_version" FROM uk_app;

-- F2  A permanently failing reminder was retried on every sweep and, because due reminders are processed oldest first up to a batch size,
--     enough of them could starve newer reminders. Failures are now counted, backed off exponentially, and abandoned after a limit.
ALTER TABLE "task_reminder"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "retry_at" TIMESTAMPTZ(3);
ALTER TABLE "task_reminder" ADD CONSTRAINT task_reminder_attempts_ck CHECK (attempts >= 0);
DROP INDEX "task_reminder_due_idx";
CREATE INDEX "task_reminder_due_idx" ON "task_reminder"((coalesce(retry_at, remind_at))) WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- F3  The assignee must not be able to weaken their own review: removing or swapping the reviewer of a task you are assigned to
--     would let the doer approve their own work (clear the reviewer, then complete the task directly). Managers who are not the
--     assignee keep that authority (audited with before/after). Enforced here as well as in the API.
CREATE OR REPLACE FUNCTION task_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status::text = 'DONE' AND OLD.status::text <> 'DONE' AND NEW.reviewer_user_id IS NOT NULL THEN
    IF OLD.status::text <> 'IN_REVIEW' THEN
      RAISE EXCEPTION 'a task with a reviewer must be submitted for review before it can be completed' USING ERRCODE = '23514';
    END IF;
    IF app_user() IS DISTINCT FROM NEW.reviewer_user_id THEN
      RAISE EXCEPTION 'only the designated reviewer can complete a reviewed task' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id THEN
    IF OLD.status::text IN ('IN_REVIEW','DONE') THEN
      RAISE EXCEPTION 'the reviewer cannot be changed while the task is in review or done' USING ERRCODE = '23514';
    END IF;
    IF OLD.reviewer_user_id IS NOT NULL AND OLD.assignee_user_id IS NOT NULL AND app_user() = OLD.assignee_user_id THEN
      RAISE EXCEPTION 'the assignee cannot change or remove the reviewer of their own task' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
