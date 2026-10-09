-- V1 / milestone M2: ledger controls (ADR-49, DEC-012). Additive. Opening balances and control-account adjustments become REQUESTS that are
-- posted only through the PostingService after the configured approval; pending requests are not ledger entries.
-- Written for a non-superuser owner (ADR-27): data statements lift RLS on the specific table for this transaction only.

-- ───────── Journal requests ─────────
CREATE TABLE "journal_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "journal_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "lines" JSONB NOT NULL,
    "total" NUMERIC(19,4) NOT NULL,
    "evidence_document_ids" UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "approval_required" BOOLEAN NOT NULL,
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "policy_snapshot" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" TEXT,
    "posted_journal_id" UUID,
    CONSTRAINT "journal_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT journal_request_kind_ck CHECK (kind IN ('OPENING_BALANCE','CONTROL_ADJUSTMENT')),
    CONSTRAINT journal_request_status_ck CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
    CONSTRAINT journal_request_total_ck CHECK (total > 0),
    CONSTRAINT journal_request_reason_ck CHECK (char_length(btrim(reason)) >= 20),
    CONSTRAINT journal_request_lines_ck CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) >= 2),
    CONSTRAINT journal_request_expiry_ck CHECK (expires_at > requested_at),
    -- the outcome fields move together with the status
    CONSTRAINT journal_request_outcome_ck CHECK (
      (status = 'PENDING' AND decided_by_user_id IS NULL AND decided_at IS NULL AND posted_journal_id IS NULL)
      OR (status = 'APPROVED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND posted_journal_id IS NOT NULL)
      OR (status = 'REJECTED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND posted_journal_id IS NULL AND decision_reason IS NOT NULL)
      OR (status = 'CANCELLED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND posted_journal_id IS NULL)),
    -- second pair of eyes, enforced below the application: an approved request was decided by someone else, unless the policy exempted it
    CONSTRAINT journal_request_separation_ck CHECK (
      status <> 'APPROVED' OR (self_approved AND decided_by_user_id = requested_by_user_id AND NOT approval_required)
      OR (NOT self_approved AND decided_by_user_id <> requested_by_user_id)),
    CONSTRAINT journal_request_cancel_ck CHECK (status <> 'CANCELLED' OR decided_by_user_id = requested_by_user_id),
    CONSTRAINT journal_request_self_ck CHECK (NOT self_approved OR NOT approval_required)
);
CREATE UNIQUE INDEX "journal_request_organisation_id_id_key" ON "journal_request"("organisation_id", "id");
CREATE INDEX "journal_request_company_status_idx" ON "journal_request"("organisation_id", "company_id", "status", "requested_at");
ALTER TABLE "journal_request" ADD CONSTRAINT "journal_request_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_request" ADD CONSTRAINT "journal_request_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_request" ADD CONSTRAINT "journal_request_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Approval policy (per company; no row = defaults: approval always required) ─────────
CREATE TABLE "ledger_policy" (
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "opening_balance_approval" TEXT NOT NULL DEFAULT 'ALWAYS',
    "control_adjustment_approval" TEXT NOT NULL DEFAULT 'ALWAYS',
    "materiality_threshold" NUMERIC(19,4),
    "request_expiry_days" INTEGER NOT NULL DEFAULT 14,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_policy_pkey" PRIMARY KEY ("organisation_id", "company_id"),
    -- deliberately no 'NEVER': permission, reason, evidence and audit always apply
    CONSTRAINT ledger_policy_modes_ck CHECK (opening_balance_approval IN ('ALWAYS','ABOVE_THRESHOLD') AND control_adjustment_approval IN ('ALWAYS','ABOVE_THRESHOLD')),
    CONSTRAINT ledger_policy_threshold_ck CHECK (materiality_threshold IS NULL OR materiality_threshold > 0),
    CONSTRAINT ledger_policy_threshold_needed_ck CHECK ((opening_balance_approval <> 'ABOVE_THRESHOLD' AND control_adjustment_approval <> 'ABOVE_THRESHOLD') OR materiality_threshold IS NOT NULL),
    CONSTRAINT ledger_policy_expiry_ck CHECK (request_expiry_days BETWEEN 1 AND 90)
);
ALTER TABLE "ledger_policy" ADD CONSTRAINT "ledger_policy_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── Journals link to their request, requester and approver ─────────
ALTER TABLE "journal"
  ADD COLUMN "request_id" UUID,
  ADD COLUMN "requested_by_user_id" UUID,
  ADD COLUMN "approved_by_user_id" UUID;
CREATE UNIQUE INDEX "journal_request_id_key" ON "journal"("request_id") WHERE request_id IS NOT NULL;
ALTER TABLE "journal" ADD CONSTRAINT "journal_organisation_id_request_id_fkey" FOREIGN KEY ("organisation_id", "request_id") REFERENCES "journal_request"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- NOT VALID: applies to every new journal; journals posted before M2 (development data only) are not rescanned. Opening balances and control adjustments exist only through a request.
ALTER TABLE "journal" ADD CONSTRAINT journal_request_link_ck CHECK (
  ((request_id IS NULL) = (requested_by_user_id IS NULL) AND (request_id IS NULL) = (approved_by_user_id IS NULL))
  AND (source_type NOT IN ('OPENING_BALANCE','CONTROL_ADJUSTMENT') OR request_id IS NOT NULL)) NOT VALID;
ALTER TABLE "journal_request" ADD CONSTRAINT "journal_request_posted_journal_id_fkey" FOREIGN KEY ("posted_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal_request','ledger_policy']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
  END LOOP;
END $$;
REVOKE DELETE, TRUNCATE ON "journal_request" FROM uk_app;
REVOKE DELETE, TRUNCATE ON "ledger_policy" FROM uk_app;

-- ───────── Guards ─────────
-- A request's proposed content never changes; its status moves once, from PENDING to a final state, and APPROVED needs the posted journal to match.
CREATE OR REPLACE FUNCTION journal_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j RECORD;
BEGIN
  IF NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.kind <> OLD.kind OR NEW.journal_date <> OLD.journal_date OR NEW.description <> OLD.description
     OR NEW.reason <> OLD.reason OR NEW.currency <> OLD.currency OR NEW.lines <> OLD.lines OR NEW.total <> OLD.total OR NEW.evidence_document_ids IS DISTINCT FROM OLD.evidence_document_ids
     OR NEW.requested_by_user_id <> OLD.requested_by_user_id OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at OR NEW.approval_required <> OLD.approval_required
     OR NEW.self_approved <> OLD.self_approved OR NEW.policy_snapshot <> OLD.policy_snapshot OR NEW.content_hash <> OLD.content_hash THEN
    RAISE EXCEPTION 'the content of a journal request is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'PENDING' THEN RAISE EXCEPTION 'a decided journal request is final' USING ERRCODE = '42501'; END IF;
  IF NEW.status = 'PENDING' THEN RAISE EXCEPTION 'a pending journal request cannot be changed' USING ERRCODE = '42501'; END IF;
  IF NEW.status = 'APPROVED' THEN
    SELECT total, request_id, company_id INTO j FROM journal WHERE id = NEW.posted_journal_id AND organisation_id = NEW.organisation_id;
    IF NOT FOUND OR j.request_id IS DISTINCT FROM NEW.id OR j.total <> NEW.total OR j.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'an approved request must point at the journal posted from it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_request_guard_trg BEFORE UPDATE ON journal_request FOR EACH ROW EXECUTE FUNCTION journal_request_guard();
CREATE TRIGGER journal_request_no_delete BEFORE DELETE ON journal_request FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_request_no_truncate BEFORE TRUNCATE ON journal_request FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- The journal guard learns about requests: an opening balance or control adjustment needs a PENDING request of the same kind, company and total,
-- an approver who is not the requester (unless the policy exempted the request), and exactly one journal per request.
CREATE OR REPLACE FUNCTION journal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p RECORD; base CHAR(3); orig RECORD; r RECORD;
BEGIN
  IF coalesce(current_setting('app.posting', true), '') <> 'on' THEN
    RAISE EXCEPTION 'journals can only be posted through the PostingService' USING ERRCODE = '42501';
  END IF;
  -- FOR SHARE: a concurrent close/lock (an UPDATE of this row) waits for this posting to commit, so a journal cannot land in a period closed a moment earlier.
  SELECT status::text AS status, start_date, end_date INTO p FROM accounting_period WHERE id = NEW.period_id AND organisation_id = NEW.organisation_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'journal period does not belong to the company' USING ERRCODE = '23514'; END IF;
  IF p.status <> 'OPEN' THEN RAISE EXCEPTION 'the accounting period is % - posting requires an OPEN period', p.status USING ERRCODE = '23514'; END IF;
  IF NEW.journal_date < p.start_date OR NEW.journal_date > p.end_date THEN RAISE EXCEPTION 'journal date is outside its accounting period' USING ERRCODE = '23514'; END IF;
  SELECT base_currency INTO base FROM company WHERE id = NEW.company_id AND organisation_id = NEW.organisation_id;
  IF NEW.currency <> base THEN RAISE EXCEPTION 'journals are posted in the company base currency (%)', base USING ERRCODE = '23514'; END IF;
  IF NEW.reverses_journal_id IS NOT NULL THEN
    SELECT source_type, total, company_id INTO orig FROM journal WHERE id = NEW.reverses_journal_id AND organisation_id = NEW.organisation_id;
    IF NOT FOUND OR orig.company_id <> NEW.company_id THEN RAISE EXCEPTION 'reversed journal not found in this company' USING ERRCODE = '23514'; END IF;
    IF orig.source_type = 'REVERSAL' THEN RAISE EXCEPTION 'a reversal cannot itself be reversed' USING ERRCODE = '23514'; END IF;
    IF orig.total <> NEW.total THEN RAISE EXCEPTION 'a reversal must have the same total as the original' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.source_type IN ('OPENING_BALANCE','CONTROL_ADJUSTMENT') OR NEW.request_id IS NOT NULL THEN
    IF NEW.request_id IS NULL OR NEW.requested_by_user_id IS NULL OR NEW.approved_by_user_id IS NULL THEN
      RAISE EXCEPTION '% journals need an approved journal request', NEW.source_type USING ERRCODE = '23514';
    END IF;
    SELECT kind, status, company_id, total, requested_by_user_id, self_approved, journal_date, expires_at INTO r FROM journal_request WHERE id = NEW.request_id AND organisation_id = NEW.organisation_id FOR UPDATE;
    IF NOT FOUND OR r.company_id <> NEW.company_id OR r.status <> 'PENDING' OR r.kind <> NEW.source_type OR r.total <> NEW.total OR r.journal_date <> NEW.journal_date THEN
      RAISE EXCEPTION 'the journal does not match a pending journal request' USING ERRCODE = '23514';
    END IF;
    IF r.requested_by_user_id <> NEW.requested_by_user_id THEN RAISE EXCEPTION 'requester does not match the request' USING ERRCODE = '23514'; END IF;
    IF r.expires_at <= now() THEN RAISE EXCEPTION 'the journal request has expired' USING ERRCODE = '23514'; END IF;
    IF r.self_approved THEN
      IF NEW.approved_by_user_id <> NEW.requested_by_user_id THEN RAISE EXCEPTION 'a policy-exempt request is posted by its requester' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.approved_by_user_id = NEW.requested_by_user_id THEN
      RAISE EXCEPTION 'a request cannot be approved by the person who made it' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ───────── Evidence graph: journals can be evidence ends ─────────
ALTER TABLE "evidence_link" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "evidence_link" DROP CONSTRAINT evidence_link_source_type_ck, DROP CONSTRAINT evidence_link_target_type_ck;
ALTER TABLE "evidence_link"
  ADD CONSTRAINT evidence_link_source_type_ck CHECK (source_type IN ('document','document_version','task','workflow_instance','ai_proposal','contact','company','accounting_period','journal')),
  ADD CONSTRAINT evidence_link_target_type_ck CHECK (target_type IN ('document','document_version','task','workflow_instance','ai_proposal','contact','company','accounting_period','journal'));
ALTER TABLE "evidence_link" FORCE ROW LEVEL SECURITY;

-- ───────── System roles gain the four new COMPANY permissions ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['ledger:opening-balance','ledger:control-adjustment','ledger:approve','ledger:policy']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner');
UPDATE "role" SET permissions = permissions || ARRAY['ledger:control-adjustment']::text[] WHERE organisation_id IS NULL AND key = 'accountant';
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification of the new tables (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'journal_request', 'ACCOUNTING_RECORDS'), ('TABLE', 'ledger_policy', 'ACCOUNTING_RECORDS');
