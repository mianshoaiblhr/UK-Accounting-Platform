-- V2 / milestone V2-M3a: year-end adjustments (DEC-059). Additive. Accruals and accrued income (auto-reversed the next day), prepayments and
-- deferred income (released by schedule), provisions (made, used, released). Postings go through the PostingService only.

-- ───────── Items: accruals, accrued income, prepayments, deferred income ─────────
CREATE TABLE "year_end_item" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "pl_account_id" UUID NOT NULL,
    "balance_account_id" UUID NOT NULL,
    "item_date" DATE NOT NULL,
    "period_start" DATE,
    "period_end" DATE,
    "convention" TEXT,
    "setup_kind" TEXT,
    "setup_journal_id" UUID,
    "accrual_journal_id" UUID,
    "auto_reversal_journal_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cancellation_journal_ids" UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
    "cancelled_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_reason" TEXT,
    "basis" TEXT,
    "evidence_document_ids" UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "year_end_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT yei_kind_ck CHECK (kind IN ('ACCRUAL','ACCRUED_INCOME','PREPAYMENT','DEFERRED_INCOME')),
    CONSTRAINT yei_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),
    CONSTRAINT yei_amount_ck CHECK (amount > 0),
    CONSTRAINT yei_shape_ck CHECK (
      (kind IN ('ACCRUAL','ACCRUED_INCOME') AND period_start IS NULL AND period_end IS NULL AND convention IS NULL AND setup_kind IS NULL AND setup_journal_id IS NULL
        AND accrual_journal_id IS NOT NULL AND auto_reversal_journal_id IS NOT NULL)
      OR (kind IN ('PREPAYMENT','DEFERRED_INCOME') AND period_start IS NOT NULL AND period_end >= period_start AND convention IN ('DAILY','MONTHLY') AND setup_kind IN ('POSTED','LINKED')
        AND setup_journal_id IS NOT NULL AND accrual_journal_id IS NULL AND auto_reversal_journal_id IS NULL)),
    CONSTRAINT yei_status_ck CHECK (status IN ('ACTIVE','CANCELLED') AND (status = 'CANCELLED') = (cancelled_at IS NOT NULL) AND (status = 'CANCELLED') = (cancelled_reason IS NOT NULL))
);
CREATE UNIQUE INDEX "yei_organisation_id_id_key" ON "year_end_item"("organisation_id", "id");
CREATE INDEX "yei_company_idx" ON "year_end_item"("organisation_id", "company_id", "kind", "item_date");
ALTER TABLE "year_end_item" ADD CONSTRAINT "yei_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "year_end_item" ADD CONSTRAINT "yei_pl_fkey" FOREIGN KEY ("organisation_id", "company_id", "pl_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_item" ADD CONSTRAINT "yei_bal_fkey" FOREIGN KEY ("organisation_id", "company_id", "balance_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_item" ADD CONSTRAINT "yei_setup_fkey" FOREIGN KEY ("setup_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_item" ADD CONSTRAINT "yei_accrual_fkey" FOREIGN KEY ("accrual_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_item" ADD CONSTRAINT "yei_auto_fkey" FOREIGN KEY ("auto_reversal_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_item" ADD CONSTRAINT "yei_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The two accounts suit the kind and are never control accounts; an item's facts never change; ACTIVE -> CANCELLED once
CREATE OR REPLACE FUNCTION yei_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pl_type TEXT; bal_type TEXT; ctl BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'a new year-end item is ACTIVE' USING ERRCODE = '23514'; END IF;
    SELECT a.type::text INTO pl_type FROM account a WHERE a.id = NEW.pl_account_id;
    SELECT a.type::text INTO bal_type FROM account a WHERE a.id = NEW.balance_account_id;
    SELECT bool_or(a.is_control) INTO ctl FROM account a WHERE a.id IN (NEW.pl_account_id, NEW.balance_account_id);
    IF ctl THEN RAISE EXCEPTION 'a year-end item cannot use a control account' USING ERRCODE = '23514'; END IF;
    IF NOT ((NEW.kind = 'ACCRUAL' AND pl_type = 'EXPENSE' AND bal_type = 'LIABILITY') OR (NEW.kind = 'ACCRUED_INCOME' AND pl_type = 'INCOME' AND bal_type = 'ASSET')
         OR (NEW.kind = 'PREPAYMENT' AND pl_type = 'EXPENSE' AND bal_type = 'ASSET') OR (NEW.kind = 'DEFERRED_INCOME' AND pl_type = 'INCOME' AND bal_type = 'LIABILITY')) THEN
      RAISE EXCEPTION 'the accounts do not suit the % (P&L account %, balance account %)', lower(replace(NEW.kind, '_', ' ')), coalesce(pl_type, 'missing'), coalesce(bal_type, 'missing') USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'CANCELLED' OR NEW.status <> 'CANCELLED' OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.kind <> OLD.kind
     OR NEW.description <> OLD.description OR NEW.amount <> OLD.amount OR NEW.pl_account_id <> OLD.pl_account_id OR NEW.balance_account_id <> OLD.balance_account_id OR NEW.item_date <> OLD.item_date
     OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end OR NEW.convention IS DISTINCT FROM OLD.convention
     OR NEW.setup_kind IS DISTINCT FROM OLD.setup_kind OR NEW.setup_journal_id IS DISTINCT FROM OLD.setup_journal_id OR NEW.accrual_journal_id IS DISTINCT FROM OLD.accrual_journal_id
     OR NEW.auto_reversal_journal_id IS DISTINCT FROM OLD.auto_reversal_journal_id OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.evidence_document_ids <> OLD.evidence_document_ids
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a year-end item is cancelled once by its mirrors, never edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yei_guard_trg BEFORE INSERT OR UPDATE ON year_end_item FOR EACH ROW EXECUTE FUNCTION yei_guard();

-- ───────── Release runs (prepayments and deferred income) ─────────
CREATE TABLE "release_run" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "as_at" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "journal_id" UUID NOT NULL,
    "reversal_journal_id" UUID,
    "total" DECIMAL(19,4) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_reason" TEXT,
    CONSTRAINT "release_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT rr_status_ck CHECK (status IN ('POSTED','REVERSED') AND (status = 'REVERSED') = (reversal_journal_id IS NOT NULL) AND (status = 'REVERSED') = (reversed_at IS NOT NULL) AND (status = 'REVERSED') = (reversed_reason IS NOT NULL)),
    CONSTRAINT rr_total_ck CHECK (total > 0)
);
CREATE UNIQUE INDEX "rr_organisation_id_id_key" ON "release_run"("organisation_id", "id");
CREATE UNIQUE INDEX "rr_live_key" ON "release_run"("organisation_id", "company_id", "as_at") WHERE status = 'POSTED';
ALTER TABLE "release_run" ADD CONSTRAINT "rr_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "release_run" ADD CONSTRAINT "rr_journal_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_run" ADD CONSTRAINT "rr_reversal_fkey" FOREIGN KEY ("reversal_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_run" ADD CONSTRAINT "rr_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION rr_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'POSTED' THEN RAISE EXCEPTION 'a new release run is POSTED' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM release_run r WHERE r.company_id = NEW.company_id AND r.organisation_id = NEW.organisation_id AND r.status = 'POSTED' AND r.as_at >= NEW.as_at) THEN
      RAISE EXCEPTION 'a release run must be later than every live run of the company' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'REVERSED' OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.as_at <> OLD.as_at OR NEW.total <> OLD.total
     OR NEW.journal_id <> OLD.journal_id OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a release run is reversed by its mirror, never edited' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM release_run r WHERE r.company_id = NEW.company_id AND r.organisation_id = NEW.organisation_id AND r.status = 'POSTED' AND r.as_at > NEW.as_at) THEN
    RAISE EXCEPTION 'only the latest live release run can be reversed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rr_guard_trg BEFORE INSERT OR UPDATE ON release_run FOR EACH ROW EXECUTE FUNCTION rr_guard();

CREATE TABLE "release_run_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "released_after" DECIMAL(19,4) NOT NULL,
    CONSTRAINT "release_run_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT rrl_amount_ck CHECK (amount > 0 AND released_after >= amount)
);
CREATE UNIQUE INDEX "rrl_organisation_id_id_key" ON "release_run_line"("organisation_id", "id");
CREATE UNIQUE INDEX "rrl_run_item_key" ON "release_run_line"("organisation_id", "run_id", "item_id");
CREATE INDEX "rrl_item_idx" ON "release_run_line"("organisation_id", "item_id");
ALTER TABLE "release_run_line" ADD CONSTRAINT "rrl_run_fkey" FOREIGN KEY ("organisation_id", "run_id") REFERENCES "release_run"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_run_line" ADD CONSTRAINT "rrl_item_fkey" FOREIGN KEY ("organisation_id", "item_id") REFERENCES "year_end_item"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER rrl_no_mutation BEFORE UPDATE OR DELETE ON release_run_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER rrl_no_truncate BEFORE TRUNCATE ON release_run_line FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Provisions (FRS 102 s.21) ─────────
CREATE TABLE "provision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "expense_account_id" UUID NOT NULL,
    "basis" TEXT NOT NULL,
    "evidence_document_ids" UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT prov_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT prov_basis_ck CHECK (char_length(btrim(basis)) BETWEEN 3 AND 1000)
);
CREATE UNIQUE INDEX "prov_organisation_id_id_key" ON "provision"("organisation_id", "id");
ALTER TABLE "provision" ADD CONSTRAINT "prov_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provision" ADD CONSTRAINT "prov_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provision" ADD CONSTRAINT "prov_expense_fkey" FOREIGN KEY ("organisation_id", "company_id", "expense_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provision" ADD CONSTRAINT "prov_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION prov_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM account a WHERE a.id = NEW.account_id AND a.type = 'LIABILITY' AND NOT a.is_control) THEN RAISE EXCEPTION 'a provision sits on a non-control liability account' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM account a WHERE a.id = NEW.expense_account_id AND a.type = 'EXPENSE' AND NOT a.is_control) THEN RAISE EXCEPTION 'a provision is charged to an expense account' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prov_guard_trg BEFORE INSERT ON provision FOR EACH ROW EXECUTE FUNCTION prov_guard();
CREATE TRIGGER prov_no_mutation BEFORE UPDATE OR DELETE ON provision FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER prov_no_truncate BEFORE TRUNCATE ON provision FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE "provision_movement" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "provision_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "movement_date" DATE NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "offset_account_id" UUID,
    "reason" TEXT NOT NULL,
    "journal_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "reversal_journal_id" UUID,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provision_movement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT pm_kind_ck CHECK (kind IN ('MADE','USED','RELEASED') AND (kind = 'USED') = (offset_account_id IS NOT NULL)),
    CONSTRAINT pm_amount_ck CHECK (amount > 0),
    CONSTRAINT pm_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
    CONSTRAINT pm_status_ck CHECK (status IN ('POSTED','REVERSED') AND (status = 'REVERSED') = (reversal_journal_id IS NOT NULL) AND (status = 'REVERSED') = (reversed_at IS NOT NULL) AND (status = 'REVERSED') = (reversed_reason IS NOT NULL))
);
CREATE UNIQUE INDEX "pm_organisation_id_id_key" ON "provision_movement"("organisation_id", "id");
CREATE INDEX "pm_provision_idx" ON "provision_movement"("organisation_id", "provision_id", "movement_date");
ALTER TABLE "provision_movement" ADD CONSTRAINT "pm_provision_fkey" FOREIGN KEY ("organisation_id", "provision_id") REFERENCES "provision"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provision_movement" ADD CONSTRAINT "pm_offset_fkey" FOREIGN KEY ("organisation_id", "company_id", "offset_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provision_movement" ADD CONSTRAINT "pm_journal_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provision_movement" ADD CONSTRAINT "pm_reversal_fkey" FOREIGN KEY ("reversal_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provision_movement" ADD CONSTRAINT "pm_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Movements are dated in order; the balance never goes below zero; only the latest live movement is reversed, once; nothing is edited
CREATE OR REPLACE FUNCTION pm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal NUMERIC; delta NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'POSTED' THEN RAISE EXCEPTION 'a new movement is POSTED' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM provision p WHERE p.id = NEW.provision_id AND p.company_id = NEW.company_id) THEN RAISE EXCEPTION 'the provision belongs to another company' USING ERRCODE = '23514'; END IF;
    IF NEW.offset_account_id IS NOT NULL AND EXISTS (SELECT 1 FROM account a WHERE a.id = NEW.offset_account_id AND a.is_control) THEN RAISE EXCEPTION 'a provision is not used against a control account' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM provision_movement m WHERE m.provision_id = NEW.provision_id AND m.organisation_id = NEW.organisation_id AND m.status = 'POSTED' AND m.movement_date > NEW.movement_date) THEN
      RAISE EXCEPTION 'movements of a provision are recorded in date order' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(CASE WHEN m.kind = 'MADE' THEN m.amount ELSE -m.amount END), 0) INTO bal FROM provision_movement m WHERE m.provision_id = NEW.provision_id AND m.organisation_id = NEW.organisation_id AND m.status = 'POSTED';
    delta := CASE WHEN NEW.kind = 'MADE' THEN NEW.amount ELSE -NEW.amount END;
    IF bal + delta < 0 THEN RAISE EXCEPTION 'the provision cannot go below zero (balance %)', bal USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'REVERSED' OR NEW.status <> 'REVERSED' OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.provision_id <> OLD.provision_id OR NEW.kind <> OLD.kind
     OR NEW.movement_date <> OLD.movement_date OR NEW.amount <> OLD.amount OR NEW.offset_account_id IS DISTINCT FROM OLD.offset_account_id OR NEW.reason <> OLD.reason OR NEW.journal_id <> OLD.journal_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a provision movement is reversed once by its mirror, never edited' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM provision_movement m WHERE m.provision_id = NEW.provision_id AND m.organisation_id = NEW.organisation_id AND m.status = 'POSTED' AND m.id <> NEW.id
             AND (m.movement_date, m.created_at) > (NEW.movement_date, NEW.created_at)) THEN
    RAISE EXCEPTION 'only the latest live movement of a provision can be reversed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pm_guard_trg BEFORE INSERT OR UPDATE ON provision_movement FOR EACH ROW EXECUTE FUNCTION pm_guard();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['year_end_item','release_run','release_run_line','provision','provision_movement']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "release_run_line", "provision" FROM uk_app;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
  ('TABLE', 'year_end_item', 'ACCOUNTING_RECORDS'), ('TABLE', 'release_run', 'ACCOUNTING_RECORDS'), ('TABLE', 'release_run_line', 'ACCOUNTING_RECORDS'),
  ('TABLE', 'provision', 'ACCOUNTING_RECORDS'), ('TABLE', 'provision_movement', 'ACCOUNTING_RECORDS');
