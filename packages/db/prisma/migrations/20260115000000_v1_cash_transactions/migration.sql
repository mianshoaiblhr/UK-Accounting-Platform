-- V1 / milestone M6c: cash transactions without a source document and the negative-cash control (DEC-036, DEC-037). Additive.
-- Written for a non-superuser owner (ADR-27): data statements lift RLS on the specific table for this transaction only.

-- ───────── Journals carry the reason a person gave for taking cash in hand below zero (DEC-037) ─────────
ALTER TABLE "journal" ADD COLUMN "negative_cash_reason" TEXT;
ALTER TABLE "journal" ADD CONSTRAINT journal_negative_cash_reason_ck CHECK (negative_cash_reason IS NULL OR char_length(btrim(negative_cash_reason)) BETWEEN 10 AND 1000);

-- At COMMIT (second line of defence behind the PostingService): a journal posted by a person that lowers a cash-in-hand account (subtype
-- CURRENT_ASSET_CASH) must not leave that account below zero on its date or any later date, unless the journal carries a reason or is posted from an
-- approved journal request. Functional-only revaluation adjustments move no money and are not the lines that lower the account. Checks are serialised per account (advisory lock, in account order) so two concurrent payments cannot both pass.
CREATE OR REPLACE FUNCTION journal_cash_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE acc RECORD; low RECORD;
BEGIN
  IF NEW.actor_type <> 'USER' OR NEW.request_id IS NOT NULL OR NEW.negative_cash_reason IS NOT NULL THEN RETURN NULL; END IF;
  FOR acc IN
    SELECT l.account_id, a.code FROM journal_line l JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
     WHERE l.journal_id = NEW.id AND l.organisation_id = NEW.organisation_id AND a.subtype = 'CURRENT_ASSET_CASH' AND l.adjusts_currency IS NULL
     GROUP BY l.account_id, a.code HAVING sum(l.credit) > sum(l.debit) ORDER BY l.account_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('cash:' || acc.account_id::text, 0));
    SELECT d, bal INTO low FROM (
      SELECT d, sum(amt) OVER (ORDER BY d) AS bal FROM (
        SELECT j.journal_date AS d, sum(l.debit - l.credit) AS amt FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
         WHERE l.organisation_id = NEW.organisation_id AND l.company_id = NEW.company_id AND l.account_id = acc.account_id GROUP BY j.journal_date) mv) run
     WHERE d >= NEW.journal_date ORDER BY bal, d LIMIT 1;
    IF FOUND AND low.bal < 0 THEN
      RAISE EXCEPTION 'journal % takes cash account % below zero (% on %); give a reason if this is genuine', NEW.journal_number, acc.code, low.bal, low.d USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_cash_trg AFTER INSERT ON journal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_cash_check();

-- ───────── Cash transactions (money in and money out without a source document) ─────────
CREATE TABLE "cash_transaction" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "transaction_date" DATE NOT NULL,
    "tax_point" DATE,
    "bank_account_id" UUID NOT NULL,
    "contact_id" UUID,
    "counterparty" TEXT,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amounts_include_vat" BOOLEAN NOT NULL DEFAULT false,
    "net_total" NUMERIC(19,4) NOT NULL,
    "vat_total" NUMERIC(19,4) NOT NULL,
    "gross_total" NUMERIC(19,4) NOT NULL,
    "journal_id" UUID NOT NULL,
    "duplicate_override_reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "reversal_journal_id" UUID,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_transaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT cash_transaction_direction_ck CHECK (direction IN ('PAYMENT','RECEIPT')),
    CONSTRAINT cash_transaction_status_ck CHECK ((status = 'POSTED' AND reversal_journal_id IS NULL AND reversed_by_user_id IS NULL AND reversed_at IS NULL AND reversed_reason IS NULL)
      OR (status = 'REVERSED' AND reversal_journal_id IS NOT NULL AND reversed_by_user_id IS NOT NULL AND reversed_at IS NOT NULL AND reversed_reason IS NOT NULL AND char_length(btrim(reversed_reason)) >= 3)),
    CONSTRAINT cash_transaction_amounts_ck CHECK (net_total > 0 AND vat_total >= 0 AND gross_total = net_total + vat_total),
    CONSTRAINT cash_transaction_text_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 500 AND (reference IS NULL OR char_length(reference) <= 100) AND (counterparty IS NULL OR char_length(counterparty) <= 200)
      AND (duplicate_override_reason IS NULL OR char_length(btrim(duplicate_override_reason)) >= 10))
);
CREATE UNIQUE INDEX "cash_transaction_organisation_id_id_key" ON "cash_transaction"("organisation_id", "id");
CREATE UNIQUE INDEX "cash_transaction_journal_key" ON "cash_transaction"("journal_id");
CREATE INDEX "cash_transaction_account_idx" ON "cash_transaction"("organisation_id", "company_id", "bank_account_id", "transaction_date");
CREATE INDEX "cash_transaction_date_idx" ON "cash_transaction"("organisation_id", "company_id", "transaction_date");
ALTER TABLE "cash_transaction" ADD CONSTRAINT "cash_transaction_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction" ADD CONSTRAINT "cash_transaction_contact_fkey" FOREIGN KEY ("organisation_id", "contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction" ADD CONSTRAINT "cash_transaction_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction" ADD CONSTRAINT "cash_transaction_bank_fkey" FOREIGN KEY ("organisation_id", "company_id", "bank_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction" ADD CONSTRAINT "cash_transaction_journal_fkey" FOREIGN KEY ("organisation_id", "company_id", "journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction" ADD CONSTRAINT "cash_transaction_reversal_fkey" FOREIGN KEY ("organisation_id", "company_id", "reversal_journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction" ADD CONSTRAINT "cash_transaction_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction" ADD CONSTRAINT "cash_transaction_reversed_by_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cash_transaction_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "tax_code_id" UUID,
    "amount" NUMERIC(19,4) NOT NULL,
    "net" NUMERIC(19,4) NOT NULL,
    "vat" NUMERIC(19,4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_transaction_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT cash_transaction_line_ck CHECK (line_no BETWEEN 1 AND 200 AND amount > 0 AND net > 0 AND vat >= 0 AND char_length(btrim(description)) BETWEEN 1 AND 300)
);
CREATE UNIQUE INDEX "cash_transaction_line_no_key" ON "cash_transaction_line"("transaction_id", "line_no");
CREATE INDEX "cash_transaction_line_org_idx" ON "cash_transaction_line"("organisation_id", "company_id", "transaction_id");
ALTER TABLE "cash_transaction_line" ADD CONSTRAINT "cash_transaction_line_tx_fkey" FOREIGN KEY ("organisation_id", "transaction_id") REFERENCES "cash_transaction"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction_line" ADD CONSTRAINT "cash_transaction_line_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_transaction_line" ADD CONSTRAINT "cash_transaction_line_tax_code_fkey" FOREIGN KEY ("organisation_id", "tax_code_id") REFERENCES "tax_code"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A transaction is created POSTED, by its own journal of its own direction, from a bank or cash account; afterwards it changes only once, to
-- REVERSED, by its own reversal journal, which must be the exact mirror of the posted one (every line: account, amounts swapped, VAT facts).
CREATE OR REPLACE FUNCTION cash_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j RECORD; a RECORD; c RECORD; src TEXT;
BEGIN
  src := CASE NEW.direction WHEN 'PAYMENT' THEN 'CASH_PAYMENT' ELSE 'CASH_RECEIPT' END;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'POSTED' THEN RAISE EXCEPTION 'a cash transaction starts POSTED' USING ERRCODE = '23514'; END IF;
    SELECT source_type, source_id, journal_date INTO j FROM journal WHERE id = NEW.journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM src OR j.source_id IS DISTINCT FROM NEW.id::text OR j.journal_date <> NEW.transaction_date THEN
      RAISE EXCEPTION 'a cash transaction points at its own posted journal of its direction' USING ERRCODE = '23514';
    END IF;
    SELECT subtype INTO a FROM account WHERE id = NEW.bank_account_id AND organisation_id = NEW.organisation_id;
    IF a.subtype NOT IN ('CURRENT_ASSET_BANK','CURRENT_ASSET_CASH') THEN RAISE EXCEPTION 'a cash transaction moves a bank or cash account' USING ERRCODE = '23514'; END IF;
    IF NEW.contact_id IS NOT NULL THEN
      SELECT company_id INTO c FROM contact WHERE id = NEW.contact_id AND organisation_id = NEW.organisation_id;
      IF c.company_id IS NOT NULL AND c.company_id <> NEW.company_id THEN RAISE EXCEPTION 'the contact belongs to another company' USING ERRCODE = '23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','reversal_journal_id','reversed_by_user_id','reversed_at','reversed_reason','updated_at'])
     <> (to_jsonb(OLD) - ARRAY['status','reversal_journal_id','reversed_by_user_id','reversed_at','reversed_reason','updated_at']) THEN
    RAISE EXCEPTION 'a cash transaction is immutable; reverse it' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'a reversed cash transaction cannot change' USING ERRCODE = '42501'; END IF;
  IF NEW.status = 'REVERSED' THEN
    SELECT source_type, source_id, journal_date INTO j FROM journal WHERE id = NEW.reversal_journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM src || '_REVERSAL' OR j.source_id IS DISTINCT FROM NEW.id::text OR j.journal_date < NEW.transaction_date THEN
      RAISE EXCEPTION 'a cash transaction reversal points at its own reversal journal, dated on or after the transaction' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM (SELECT * FROM journal_line WHERE journal_id = NEW.journal_id AND organisation_id = NEW.organisation_id) o
        FULL JOIN (SELECT * FROM journal_line WHERE journal_id = NEW.reversal_journal_id AND organisation_id = NEW.organisation_id) r USING (line_no)
       WHERE o.account_id IS DISTINCT FROM r.account_id OR o.debit IS DISTINCT FROM r.credit OR o.credit IS DISTINCT FROM r.debit
          OR o.tax_code_id IS DISTINCT FROM r.tax_code_id OR o.tax_rate_id IS DISTINCT FROM r.tax_rate_id OR o.vat_role IS DISTINCT FROM r.vat_role
          OR o.tax_point IS DISTINCT FROM r.tax_point OR o.vat_net_line_no IS DISTINCT FROM r.vat_net_line_no OR o.vat_inclusive IS DISTINCT FROM r.vat_inclusive
    ) THEN
      RAISE EXCEPTION 'a cash transaction reversal must mirror its posted journal line by line' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_transaction_guard_trg BEFORE INSERT OR UPDATE ON cash_transaction FOR EACH ROW EXECUTE FUNCTION cash_transaction_guard();
CREATE TRIGGER cash_transaction_no_delete BEFORE DELETE ON cash_transaction FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER cash_transaction_no_truncate BEFORE TRUNCATE ON cash_transaction FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Lines are written once, in the transaction that creates their cash transaction, to a non-control account of the company that is not a bank or cash account.
CREATE OR REPLACE FUNCTION cash_transaction_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t RECORD; a RECORD;
BEGIN
  SELECT company_id, status, xmin::text AS x INTO t FROM cash_transaction WHERE id = NEW.transaction_id AND organisation_id = NEW.organisation_id;
  -- created in this transaction and still POSTED (a reversal also rewrites xmin, but turns the row REVERSED in the same statement)
  IF NOT FOUND OR t.status <> 'POSTED' OR t.x <> (txid_current() % 4294967296)::text THEN RAISE EXCEPTION 'cash transaction lines are written with their transaction' USING ERRCODE = '42501'; END IF;
  IF t.company_id <> NEW.company_id THEN RAISE EXCEPTION 'a line belongs to the company of its transaction' USING ERRCODE = '23514'; END IF;
  SELECT is_control, subtype INTO a FROM account WHERE id = NEW.account_id AND organisation_id = NEW.organisation_id;
  IF a.is_control OR a.subtype IN ('CURRENT_ASSET_BANK','CURRENT_ASSET_CASH') THEN RAISE EXCEPTION 'a cash transaction line posts to a non-control account that is not a bank or cash account' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_transaction_line_guard_trg BEFORE INSERT ON cash_transaction_line FOR EACH ROW EXECUTE FUNCTION cash_transaction_line_guard();
CREATE TRIGGER cash_transaction_line_no_mutation BEFORE UPDATE OR DELETE ON cash_transaction_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER cash_transaction_line_no_truncate BEFORE TRUNCATE ON cash_transaction_line FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- At COMMIT: the totals agree with the lines and with the bank or cash line of the journal (first line; debit for money in, credit for money out).
CREATE OR REPLACE FUNCTION cash_transaction_totals_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD; b RECORD;
BEGIN
  SELECT count(*) AS n, coalesce(sum(net), 0) AS net, coalesce(sum(vat), 0) AS vat, coalesce(max(line_no), 0) AS mx FROM cash_transaction_line
   WHERE transaction_id = NEW.id AND organisation_id = NEW.organisation_id INTO s;
  IF s.n < 1 OR s.mx <> s.n OR s.net <> NEW.net_total OR s.vat <> NEW.vat_total THEN RAISE EXCEPTION 'cash transaction totals do not match its lines' USING ERRCODE = '23514'; END IF;
  SELECT account_id, debit, credit INTO b FROM journal_line WHERE journal_id = NEW.journal_id AND organisation_id = NEW.organisation_id AND line_no = 1;
  IF b.account_id IS DISTINCT FROM NEW.bank_account_id OR (NEW.direction = 'RECEIPT' AND (b.debit <> NEW.gross_total OR b.credit <> 0)) OR (NEW.direction = 'PAYMENT' AND (b.credit <> NEW.gross_total OR b.debit <> 0)) THEN
    RAISE EXCEPTION 'the journal of a cash transaction moves its bank or cash account by its gross total' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_transaction_totals_trg AFTER INSERT ON cash_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash_transaction_totals_check();

-- ───────── Cash journals are corrected by their own mirror reversal, never by a ledger reversal ─────────
CREATE OR REPLACE FUNCTION journal_subledger_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  IF NEW.reverses_journal_id IS NOT NULL THEN
    SELECT source_type INTO st FROM journal WHERE id = NEW.reverses_journal_id AND organisation_id = NEW.organisation_id;
    IF st IN ('SALES_INVOICE','SALES_CREDIT_NOTE','SALES_ALLOCATION_FX','SALES_RECEIPT','SALES_RECEIPT_REVERSAL','PURCHASE_BILL','PURCHASE_DEBIT_NOTE','PURCHASE_ALLOCATION_FX','PURCHASE_PAYMENT','PURCHASE_PAYMENT_REVERSAL',
              'CASH_PAYMENT','CASH_RECEIPT','CASH_PAYMENT_REVERSAL','CASH_RECEIPT_REVERSAL') THEN
      RAISE EXCEPTION 'a % journal is corrected in its sub-ledger (a credit or debit note, or a receipt, payment or cash transaction reversal), not reversed', st USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ───────── VAT: a cash reversal mirrors the rate version its transaction used, even if superseded since (as a ledger reversal does) ─────────
CREATE OR REPLACE FUNCTION journal_vat_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l RECORD; n RECORD; r RECORD; minor INTEGER; amt NUMERIC; base NUMERIC; expected NUMERIC; rp DATE;
BEGIN
  SELECT minor_units INTO minor FROM currency WHERE code = NEW.currency;
  FOR l IN SELECT * FROM journal_line WHERE journal_id = NEW.id AND organisation_id = NEW.organisation_id AND tax_rate_id IS NOT NULL ORDER BY line_no LOOP
    SELECT tax_code_id, rate, effective_from, effective_to, verification_status, superseded_by_id INTO r FROM tax_rate WHERE id = l.tax_rate_id AND organisation_id = l.organisation_id;
    IF r.tax_code_id <> l.tax_code_id THEN RAISE EXCEPTION 'line % uses a rate of another tax code', l.line_no USING ERRCODE = '23514'; END IF;
    IF r.verification_status <> 'VERIFIED' THEN RAISE EXCEPTION 'line % uses an UNVERIFIED tax rate', l.line_no USING ERRCODE = '23514'; END IF;
    IF l.vat_rate_point IS NOT NULL AND NEW.source_type NOT IN ('SALES_CREDIT_NOTE','PURCHASE_DEBIT_NOTE','REVERSAL') THEN RAISE EXCEPTION 'line % names an adjusted supply but the journal is not a credit or debit note', l.line_no USING ERRCODE = '23514'; END IF;
    rp := coalesce(l.vat_rate_point, l.tax_point);
    IF r.superseded_by_id IS NOT NULL AND NEW.reverses_journal_id IS NULL AND l.vat_rate_point IS NULL AND NEW.source_type NOT IN ('CASH_PAYMENT_REVERSAL','CASH_RECEIPT_REVERSAL') THEN
      RAISE EXCEPTION 'line % uses a superseded tax rate version', l.line_no USING ERRCODE = '23514';
    END IF;
    IF rp < r.effective_from OR (r.effective_to IS NOT NULL AND rp > r.effective_to) THEN RAISE EXCEPTION 'line % has a tax point outside the rate''s effective dates', l.line_no USING ERRCODE = '23514'; END IF;
    IF l.vat_role <> 'NET' THEN
      SELECT debit, credit, tax_rate_id, vat_role, tax_point, vat_rate_point INTO n FROM journal_line WHERE journal_id = NEW.id AND organisation_id = NEW.organisation_id AND line_no = l.vat_net_line_no;
      IF NOT FOUND OR n.vat_role <> 'NET' OR n.tax_rate_id <> l.tax_rate_id OR n.tax_point <> l.tax_point OR n.vat_rate_point IS DISTINCT FROM l.vat_rate_point THEN
        RAISE EXCEPTION 'VAT line % does not point at its net line', l.line_no USING ERRCODE = '23514';
      END IF;
      amt := l.debit + l.credit; base := n.debit + n.credit;
      expected := CASE WHEN l.vat_inclusive THEN round((base + amt) * r.rate / (100 + r.rate), minor) ELSE round(base * r.rate / 100, minor) END;
      IF l.vat_role IN ('RC_OUTPUT','RC_INPUT') THEN expected := round(base * r.rate / 100, minor); END IF;
      IF amt <> expected THEN RAISE EXCEPTION 'VAT line % is % but the VAT on its net line is %', l.line_no, amt, expected USING ERRCODE = '23514'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- ───────── Evidence graph: a cash transaction can carry its till receipt or slip ─────────
ALTER TABLE "evidence_link" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "evidence_link" DROP CONSTRAINT evidence_link_source_type_ck, DROP CONSTRAINT evidence_link_target_type_ck;
ALTER TABLE "evidence_link"
  ADD CONSTRAINT evidence_link_source_type_ck CHECK (source_type IN ('document','document_version','task','workflow_instance','ai_proposal','contact','company','accounting_period','journal','sales_document','purchase_document','cash_transaction')),
  ADD CONSTRAINT evidence_link_target_type_ck CHECK (target_type IN ('document','document_version','task','workflow_instance','ai_proposal','contact','company','accounting_period','journal','sales_document','purchase_document','cash_transaction'));
ALTER TABLE "evidence_link" FORCE ROW LEVEL SECURITY;

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_transaction','cash_transaction_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "cash_transaction_line" FROM uk_app;

-- ───────── Permissions (DEC-037): reading follows the ledger readers; recording posts directly, so it sits with those who approve ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['cash:read','cash:record']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner','accountant');
UPDATE "role" SET permissions = permissions || ARRAY['cash:read']::text[] WHERE organisation_id IS NULL AND key IN ('manager','bookkeeper','reviewer');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'cash_transaction', 'ACCOUNTING_RECORDS'), ('TABLE', 'cash_transaction_line', 'ACCOUNTING_RECORDS');
