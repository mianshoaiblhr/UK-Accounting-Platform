-- V1 / milestone M6b: supplier payments and their allocation to bills (DEC-030, DEC-035; mirrors M5b). Additive.
-- Written for a non-superuser owner (ADR-27): data statements lift RLS on the specific table for this transaction only.

CREATE TABLE "purchase_payment" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "supplier_role_id" UUID NOT NULL,
    "party_role" TEXT NOT NULL DEFAULT 'SUPPLIER',
    "contact_id" UUID NOT NULL,
    "payment_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" NUMERIC(19,4) NOT NULL,
    "outstanding" NUMERIC(19,4) NOT NULL,
    "functional_amount" NUMERIC(19,4) NOT NULL,
    "functional_outstanding" NUMERIC(19,4) NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "exchange_rate_id" UUID,
    "rate" NUMERIC(19,8),
    "reference" TEXT,
    "notes" TEXT,
    "journal_id" UUID NOT NULL,
    "duplicate_override_reason" TEXT,
    -- DEC-035: the supplier's stored bank details were UNVERIFIED when the payment was recorded (a flag for review, not a block)
    "bank_details_unverified" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "reversal_journal_id" UUID,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_payment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT purchase_payment_party_ck CHECK (party_role = 'SUPPLIER'),
    CONSTRAINT purchase_payment_status_ck CHECK ((status = 'POSTED' AND reversal_journal_id IS NULL AND reversed_by_user_id IS NULL AND reversed_at IS NULL AND reversed_reason IS NULL)
      OR (status = 'REVERSED' AND reversal_journal_id IS NOT NULL AND reversed_by_user_id IS NOT NULL AND reversed_at IS NOT NULL AND reversed_reason IS NOT NULL AND char_length(btrim(reversed_reason)) >= 3)),
    CONSTRAINT purchase_payment_amounts_ck CHECK (amount > 0 AND functional_amount > 0 AND outstanding >= 0 AND outstanding <= amount AND functional_outstanding >= 0
      AND (outstanding <> 0 OR functional_outstanding = 0)),
    CONSTRAINT purchase_payment_rate_ck CHECK ((exchange_rate_id IS NULL) = (rate IS NULL)),
    CONSTRAINT purchase_payment_text_ck CHECK ((reference IS NULL OR char_length(reference) <= 100) AND (notes IS NULL OR char_length(notes) <= 2000))
);
CREATE UNIQUE INDEX "purchase_payment_organisation_id_id_key" ON "purchase_payment"("organisation_id", "id");
CREATE UNIQUE INDEX "purchase_payment_journal_key" ON "purchase_payment"("journal_id");
CREATE INDEX "purchase_payment_supplier_idx" ON "purchase_payment"("organisation_id", "company_id", "supplier_role_id", "status");
CREATE INDEX "purchase_payment_date_idx" ON "purchase_payment"("organisation_id", "company_id", "payment_date");
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_role_fkey" FOREIGN KEY ("supplier_role_id", "party_role") REFERENCES "contact_role"("id", "role") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_org_role_fkey" FOREIGN KEY ("organisation_id", "supplier_role_id") REFERENCES "contact_role"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_contact_fkey" FOREIGN KEY ("organisation_id", "contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_bank_fkey" FOREIGN KEY ("organisation_id", "company_id", "bank_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_rate_fkey" FOREIGN KEY ("organisation_id", "exchange_rate_id") REFERENCES "exchange_rate"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_journal_fkey" FOREIGN KEY ("organisation_id", "company_id", "journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_reversal_fkey" FOREIGN KEY ("organisation_id", "company_id", "reversal_journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_payment" ADD CONSTRAINT "purchase_payment_reversed_by_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A payment is created POSTED with its own journal and outstanding in full; afterwards only an allocation moves its outstanding amounts, and it is reversed
-- (POSTED -> REVERSED, once) only while nothing is allocated, by its own reversal journal.
CREATE OR REPLACE FUNCTION purchase_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD; j RECORD; a RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'POSTED' OR NEW.outstanding <> NEW.amount OR NEW.functional_outstanding <> NEW.functional_amount THEN RAISE EXCEPTION 'a payment starts POSTED and unallocated' USING ERRCODE = '23514'; END IF;
    SELECT company_id, contact_id INTO r FROM contact_role WHERE id = NEW.supplier_role_id AND organisation_id = NEW.organisation_id;
    IF r.company_id IS DISTINCT FROM NEW.company_id OR r.contact_id IS DISTINCT FROM NEW.contact_id THEN RAISE EXCEPTION 'the supplier role must belong to this company and contact' USING ERRCODE = '23514'; END IF;
    SELECT source_type, source_id, journal_date INTO j FROM journal WHERE id = NEW.journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM 'PURCHASE_PAYMENT' OR j.source_id IS DISTINCT FROM NEW.id::text OR j.journal_date <> NEW.payment_date THEN RAISE EXCEPTION 'a payment points at its own posted journal' USING ERRCODE = '23514'; END IF;
    SELECT subtype, is_control, control_kind INTO a FROM account WHERE id = NEW.bank_account_id AND organisation_id = NEW.organisation_id;
    IF a.subtype NOT IN ('CURRENT_ASSET_BANK','CURRENT_ASSET_CASH') THEN RAISE EXCEPTION 'a payment is made from a bank or cash account' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['outstanding','functional_outstanding','status','reversal_journal_id','reversed_by_user_id','reversed_at','reversed_reason','updated_at'])
     <> (to_jsonb(OLD) - ARRAY['outstanding','functional_outstanding','status','reversal_journal_id','reversed_by_user_id','reversed_at','reversed_reason','updated_at']) THEN
    RAISE EXCEPTION 'a payment is immutable; reverse it while it is unallocated' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'a reversed payment cannot change' USING ERRCODE = '42501'; END IF;
  IF (NEW.outstanding <> OLD.outstanding OR NEW.functional_outstanding <> OLD.functional_outstanding) AND coalesce(current_setting('app.purchase_allocation', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'a payment''s unallocated amount moves only through an allocation' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'REVERSED' THEN
    IF OLD.outstanding <> OLD.amount OR NEW.outstanding <> OLD.outstanding OR NEW.functional_outstanding <> OLD.functional_outstanding THEN RAISE EXCEPTION 'only an unallocated payment can be reversed' USING ERRCODE = '23514'; END IF;
    SELECT source_type, source_id INTO j FROM journal WHERE id = NEW.reversal_journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM 'PURCHASE_PAYMENT_REVERSAL' OR j.source_id IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'a payment reversal points at its own reversal journal' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_payment_guard_trg BEFORE INSERT OR UPDATE ON purchase_payment FOR EACH ROW EXECUTE FUNCTION purchase_payment_guard();
CREATE TRIGGER purchase_payment_no_delete BEFORE DELETE ON purchase_payment FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER purchase_payment_no_truncate BEFORE TRUNCATE ON purchase_payment FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Allocations now apply a debit note OR a payment to a bill ─────────
ALTER TABLE "purchase_allocation" ALTER COLUMN "debit_id" DROP NOT NULL;
ALTER TABLE "purchase_allocation" ADD COLUMN "payment_id" UUID;
ALTER TABLE "purchase_allocation" ADD CONSTRAINT purchase_allocation_source_ck CHECK ((debit_id IS NULL) <> (payment_id IS NULL));
ALTER TABLE "purchase_allocation" ADD CONSTRAINT "purchase_allocation_payment_fkey" FOREIGN KEY ("organisation_id", "payment_id") REFERENCES "purchase_payment"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "purchase_allocation_payment_idx" ON "purchase_allocation"("organisation_id", "payment_id") WHERE payment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION purchase_allocation_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i RECORD; c RECORD; j RECORD; src_role UUID; src_ccy CHAR(3); src_company UUID; src_date DATE;
BEGIN
  SELECT * INTO i FROM purchase_document WHERE id = NEW.bill_id AND organisation_id = NEW.organisation_id FOR UPDATE;
  IF i.kind <> 'BILL' OR i.status <> 'APPROVED' THEN RAISE EXCEPTION 'an allocation applies an approved debit note or a payment to an approved bill' USING ERRCODE = '23514'; END IF;
  IF NEW.debit_id IS NOT NULL THEN
    SELECT * INTO c FROM purchase_document WHERE id = NEW.debit_id AND organisation_id = NEW.organisation_id FOR UPDATE;
    IF c.kind <> 'DEBIT_NOTE' OR c.status <> 'APPROVED' THEN RAISE EXCEPTION 'an allocation applies an approved debit note or a payment to an approved bill' USING ERRCODE = '23514'; END IF;
    IF c.original_bill_id <> i.id THEN RAISE EXCEPTION 'a debit note is allocated to the bill it credits' USING ERRCODE = '23514'; END IF;
    src_role := c.supplier_role_id; src_ccy := c.currency; src_company := c.company_id; src_date := c.issue_date;
  ELSE
    SELECT * INTO c FROM purchase_payment WHERE id = NEW.payment_id AND organisation_id = NEW.organisation_id FOR UPDATE;
    IF c.status <> 'POSTED' THEN RAISE EXCEPTION 'a reversed payment cannot be allocated' USING ERRCODE = '23514'; END IF;
    src_role := c.supplier_role_id; src_ccy := c.currency; src_company := c.company_id; src_date := c.payment_date;
  END IF;
  IF i.company_id <> NEW.company_id OR src_company <> NEW.company_id OR i.supplier_role_id <> src_role OR i.currency <> src_ccy THEN
    RAISE EXCEPTION 'an allocation joins documents of one company, supplier and currency' USING ERRCODE = '23514';
  END IF;
  IF NEW.allocated_on < greatest(i.issue_date, src_date) THEN RAISE EXCEPTION 'an allocation cannot precede its documents' USING ERRCODE = '23514'; END IF;
  IF NEW.fx_journal_id IS NOT NULL THEN
    SELECT source_type, source_id, journal_date INTO j FROM journal WHERE id = NEW.fx_journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM 'PURCHASE_ALLOCATION_FX' OR j.source_id IS DISTINCT FROM NEW.id::text OR j.journal_date <> NEW.allocated_on THEN
      RAISE EXCEPTION 'the realised FX journal of an allocation is its own' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM set_config('app.purchase_allocation', 'on', true);
  UPDATE purchase_document SET outstanding = outstanding - NEW.amount, functional_outstanding = functional_outstanding - NEW.bill_functional, updated_at = now() WHERE id = i.id;
  IF NEW.debit_id IS NOT NULL THEN
    UPDATE purchase_document SET outstanding = outstanding - NEW.amount, functional_outstanding = functional_outstanding - NEW.debit_functional, updated_at = now() WHERE id = NEW.debit_id;
  ELSE
    UPDATE purchase_payment SET outstanding = outstanding - NEW.amount, functional_outstanding = functional_outstanding - NEW.debit_functional, updated_at = now() WHERE id = NEW.payment_id;
  END IF;
  PERFORM set_config('app.purchase_allocation', 'off', true);
  RETURN NULL;
END $$;

-- payment journals are corrected by their own reversal, never by a ledger reversal
CREATE OR REPLACE FUNCTION journal_subledger_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  IF NEW.reverses_journal_id IS NOT NULL THEN
    SELECT source_type INTO st FROM journal WHERE id = NEW.reverses_journal_id AND organisation_id = NEW.organisation_id;
    IF st IN ('SALES_INVOICE','SALES_CREDIT_NOTE','SALES_ALLOCATION_FX','SALES_RECEIPT','SALES_RECEIPT_REVERSAL','PURCHASE_BILL','PURCHASE_DEBIT_NOTE','PURCHASE_ALLOCATION_FX','PURCHASE_PAYMENT','PURCHASE_PAYMENT_REVERSAL') THEN
      RAISE EXCEPTION 'a % journal is corrected in its sub-ledger (a credit or debit note, or a receipt or payment reversal), not reversed', st USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ───────── Row-level security (forced) and least privilege ─────────
ALTER TABLE "purchase_payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchase_payment" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE DELETE, TRUNCATE ON "purchase_payment" FROM uk_app;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'purchase_payment', 'ACCOUNTING_RECORDS');
