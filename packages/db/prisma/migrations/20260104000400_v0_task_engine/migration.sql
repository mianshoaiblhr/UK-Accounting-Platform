-- V0 Tranche A / increment 6: task engine remainder (specification V0 §5: reviewer, source, attachments, comments, reminders).
-- Additive and backward compatible: existing tasks keep working (no reviewer => no review step, source defaults to MANUAL).
-- New status value IN_REVIEW. A value added to an enum cannot be used in the same transaction, so every check below compares status::text.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'IN_REVIEW';

ALTER TABLE "task"
  ADD COLUMN "reviewer_user_id" UUID,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "source_id" TEXT;
ALTER TABLE "task" ADD CONSTRAINT task_source_ck CHECK (source IN ('MANUAL','WORKFLOW','AI_PROPOSAL','DOCUMENT','EVENT','SYSTEM'));
ALTER TABLE "task" ADD CONSTRAINT task_source_id_ck CHECK (source_id IS NULL OR char_length(source_id) BETWEEN 1 AND 200);
-- Segregation of duties: the person who does the work cannot also be its reviewer.
ALTER TABLE "task" ADD CONSTRAINT task_reviewer_not_assignee_ck CHECK (reviewer_user_id IS NULL OR assignee_user_id IS NULL OR reviewer_user_id <> assignee_user_id);
ALTER TABLE "task" ADD CONSTRAINT task_in_review_needs_reviewer_ck CHECK (status::text <> 'IN_REVIEW' OR reviewer_user_id IS NOT NULL);
CREATE INDEX "task_organisation_id_reviewer_user_id_idx" ON "task"("organisation_id", "reviewer_user_id");
CREATE INDEX "task_organisation_id_company_id_idx" ON "task"("organisation_id", "company_id");
-- Tenant-safe references to a task (composite) and the company link as a composite FK like every other company-owned table.
CREATE UNIQUE INDEX "task_organisation_id_id_key" ON "task"("organisation_id", "id");
ALTER TABLE "task" ADD CONSTRAINT "task_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The review rule is enforced by the database as well as the API: a task with a reviewer is completed only from IN_REVIEW and only by
-- that reviewer (the acting user comes from the tenant context). The reviewer cannot be swapped while the review is under way or after completion.
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
  IF NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id AND OLD.status::text IN ('IN_REVIEW','DONE') THEN
    RAISE EXCEPTION 'the reviewer cannot be changed while the task is in review or done' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_review_guard_trg BEFORE UPDATE ON "task" FOR EACH ROW EXECUTE FUNCTION task_review_guard();

-- ───────── Attachments: a task links to documents of the same company (or organisation-level documents for organisation-level tasks) ─────────
CREATE TABLE "task_attachment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_attachment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "task_attachment_task_id_document_id_key" ON "task_attachment"("task_id", "document_id");
CREATE INDEX "task_attachment_organisation_id_document_id_idx" ON "task_attachment"("organisation_id", "document_id");
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_organisation_id_task_id_fkey" FOREIGN KEY ("organisation_id", "task_id") REFERENCES "task"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_organisation_id_document_id_fkey" FOREIGN KEY ("organisation_id", "document_id") REFERENCES "document"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION task_attachment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t_company uuid; d_company uuid;
BEGIN
  SELECT company_id INTO t_company FROM task WHERE organisation_id = NEW.organisation_id AND id = NEW.task_id;
  SELECT company_id INTO d_company FROM document WHERE organisation_id = NEW.organisation_id AND id = NEW.document_id;
  IF t_company IS DISTINCT FROM d_company THEN
    RAISE EXCEPTION 'a task can only link documents of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_attachment_scope_trg BEFORE INSERT ON "task_attachment" FOR EACH ROW EXECUTE FUNCTION task_attachment_scope();

-- ───────── Comments: append-only conversation record ─────────
CREATE TABLE "task_comment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COMMENT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_comment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT task_comment_body_ck CHECK (char_length(btrim(body)) BETWEEN 1 AND 5000),
    CONSTRAINT task_comment_kind_ck CHECK (kind IN ('COMMENT','REVIEW_APPROVED','REVIEW_RETURNED'))
);
CREATE INDEX "task_comment_task_id_created_at_idx" ON "task_comment"("task_id", "created_at");
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_organisation_id_task_id_fkey" FOREIGN KEY ("organisation_id", "task_id") REFERENCES "task"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER task_comment_append_only BEFORE UPDATE OR DELETE ON "task_comment" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────── Reminders: scheduled in-app notifications, delivered by the worker's sweeper ─────────
CREATE TABLE "task_reminder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "remind_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    CONSTRAINT "task_reminder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT task_reminder_one_outcome_ck CHECK (sent_at IS NULL OR cancelled_at IS NULL)
);
CREATE INDEX "task_reminder_task_id_idx" ON "task_reminder"("task_id");
CREATE INDEX "task_reminder_due_idx" ON "task_reminder"("remind_at") WHERE sent_at IS NULL AND cancelled_at IS NULL;
ALTER TABLE "task_reminder" ADD CONSTRAINT "task_reminder_organisation_id_task_id_fkey" FOREIGN KEY ("organisation_id", "task_id") REFERENCES "task"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A reminder row changes once (pending -> sent | cancelled); its target and time are fixed after creation.
CREATE OR REPLACE FUNCTION task_reminder_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id <> OLD.task_id OR NEW.organisation_id <> OLD.organisation_id OR NEW.recipient_user_id <> OLD.recipient_user_id
     OR NEW.remind_at <> OLD.remind_at OR NEW.created_by_user_id <> OLD.created_by_user_id THEN
    RAISE EXCEPTION 'a reminder cannot be retargeted; cancel it and create a new one' USING ERRCODE = '42501';
  END IF;
  IF (OLD.sent_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL) AND (NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'a reminder that was sent or cancelled is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_reminder_guard_trg BEFORE UPDATE ON "task_reminder" FOR EACH ROW EXECUTE FUNCTION task_reminder_guard();

-- ───────── Row-level security (fail closed); the reminder sweeper additionally reads/updates due reminders as the trusted system context ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_attachment','task_comment','task_reminder']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
  END LOOP;
END $$;
CREATE POLICY system_select ON "task_reminder" FOR SELECT USING (app_system());
-- Least privilege. New tables are granted full DML to the runtime role by default privileges (20260101000100); narrow that to what each table needs.
REVOKE UPDATE, TRUNCATE ON "task_attachment" FROM uk_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "task_comment" FROM uk_app;
REVOKE DELETE, TRUNCATE ON "task_reminder" FROM uk_app;
