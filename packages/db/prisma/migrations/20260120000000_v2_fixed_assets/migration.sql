-- V2 / milestone V2-M2: fixed-asset register and depreciation (DEC-058). Additive. Postings go through the PostingService only (journal sources
-- FIXED_ASSET_*); these tables hold the register, its bases, and the runs that explain the journals.

-- ───────── Classes ─────────
CREATE TABLE "fixed_asset_class" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cost_account_id" UUID NOT NULL,
    "depreciation_account_id" UUID NOT NULL,
    "expense_account_id" UUID NOT NULL,
    "disposal_account_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "life_months" INTEGER,
    "rate_percent" DECIMAL(7,4),
    "residual_percent" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "convention" TEXT NOT NULL DEFAULT 'MONTHLY',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fixed_asset_class_pkey" PRIMARY KEY ("id"),
    CONSTRAINT fac_code_ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
    CONSTRAINT fac_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT fac_method_ck CHECK ((method = 'STRAIGHT_LINE' AND life_months BETWEEN 1 AND 1200 AND rate_percent IS NULL) OR (method = 'REDUCING_BALANCE' AND rate_percent > 0 AND rate_percent < 100 AND life_months IS NULL)),
    CONSTRAINT fac_residual_ck CHECK (residual_percent >= 0 AND residual_percent < 100),
    CONSTRAINT fac_convention_ck CHECK (convention IN ('DAILY','MONTHLY')),
    CONSTRAINT fac_accounts_ck CHECK (cost_account_id <> depreciation_account_id AND expense_account_id <> disposal_account_id)
);
CREATE UNIQUE INDEX "fac_organisation_id_id_key" ON "fixed_asset_class"("organisation_id", "id");
CREATE UNIQUE INDEX "fac_company_code_key" ON "fixed_asset_class"("organisation_id", "company_id", "code");
ALTER TABLE "fixed_asset_class" ADD CONSTRAINT "fac_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fixed_asset_class" ADD CONSTRAINT "fac_cost_fkey" FOREIGN KEY ("organisation_id", "company_id", "cost_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset_class" ADD CONSTRAINT "fac_dep_fkey" FOREIGN KEY ("organisation_id", "company_id", "depreciation_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset_class" ADD CONSTRAINT "fac_exp_fkey" FOREIGN KEY ("organisation_id", "company_id", "expense_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset_class" ADD CONSTRAINT "fac_disp_fkey" FOREIGN KEY ("organisation_id", "company_id", "disposal_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset_class" ADD CONSTRAINT "fac_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The four accounts are of the right kind and are not control accounts; the class's accounts and code never move
CREATE OR REPLACE FUNCTION fac_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.code <> OLD.code
     OR NEW.cost_account_id <> OLD.cost_account_id OR NEW.depreciation_account_id <> OLD.depreciation_account_id OR NEW.expense_account_id <> OLD.expense_account_id
     OR NEW.disposal_account_id <> OLD.disposal_account_id OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'a class keeps its code and accounts; create a new class instead' USING ERRCODE = '42501';
  END IF;
  SELECT string_agg(r, '; ') INTO bad FROM (
    SELECT 'cost account must be a tangible or intangible fixed asset' r FROM account a WHERE a.id = NEW.cost_account_id AND NOT (a.type = 'ASSET' AND a.subtype IN ('FIXED_ASSET_TANGIBLE','FIXED_ASSET_INTANGIBLE'))
    UNION ALL SELECT 'depreciation account must be an accumulated depreciation account' FROM account a WHERE a.id = NEW.depreciation_account_id AND NOT (a.type = 'ASSET' AND a.subtype = 'FIXED_ASSET_DEPRECIATION')
    UNION ALL SELECT 'expense account must be a depreciation expense account' FROM account a WHERE a.id = NEW.expense_account_id AND NOT (a.type = 'EXPENSE' AND a.subtype = 'DEPRECIATION')
    UNION ALL SELECT 'disposal account must be an income or expense account' FROM account a WHERE a.id = NEW.disposal_account_id AND a.type NOT IN ('INCOME','EXPENSE')
    UNION ALL SELECT 'a fixed-asset class cannot use a control account' FROM account a WHERE a.id IN (NEW.cost_account_id, NEW.depreciation_account_id, NEW.expense_account_id, NEW.disposal_account_id) AND a.is_control
  ) x;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%', bad USING ERRCODE = '23514'; END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER fac_guard_trg BEFORE INSERT OR UPDATE ON fixed_asset_class FOR EACH ROW EXECUTE FUNCTION fac_guard();

-- ───────── Assets ─────────
CREATE TABLE "fixed_asset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "acquired_on" DATE NOT NULL,
    "in_use_from" DATE NOT NULL,
    "cost" DECIMAL(19,4) NOT NULL,
    "addition_kind" TEXT NOT NULL,
    "addition_journal_id" UUID,
    "offset_account_id" UUID,
    "take_on_date" DATE,
    "take_on_accumulated" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "addition_reversal_journal_id" UUID,
    "disposed_on" DATE,
    "proceeds" DECIMAL(19,4),
    "proceeds_account_id" UUID,
    "disposal_journal_id" UUID,
    "disposal_catch_up" DECIMAL(19,4),
    "disposal_accumulated" DECIMAL(19,4),
    "gain_or_loss" DECIMAL(19,4),
    "tax_category" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "tax_cost" DECIMAL(19,4),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fixed_asset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT fa_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),
    CONSTRAINT fa_cost_ck CHECK (cost > 0),
    CONSTRAINT fa_dates_ck CHECK (in_use_from >= acquired_on),
    CONSTRAINT fa_kind_ck CHECK (
      (addition_kind = 'POSTED' AND addition_journal_id IS NOT NULL AND offset_account_id IS NOT NULL AND take_on_date IS NULL AND take_on_accumulated = 0)
      OR (addition_kind = 'LINKED' AND addition_journal_id IS NOT NULL AND offset_account_id IS NULL AND take_on_date IS NULL AND take_on_accumulated = 0)
      OR (addition_kind = 'TAKE_ON' AND offset_account_id IS NULL AND take_on_date IS NOT NULL AND take_on_date >= in_use_from AND take_on_accumulated >= 0 AND take_on_accumulated < cost)),
    CONSTRAINT fa_status_ck CHECK (status IN ('ACTIVE','DISPOSED','VOID')),
    CONSTRAINT fa_void_ck CHECK ((status = 'VOID') = (addition_reversal_journal_id IS NOT NULL) AND (status <> 'VOID' OR addition_kind = 'POSTED')),
    CONSTRAINT fa_disposal_ck CHECK ((status = 'DISPOSED') = (disposed_on IS NOT NULL) AND (status = 'DISPOSED') = (disposal_journal_id IS NOT NULL)
      AND (disposed_on IS NULL OR (disposed_on >= in_use_from AND proceeds >= 0 AND disposal_catch_up >= 0 AND disposal_accumulated >= 0 AND gain_or_loss IS NOT NULL))
      AND (proceeds_account_id IS NULL OR proceeds > 0)),
    CONSTRAINT fa_tax_ck CHECK (tax_category IN ('AIA','MAIN_POOL','SPECIAL_RATE_POOL','SINGLE_ASSET_POOL','NOT_QUALIFYING','UNDECIDED') AND (tax_cost IS NULL OR tax_cost >= 0))
);
CREATE UNIQUE INDEX "fa_organisation_id_id_key" ON "fixed_asset"("organisation_id", "id");
CREATE UNIQUE INDEX "fa_company_number_key" ON "fixed_asset"("organisation_id", "company_id", "number");
CREATE INDEX "fa_class_idx" ON "fixed_asset"("organisation_id", "class_id");
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fa_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fa_class_fkey" FOREIGN KEY ("organisation_id", "class_id") REFERENCES "fixed_asset_class"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fa_addition_journal_fkey" FOREIGN KEY ("addition_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fa_addition_reversal_fkey" FOREIGN KEY ("addition_reversal_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fa_disposal_journal_fkey" FOREIGN KEY ("disposal_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fa_offset_fkey" FOREIGN KEY ("organisation_id", "company_id", "offset_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fa_proceeds_fkey" FOREIGN KEY ("organisation_id", "company_id", "proceeds_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fa_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- An asset's acquisition facts never change; ACTIVE -> DISPOSED | VOID, DISPOSED -> ACTIVE only by clearing the disposal (its mirror); VOID is final.
-- Only the tax fields move freely (they never feed depreciation, DEC-058).
CREATE OR REPLACE FUNCTION fa_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'a new asset is ACTIVE' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM fixed_asset_class c WHERE c.id = NEW.class_id AND c.company_id = NEW.company_id) THEN RAISE EXCEPTION 'the class belongs to another company' USING ERRCODE = '23514'; END IF;
    IF NEW.offset_account_id IS NOT NULL AND EXISTS (SELECT 1 FROM account a WHERE a.id = NEW.offset_account_id AND a.is_control) THEN RAISE EXCEPTION 'an addition cannot be funded from a control account' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.class_id <> OLD.class_id OR NEW.number <> OLD.number
     OR NEW.description <> OLD.description OR NEW.acquired_on <> OLD.acquired_on OR NEW.in_use_from <> OLD.in_use_from OR NEW.cost <> OLD.cost OR NEW.addition_kind <> OLD.addition_kind
     OR NEW.addition_journal_id IS DISTINCT FROM OLD.addition_journal_id OR NEW.offset_account_id IS DISTINCT FROM OLD.offset_account_id OR NEW.take_on_date IS DISTINCT FROM OLD.take_on_date
     OR NEW.take_on_accumulated <> OLD.take_on_accumulated OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an asset''s acquisition facts never change; reverse the addition or dispose of it instead' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'VOID' THEN RAISE EXCEPTION 'a void asset is final' USING ERRCODE = '42501'; END IF;
  IF OLD.status = 'DISPOSED' AND NEW.status = 'DISPOSED' AND (NEW.disposed_on IS DISTINCT FROM OLD.disposed_on OR NEW.proceeds IS DISTINCT FROM OLD.proceeds OR NEW.disposal_journal_id IS DISTINCT FROM OLD.disposal_journal_id
     OR NEW.gain_or_loss IS DISTINCT FROM OLD.gain_or_loss OR NEW.disposal_catch_up IS DISTINCT FROM OLD.disposal_catch_up OR NEW.disposal_accumulated IS DISTINCT FROM OLD.disposal_accumulated OR NEW.proceeds_account_id IS DISTINCT FROM OLD.proceeds_account_id) THEN
    RAISE EXCEPTION 'a disposal is reversed by its mirror, never edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'ACTIVE' AND NEW.status IN ('DISPOSED','VOID')) OR (OLD.status = 'DISPOSED' AND NEW.status = 'ACTIVE')) THEN
    RAISE EXCEPTION 'an asset moves ACTIVE -> DISPOSED or VOID, and back from DISPOSED only by reversing the disposal' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER fa_guard_trg BEFORE INSERT OR UPDATE ON fixed_asset FOR EACH ROW EXECUTE FUNCTION fa_guard();

-- ───────── Depreciation bases: append-only (prospective changes of estimate) ─────────
CREATE TABLE "fixed_asset_basis" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "carrying_amount" DECIMAL(19,4) NOT NULL,
    "accumulated_before" DECIMAL(19,4) NOT NULL,
    "method" TEXT NOT NULL,
    "life_months" INTEGER,
    "rate_percent" DECIMAL(7,4),
    "residual" DECIMAL(19,4) NOT NULL,
    "convention" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fixed_asset_basis_pkey" PRIMARY KEY ("id"),
    CONSTRAINT fab_method_ck CHECK ((method = 'STRAIGHT_LINE' AND life_months BETWEEN 1 AND 1200 AND rate_percent IS NULL) OR (method = 'REDUCING_BALANCE' AND rate_percent > 0 AND rate_percent < 100 AND life_months IS NULL)),
    CONSTRAINT fab_amounts_ck CHECK (carrying_amount >= 0 AND accumulated_before >= 0 AND residual >= 0 AND residual <= carrying_amount),
    CONSTRAINT fab_convention_ck CHECK (convention IN ('DAILY','MONTHLY')),
    CONSTRAINT fab_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE UNIQUE INDEX "fab_organisation_id_id_key" ON "fixed_asset_basis"("organisation_id", "id");
CREATE INDEX "fab_asset_idx" ON "fixed_asset_basis"("organisation_id", "asset_id", "effective_from");
ALTER TABLE "fixed_asset_basis" ADD CONSTRAINT "fab_asset_fkey" FOREIGN KEY ("organisation_id", "asset_id") REFERENCES "fixed_asset"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fixed_asset_basis" ADD CONSTRAINT "fab_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Never before the latest basis (the service starts a new one the day after the last charge, or on the same day when nothing was charged yet:
-- the latest basis by (effective_from, created_at) is current), and never for an asset that is not ACTIVE
CREATE OR REPLACE FUNCTION fab_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fixed_asset_basis b WHERE b.asset_id = NEW.asset_id AND b.organisation_id = NEW.organisation_id AND b.effective_from > NEW.effective_from) THEN
    RAISE EXCEPTION 'a change of estimate is prospective: it cannot start before the latest basis' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fixed_asset a WHERE a.id = NEW.asset_id AND a.status = 'ACTIVE') THEN RAISE EXCEPTION 'only an active asset is depreciated' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fab_guard_trg BEFORE INSERT ON fixed_asset_basis FOR EACH ROW EXECUTE FUNCTION fab_guard();
CREATE TRIGGER fab_no_mutation BEFORE UPDATE OR DELETE ON fixed_asset_basis FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fab_no_truncate BEFORE TRUNCATE ON fixed_asset_basis FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Depreciation runs ─────────
CREATE TABLE "depreciation_run" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "as_at" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "journal_id" UUID,
    "reversal_journal_id" UUID,
    "total" DECIMAL(19,4) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_reason" TEXT,
    CONSTRAINT "depreciation_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT dr_status_ck CHECK (status IN ('POSTED','REVERSED')),
    CONSTRAINT dr_total_ck CHECK (total >= 0 AND ((total = 0) = (journal_id IS NULL))),
    CONSTRAINT dr_reversal_ck CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL) AND (status = 'REVERSED') = (reversed_reason IS NOT NULL)
      AND (reversal_journal_id IS NULL OR status = 'REVERSED') AND (status <> 'REVERSED' OR journal_id IS NULL OR reversal_journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX "dr_organisation_id_id_key" ON "depreciation_run"("organisation_id", "id");
CREATE UNIQUE INDEX "dr_live_key" ON "depreciation_run"("organisation_id", "company_id", "as_at") WHERE status = 'POSTED';
ALTER TABLE "depreciation_run" ADD CONSTRAINT "dr_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "depreciation_run" ADD CONSTRAINT "dr_journal_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "depreciation_run" ADD CONSTRAINT "dr_reversal_journal_fkey" FOREIGN KEY ("reversal_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "depreciation_run" ADD CONSTRAINT "dr_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A run is later than every live run of the company; it is reversed once, and only while it is the latest live run
CREATE OR REPLACE FUNCTION dr_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'POSTED' THEN RAISE EXCEPTION 'a new run is POSTED' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM depreciation_run r WHERE r.company_id = NEW.company_id AND r.organisation_id = NEW.organisation_id AND r.status = 'POSTED' AND r.as_at >= NEW.as_at) THEN
      RAISE EXCEPTION 'a depreciation run must be later than every live run of the company' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.as_at <> OLD.as_at OR NEW.total <> OLD.total
     OR NEW.journal_id IS DISTINCT FROM OLD.journal_id OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at OR OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'a depreciation run is reversed by its mirror, never edited' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM depreciation_run r WHERE r.company_id = NEW.company_id AND r.organisation_id = NEW.organisation_id AND r.status = 'POSTED' AND r.as_at > NEW.as_at) THEN
    RAISE EXCEPTION 'only the latest live run can be reversed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dr_guard_trg BEFORE INSERT OR UPDATE ON depreciation_run FOR EACH ROW EXECUTE FUNCTION dr_guard();

CREATE TABLE "depreciation_run_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "accumulated_after" DECIMAL(19,4) NOT NULL,
    CONSTRAINT "depreciation_run_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT drl_amount_ck CHECK (amount > 0 AND accumulated_after >= amount)
);
CREATE UNIQUE INDEX "drl_organisation_id_id_key" ON "depreciation_run_line"("organisation_id", "id");
CREATE UNIQUE INDEX "drl_run_asset_key" ON "depreciation_run_line"("organisation_id", "run_id", "asset_id");
CREATE INDEX "drl_asset_idx" ON "depreciation_run_line"("organisation_id", "asset_id");
ALTER TABLE "depreciation_run_line" ADD CONSTRAINT "drl_run_fkey" FOREIGN KEY ("organisation_id", "run_id") REFERENCES "depreciation_run"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "depreciation_run_line" ADD CONSTRAINT "drl_asset_fkey" FOREIGN KEY ("organisation_id", "asset_id") REFERENCES "fixed_asset"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "depreciation_run_line" ADD CONSTRAINT "drl_class_fkey" FOREIGN KEY ("organisation_id", "class_id") REFERENCES "fixed_asset_class"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER drl_no_mutation BEFORE UPDATE OR DELETE ON depreciation_run_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER drl_no_truncate BEFORE TRUNCATE ON depreciation_run_line FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fixed_asset_class','fixed_asset','fixed_asset_basis','depreciation_run','depreciation_run_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "fixed_asset_basis", "depreciation_run_line" FROM uk_app;

-- ───────── Permissions (DEC-058) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['assets:read','assets:manage']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner','manager','accountant');
UPDATE "role" SET permissions = permissions || ARRAY['assets:read']::text[] WHERE organisation_id IS NULL AND key IN ('bookkeeper','reviewer');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
  ('TABLE', 'fixed_asset_class', 'ACCOUNTING_RECORDS'), ('TABLE', 'fixed_asset', 'ACCOUNTING_RECORDS'), ('TABLE', 'fixed_asset_basis', 'ACCOUNTING_RECORDS'),
  ('TABLE', 'depreciation_run', 'ACCOUNTING_RECORDS'), ('TABLE', 'depreciation_run_line', 'ACCOUNTING_RECORDS');
