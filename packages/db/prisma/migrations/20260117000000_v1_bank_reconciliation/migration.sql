-- V1 / milestone M7b: bank reconciliation - matches between statement lines and ledger entries, unmatching, sign-off (DEC-042). Additive.
-- Written for a non-superuser owner (ADR-27): data statements lift RLS on the specific table for this transaction only.

-- ───────── Matches: one statement line to one journal line on the bank account, for an amount in the account currency ─────────
CREATE TABLE "bank_match" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "statement_line_id" UUID NOT NULL,
    "journal_line_id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    -- signed like the statement line: positive = money in (a debit to the bank account)
    "amount" NUMERIC(19,4) NOT NULL,
    "kind" TEXT NOT NULL,
    "override_reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "unmatched_by_user_id" UUID,
    "unmatched_at" TIMESTAMPTZ(3),
    "unmatch_reason" TEXT,
    "after_sign_off" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_match_pkey" PRIMARY KEY ("id"),
    CONSTRAINT bank_match_kind_ck CHECK (kind IN ('MANUAL','SUGGESTION','POSTED_FROM_STATEMENT')),
    CONSTRAINT bank_match_amount_ck CHECK (amount <> 0),
    CONSTRAINT bank_match_override_ck CHECK (override_reason IS NULL OR char_length(btrim(override_reason)) >= 10),
    CONSTRAINT bank_match_status_ck CHECK ((status = 'ACTIVE' AND unmatched_by_user_id IS NULL AND unmatched_at IS NULL AND unmatch_reason IS NULL AND NOT after_sign_off)
      OR (status = 'UNMATCHED' AND unmatched_by_user_id IS NOT NULL AND unmatched_at IS NOT NULL AND char_length(btrim(unmatch_reason)) >= 10))
);
CREATE UNIQUE INDEX "bank_match_organisation_id_id_key" ON "bank_match"("organisation_id", "id");
-- one live match per pair: a second amount on the same pair is a different match only after the first was undone
CREATE UNIQUE INDEX "bank_match_active_pair_key" ON "bank_match"("statement_line_id", "journal_line_id") WHERE status = 'ACTIVE';
CREATE INDEX "bank_match_line_idx" ON "bank_match"("organisation_id", "statement_line_id");
CREATE INDEX "bank_match_journal_line_idx" ON "bank_match"("organisation_id", "journal_line_id");
CREATE INDEX "bank_match_account_idx" ON "bank_match"("organisation_id", "bank_account_id", "status");
ALTER TABLE "bank_match" ADD CONSTRAINT "bank_match_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "bank_account_id") REFERENCES "bank_account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_match" ADD CONSTRAINT "bank_match_line_fkey" FOREIGN KEY ("organisation_id", "statement_line_id") REFERENCES "bank_statement_line"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_match" ADD CONSTRAINT "bank_match_journal_fkey" FOREIGN KEY ("organisation_id", "company_id", "journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_match" ADD CONSTRAINT "bank_match_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_match" ADD CONSTRAINT "bank_match_unmatched_by_fkey" FOREIGN KEY ("unmatched_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The value of a journal line in the bank account's currency, signed (+ debit = money in): the original amount of a foreign line, otherwise the functional amount.
CREATE OR REPLACE FUNCTION bank_line_value(p_org UUID, p_line UUID, p_currency CHAR(3)) RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE l RECORD; base CHAR(3);
BEGIN
  SELECT jl.debit, jl.credit, jl.original_currency, jl.original_debit, jl.original_credit, jl.adjusts_currency, c.base_currency INTO l
    FROM journal_line jl JOIN company c ON c.id = jl.company_id AND c.organisation_id = jl.organisation_id WHERE jl.id = p_line AND jl.organisation_id = p_org;
  IF NOT FOUND OR l.adjusts_currency IS NOT NULL THEN RETURN NULL; END IF;
  IF p_currency = l.base_currency AND l.original_currency IS NULL THEN RETURN l.debit - l.credit; END IF;
  IF l.original_currency = p_currency THEN RETURN l.original_debit - l.original_credit; END IF;
  RETURN NULL;
END $$;

-- A match joins a live statement line and a journal line of the same bank account, in the same direction; never more than either side holds.
-- Afterwards it changes only once, ACTIVE -> UNMATCHED with a reason. The statement line's matched part follows every change.
CREATE OR REPLACE FUNCTION bank_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD; b RECORD; j RECORD; v NUMERIC; used NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'a match starts ACTIVE' USING ERRCODE = '23514'; END IF;
    SELECT bank_account_id, amount, voided INTO s FROM bank_statement_line WHERE id = NEW.statement_line_id AND organisation_id = NEW.organisation_id;
    IF s.bank_account_id IS DISTINCT FROM NEW.bank_account_id OR s.voided THEN RAISE EXCEPTION 'a match uses a live statement line of its bank account' USING ERRCODE = '23514'; END IF;
    SELECT account_id, currency, company_id INTO b FROM bank_account WHERE id = NEW.bank_account_id AND organisation_id = NEW.organisation_id;
    SELECT jl.account_id, jl.journal_id INTO j FROM journal_line jl WHERE jl.id = NEW.journal_line_id AND jl.organisation_id = NEW.organisation_id;
    IF j.account_id IS DISTINCT FROM b.account_id OR j.journal_id IS DISTINCT FROM NEW.journal_id OR b.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'a match uses a ledger entry on the bank account''s own ledger account' USING ERRCODE = '23514';
    END IF;
    v := bank_line_value(NEW.organisation_id, NEW.journal_line_id, b.currency);
    IF v IS NULL THEN RAISE EXCEPTION 'the ledger entry is not in the bank account''s currency' USING ERRCODE = '23514'; END IF;
    IF sign(NEW.amount) <> sign(s.amount) OR sign(NEW.amount) <> sign(v) THEN RAISE EXCEPTION 'money in matches a debit to the bank, money out a credit' USING ERRCODE = '23514'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('bank_match:' || NEW.journal_line_id::text, 0));
    SELECT coalesce(sum(amount), 0) INTO used FROM bank_match WHERE journal_line_id = NEW.journal_line_id AND organisation_id = NEW.organisation_id AND status = 'ACTIVE';
    IF abs(used + NEW.amount) > abs(v) THEN RAISE EXCEPTION 'the ledger entry would be matched for more than it holds' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','unmatched_by_user_id','unmatched_at','unmatch_reason','after_sign_off']) <> (to_jsonb(OLD) - ARRAY['status','unmatched_by_user_id','unmatched_at','unmatch_reason','after_sign_off']) THEN
    RAISE EXCEPTION 'a match is never edited; unmatch it with a reason' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN RAISE EXCEPTION 'an undone match cannot change' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_match_guard_trg BEFORE INSERT OR UPDATE ON bank_match FOR EACH ROW EXECUTE FUNCTION bank_match_guard();

CREATE OR REPLACE FUNCTION bank_match_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.bank_match', 'on', true);
  IF TG_OP = 'INSERT' THEN
    UPDATE bank_statement_line SET matched_amount = matched_amount + NEW.amount WHERE id = NEW.statement_line_id AND organisation_id = NEW.organisation_id;
  ELSIF NEW.status = 'UNMATCHED' AND OLD.status = 'ACTIVE' THEN
    UPDATE bank_statement_line SET matched_amount = matched_amount - OLD.amount WHERE id = OLD.statement_line_id AND organisation_id = OLD.organisation_id;
  END IF;
  PERFORM set_config('app.bank_match', 'off', true);
  RETURN NULL;
END $$;
CREATE TRIGGER bank_match_apply_trg AFTER INSERT OR UPDATE ON bank_match FOR EACH ROW EXECUTE FUNCTION bank_match_apply();
CREATE TRIGGER bank_match_no_delete BEFORE DELETE ON bank_match FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bank_match_no_truncate BEFORE TRUNCATE ON bank_match FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Sign-off: the figures of a reconciliation as at a date, recorded once ─────────
CREATE TABLE "bank_reconciliation" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "as_at" DATE NOT NULL,
    "bank_closing_balance" NUMERIC(19,4) NOT NULL,
    "statement_balance" NUMERIC(19,4) NOT NULL,
    "ledger_balance" NUMERIC(19,4) NOT NULL,
    "unmatched_statement" NUMERIC(19,4) NOT NULL,
    "unmatched_ledger" NUMERIC(19,4) NOT NULL,
    "difference" NUMERIC(19,4) NOT NULL,
    "unmatched_statement_lines" INTEGER NOT NULL,
    "unmatched_ledger_lines" INTEGER NOT NULL,
    "notes" TEXT,
    "signed_by_user_id" UUID NOT NULL,
    "signed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_reconciliation_pkey" PRIMARY KEY ("id"),
    -- signed off only when the bank's own closing balance equals the imported statement and the proof has no difference
    CONSTRAINT bank_reconciliation_proof_ck CHECK (difference = (statement_balance - unmatched_statement) - (ledger_balance - unmatched_ledger)
      AND difference = 0 AND bank_closing_balance = statement_balance AND unmatched_statement_lines >= 0 AND unmatched_ledger_lines >= 0),
    CONSTRAINT bank_reconciliation_text_ck CHECK (notes IS NULL OR char_length(notes) <= 2000)
);
CREATE UNIQUE INDEX "bank_reconciliation_organisation_id_id_key" ON "bank_reconciliation"("organisation_id", "id");
CREATE INDEX "bank_reconciliation_account_idx" ON "bank_reconciliation"("organisation_id", "bank_account_id", "as_at");
ALTER TABLE "bank_reconciliation" ADD CONSTRAINT "bank_reconciliation_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "bank_account_id") REFERENCES "bank_account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_reconciliation" ADD CONSTRAINT "bank_reconciliation_signed_by_fkey" FOREIGN KEY ("signed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER bank_reconciliation_no_mutation BEFORE UPDATE OR DELETE ON bank_reconciliation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bank_reconciliation_no_truncate BEFORE TRUNCATE ON bank_reconciliation FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_match','bank_reconciliation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "bank_reconciliation" FROM uk_app;

-- ───────── Permissions (DEC-039, DEC-042) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['bank:reconcile']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner','accountant','manager','bookkeeper');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'bank_match', 'ACCOUNTING_RECORDS'), ('TABLE', 'bank_reconciliation', 'ACCOUNTING_RECORDS');
