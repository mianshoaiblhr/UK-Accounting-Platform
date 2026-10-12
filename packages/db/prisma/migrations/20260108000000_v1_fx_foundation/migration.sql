-- V1 / milestone M3: foreign-currency foundation (ADR-50, ADR-55; DEC-009, DEC-016..018). Additive.
-- Written for a non-superuser owner (ADR-27): data statements lift RLS on the specific table for this transaction only.

-- ───────── Exchange rates: tenant reference data, immutable except verification and supersession ─────────
CREATE TABLE "exchange_rate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "from_currency" CHAR(3) NOT NULL,
    "to_currency" CHAR(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    "rate" NUMERIC(19,8) NOT NULL,
    "source_kind" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "series" TEXT,
    "source_url" TEXT,
    "source_ref" TEXT,
    "retrieved_at" TIMESTAMPTZ(3),
    "entered_by_user_id" UUID NOT NULL,
    "import_batch_id" UUID,
    "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "superseded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exchange_rate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT exchange_rate_pair_ck CHECK (from_currency <> to_currency),
    CONSTRAINT exchange_rate_rate_ck CHECK (rate > 0),
    CONSTRAINT exchange_rate_kind_ck CHECK ((kind = 'DAILY' AND valid_from = valid_to) OR (kind = 'PERIOD' AND valid_to >= valid_from)),
    CONSTRAINT exchange_rate_source_kind_ck CHECK (source_kind IN ('MANUAL','IMPORT')),
    CONSTRAINT exchange_rate_manual_ck CHECK (source_kind <> 'MANUAL' OR (source_ref IS NOT NULL AND char_length(btrim(source_ref)) >= 3)),
    CONSTRAINT exchange_rate_import_ck CHECK (source_kind <> 'IMPORT' OR (retrieved_at IS NOT NULL AND import_batch_id IS NOT NULL)),
    CONSTRAINT exchange_rate_text_ck CHECK (char_length(publisher) BETWEEN 1 AND 100 AND (series IS NULL OR char_length(series) BETWEEN 1 AND 100) AND (source_url IS NULL OR char_length(source_url) <= 500) AND (source_ref IS NULL OR char_length(source_ref) <= 500)),
    CONSTRAINT exchange_rate_verification_ck CHECK (verification_status IN ('UNVERIFIED','VERIFIED') AND ((verification_status = 'VERIFIED') = (verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL)))
);
CREATE UNIQUE INDEX "exchange_rate_organisation_id_id_key" ON "exchange_rate"("organisation_id", "id");
CREATE UNIQUE INDEX "exchange_rate_current_uq" ON "exchange_rate"("organisation_id", "from_currency", "to_currency", "kind", "publisher", (coalesce("series", '')), "valid_from", "valid_to") WHERE "superseded_by_id" IS NULL;
CREATE INDEX "exchange_rate_lookup_idx" ON "exchange_rate"("organisation_id", "from_currency", "to_currency", "valid_from", "valid_to");
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_from_currency_fkey" FOREIGN KEY ("from_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_to_currency_fkey" FOREIGN KEY ("to_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- deferred: the superseded row is updated first, the superseding row inserted second, the reference is checked at commit
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "exchange_rate"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- ───────── Per-company FX settings: designated accounts and default series per currency ─────────
CREATE TABLE "company_fx_setting" (
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "rounding_account_id" UUID,
    "realised_account_id" UUID,
    "unrealised_account_id" UUID,
    "default_series" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_fx_setting_pkey" PRIMARY KEY ("organisation_id", "company_id"),
    CONSTRAINT company_fx_setting_distinct_ck CHECK (
      (rounding_account_id IS NULL OR rounding_account_id IS DISTINCT FROM realised_account_id) AND (rounding_account_id IS NULL OR rounding_account_id IS DISTINCT FROM unrealised_account_id)
      AND (realised_account_id IS NULL OR realised_account_id IS DISTINCT FROM unrealised_account_id)),
    CONSTRAINT company_fx_setting_series_ck CHECK (jsonb_typeof(default_series) = 'object')
);
ALTER TABLE "company_fx_setting" ADD CONSTRAINT "company_fx_setting_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_fx_setting" ADD CONSTRAINT "company_fx_setting_rounding_fkey" FOREIGN KEY ("organisation_id", "company_id", "rounding_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_fx_setting" ADD CONSTRAINT "company_fx_setting_realised_fkey" FOREIGN KEY ("organisation_id", "company_id", "realised_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_fx_setting" ADD CONSTRAINT "company_fx_setting_unrealised_fkey" FOREIGN KEY ("organisation_id", "company_id", "unrealised_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Revaluation runs: one row per revaluation journal and its auto-reversal ─────────
CREATE TABLE "fx_revaluation_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "as_at_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "revaluation_journal_id" UUID NOT NULL,
    "reversal_journal_id" UUID,
    "reversal_due_date" DATE NOT NULL,
    "net_adjustment" NUMERIC(19,4) NOT NULL,
    "rates" JSONB NOT NULL,
    "run_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ(3),
    CONSTRAINT "fx_revaluation_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT fx_revaluation_run_status_ck CHECK (status IN ('POSTED','REVERSED')),
    CONSTRAINT fx_revaluation_run_reversal_ck CHECK ((status = 'REVERSED') = (reversal_journal_id IS NOT NULL AND reversed_at IS NOT NULL)),
    CONSTRAINT fx_revaluation_run_due_ck CHECK (reversal_due_date > as_at_date)
);
CREATE UNIQUE INDEX "fx_revaluation_run_journal_uq" ON "fx_revaluation_run"("revaluation_journal_id");
CREATE INDEX "fx_revaluation_run_company_idx" ON "fx_revaluation_run"("organisation_id", "company_id", "period_id", "created_at");
CREATE INDEX "fx_revaluation_run_due_idx" ON "fx_revaluation_run"("status", "reversal_due_date");
ALTER TABLE "fx_revaluation_run" ADD CONSTRAINT "fx_revaluation_run_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fx_revaluation_run" ADD CONSTRAINT "fx_revaluation_run_period_fkey" FOREIGN KEY ("organisation_id", "period_id") REFERENCES "accounting_period"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fx_revaluation_run" ADD CONSTRAINT "fx_revaluation_run_journal_fkey" FOREIGN KEY ("organisation_id", "revaluation_journal_id") REFERENCES "journal"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fx_revaluation_run" ADD CONSTRAINT "fx_revaluation_run_reversal_fkey" FOREIGN KEY ("organisation_id", "reversal_journal_id") REFERENCES "journal"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fx_revaluation_run" ADD CONSTRAINT "fx_revaluation_run_user_fkey" FOREIGN KEY ("run_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Policy: optionally refuse postings that would use an UNVERIFIED rate ─────────
ALTER TABLE "ledger_policy" ADD COLUMN "fx_block_unverified_rates" BOOLEAN NOT NULL DEFAULT false;

-- ───────── Journal lines: original-currency values (ADR-55) ─────────
ALTER TABLE "journal_line"
  ADD COLUMN "original_currency" CHAR(3),
  ADD COLUMN "original_debit" NUMERIC(19,4),
  ADD COLUMN "original_credit" NUMERIC(19,4),
  ADD COLUMN "rate" NUMERIC(19,8),
  ADD COLUMN "exchange_rate_id" UUID,
  ADD COLUMN "adjusts_currency" CHAR(3);
ALTER TABLE "journal_line"
  ADD CONSTRAINT journal_line_original_all_or_none_ck CHECK (
    (original_currency IS NULL AND original_debit IS NULL AND original_credit IS NULL AND rate IS NULL AND exchange_rate_id IS NULL)
    OR (original_currency IS NOT NULL AND original_debit IS NOT NULL AND original_credit IS NOT NULL AND rate IS NOT NULL AND exchange_rate_id IS NOT NULL)),
  ADD CONSTRAINT journal_line_original_amount_ck CHECK (
    original_currency IS NULL OR (original_debit >= 0 AND original_credit >= 0 AND ((original_debit > 0) <> (original_credit > 0)) AND rate > 0 AND ((original_debit > 0) = (debit > 0)))),
  -- a functional-only adjustment line (revaluation) belongs to the foreign-currency balance of its account; it cannot also carry original amounts
  ADD CONSTRAINT journal_line_adjusts_ck CHECK (adjusts_currency IS NULL OR original_currency IS NULL);
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_original_currency_fkey" FOREIGN KEY ("original_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_adjusts_currency_fkey" FOREIGN KEY ("adjusts_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_exchange_rate_fkey" FOREIGN KEY ("organisation_id", "exchange_rate_id") REFERENCES "exchange_rate"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "journal_line_fx_idx" ON "journal_line"("organisation_id", "company_id", "account_id", "original_currency") WHERE original_currency IS NOT NULL;

-- The line guard now also proves the conversion: the functional amount is exactly round(original x rate) in the functional currency's minor units,
-- the rate is the stored rate row for that currency pair and not dated after the journal, and the original amount respects its own currency's minor units.
CREATE OR REPLACE FUNCTION journal_line_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j RECORD; a RECORD; minor INTEGER; ominor INTEGER; r RECORD;
BEGIN
  IF coalesce(current_setting('app.posting', true), '') <> 'on' THEN
    RAISE EXCEPTION 'journal lines can only be posted through the PostingService' USING ERRCODE = '42501';
  END IF;
  SELECT journal_date, currency, xmin::text AS x INTO j FROM journal WHERE id = NEW.journal_id AND organisation_id = NEW.organisation_id;
  IF NOT FOUND OR j.x <> (txid_current() % 4294967296)::text THEN
    RAISE EXCEPTION 'lines can only be added in the transaction that posts their journal' USING ERRCODE = '42501';
  END IF;
  SELECT active_from, active_to INTO a FROM account WHERE id = NEW.account_id AND organisation_id = NEW.organisation_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'account not found in this company' USING ERRCODE = '23514'; END IF;
  IF (a.active_from IS NOT NULL AND j.journal_date < a.active_from) OR (a.active_to IS NOT NULL AND j.journal_date > a.active_to) THEN
    RAISE EXCEPTION 'account is not active on the journal date' USING ERRCODE = '23514';
  END IF;
  SELECT minor_units INTO minor FROM currency WHERE code = j.currency;
  IF NEW.debit <> round(NEW.debit, minor) OR NEW.credit <> round(NEW.credit, minor) THEN
    RAISE EXCEPTION 'amount has more decimal places than the currency allows (%)', minor USING ERRCODE = '23514';
  END IF;
  IF NEW.adjusts_currency IS NOT NULL AND NEW.adjusts_currency = j.currency THEN
    RAISE EXCEPTION 'an FX adjustment line names a foreign currency' USING ERRCODE = '23514';
  END IF;
  IF NEW.original_currency IS NOT NULL THEN
    IF NEW.original_currency = j.currency THEN RAISE EXCEPTION 'original currency must differ from the functional currency' USING ERRCODE = '23514'; END IF;
    SELECT minor_units INTO ominor FROM currency WHERE code = NEW.original_currency;
    IF NEW.original_debit <> round(NEW.original_debit, ominor) OR NEW.original_credit <> round(NEW.original_credit, ominor) THEN
      RAISE EXCEPTION 'original amount has more decimal places than % allows (%)', NEW.original_currency, ominor USING ERRCODE = '23514';
    END IF;
    SELECT from_currency, to_currency, rate, valid_from INTO r FROM exchange_rate WHERE id = NEW.exchange_rate_id AND organisation_id = NEW.organisation_id;
    IF NOT FOUND OR r.from_currency <> NEW.original_currency OR r.to_currency <> j.currency OR r.rate <> NEW.rate THEN
      RAISE EXCEPTION 'the line rate is not the stored exchange rate for this currency pair' USING ERRCODE = '23514';
    END IF;
    IF r.valid_from > j.journal_date THEN RAISE EXCEPTION 'an exchange rate dated after the journal cannot be used' USING ERRCODE = '23514'; END IF;
    IF NEW.debit <> round(NEW.original_debit * NEW.rate, minor) OR NEW.credit <> round(NEW.original_credit * NEW.rate, minor) THEN
      RAISE EXCEPTION 'functional amount is not the original amount converted at the line rate' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ───────── The functional currency cannot change once a journal exists ─────────
CREATE OR REPLACE FUNCTION company_base_currency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency AND EXISTS (SELECT 1 FROM journal WHERE company_id = OLD.id AND organisation_id = OLD.organisation_id) THEN
    RAISE EXCEPTION 'the functional currency cannot change once the company has journals' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_base_currency_guard_trg BEFORE UPDATE OF base_currency ON company FOR EACH ROW EXECUTE FUNCTION company_base_currency_guard();

-- ───────── Immutability: rates change only by verification or supersession; runs only by their reversal ─────────
CREATE OR REPLACE FUNCTION exchange_rate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.from_currency <> OLD.from_currency OR NEW.to_currency <> OLD.to_currency OR NEW.kind <> OLD.kind
     OR NEW.valid_from <> OLD.valid_from OR NEW.valid_to <> OLD.valid_to OR NEW.rate <> OLD.rate OR NEW.source_kind <> OLD.source_kind OR NEW.publisher <> OLD.publisher
     OR NEW.series IS DISTINCT FROM OLD.series OR NEW.source_url IS DISTINCT FROM OLD.source_url OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.retrieved_at IS DISTINCT FROM OLD.retrieved_at
     OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an exchange rate is immutable; supersede it with a new rate' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
    IF OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status <> 'VERIFIED' THEN RAISE EXCEPTION 'a rate is verified once, and verification is not withdrawn' USING ERRCODE = '42501'; END IF;
  ELSIF NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'verification details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'a rate is superseded once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exchange_rate_guard_trg BEFORE UPDATE ON exchange_rate FOR EACH ROW EXECUTE FUNCTION exchange_rate_guard();
CREATE TRIGGER exchange_rate_no_delete BEFORE DELETE ON exchange_rate FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER exchange_rate_no_truncate BEFORE TRUNCATE ON exchange_rate FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION fx_revaluation_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.period_id <> OLD.period_id OR NEW.as_at_date <> OLD.as_at_date
     OR NEW.revaluation_journal_id <> OLD.revaluation_journal_id OR NEW.reversal_due_date <> OLD.reversal_due_date OR NEW.net_adjustment <> OLD.net_adjustment OR NEW.rates <> OLD.rates
     OR NEW.run_by_user_id <> OLD.run_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a revaluation run is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'POSTED' OR NEW.status <> 'REVERSED' THEN RAISE EXCEPTION 'a run moves once, from POSTED to REVERSED' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fx_revaluation_run_guard_trg BEFORE UPDATE ON fx_revaluation_run FOR EACH ROW EXECUTE FUNCTION fx_revaluation_run_guard();
CREATE TRIGGER fx_revaluation_run_no_delete BEFORE DELETE ON fx_revaluation_run FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fx_revaluation_run_no_truncate BEFORE TRUNCATE ON fx_revaluation_run FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['exchange_rate','company_fx_setting','fx_revaluation_run']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
  END LOOP;
END $$;
-- the sweeper that posts due auto-reversals runs in the system context
CREATE POLICY system_select ON "fx_revaluation_run" FOR SELECT USING (app_system());
REVOKE DELETE, TRUNCATE ON "exchange_rate" FROM uk_app;
REVOKE DELETE, TRUNCATE ON "company_fx_setting" FROM uk_app;
REVOKE DELETE, TRUNCATE ON "fx_revaluation_run" FROM uk_app;

-- ───────── Permission: entering, importing, superseding and verifying rates ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['fx:rate-manage']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner','accountant');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification of the new tables (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'exchange_rate', 'ACCOUNTING_RECORDS'), ('TABLE', 'company_fx_setting', 'ACCOUNTING_RECORDS'), ('TABLE', 'fx_revaluation_run', 'ACCOUNTING_RECORDS');
