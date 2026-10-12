-- V1 / milestone M5a: sales documents - invoices and credit notes (DEC-026..031, ADR-59). Additive.
-- Written for a non-superuser owner (ADR-27): data statements lift RLS on the specific table for this transaction only.

-- ───────── Settings: receivables control account, numbering, separation of duties ─────────
CREATE TABLE "sales_setting" (
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "receivables_account_id" UUID,
    "invoice_prefix" TEXT NOT NULL DEFAULT 'INV-',
    "credit_note_prefix" TEXT NOT NULL DEFAULT 'CN-',
    "invoice_start" INTEGER NOT NULL DEFAULT 1,
    "credit_note_start" INTEGER NOT NULL DEFAULT 1,
    "require_separate_approver" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_setting_pkey" PRIMARY KEY ("organisation_id", "company_id"),
    CONSTRAINT sales_setting_prefix_ck CHECK (invoice_prefix ~ '^[A-Za-z0-9/_-]{0,10}$' AND credit_note_prefix ~ '^[A-Za-z0-9/_-]{0,10}$'),
    CONSTRAINT sales_setting_start_ck CHECK (invoice_start BETWEEN 1 AND 999999999 AND credit_note_start BETWEEN 1 AND 999999999)
);
ALTER TABLE "sales_setting" ADD CONSTRAINT "sales_setting_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_setting" ADD CONSTRAINT "sales_setting_receivables_fkey" FOREIGN KEY ("organisation_id", "company_id", "receivables_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- one row per company and kind, created at the first approval; the last number issued
CREATE TABLE "sales_sequence" (
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,
    CONSTRAINT "sales_sequence_pkey" PRIMARY KEY ("organisation_id", "company_id", "kind"),
    CONSTRAINT sales_sequence_kind_ck CHECK (kind IN ('INVOICE','CREDIT_NOTE')),
    CONSTRAINT sales_sequence_number_ck CHECK (last_number >= 1)
);
ALTER TABLE "sales_sequence" ADD CONSTRAINT "sales_sequence_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- the receivables account is a TRADE_RECEIVABLES control account; prefixes and start numbers freeze once a document of the kind is numbered;
-- a sequence only ever moves forward by one
CREATE OR REPLACE FUNCTION sales_setting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD;
BEGIN
  IF NEW.receivables_account_id IS NOT NULL THEN
    SELECT is_control, control_kind INTO a FROM account WHERE id = NEW.receivables_account_id AND organisation_id = NEW.organisation_id;
    IF NOT a.is_control OR a.control_kind IS DISTINCT FROM 'TRADE_RECEIVABLES' THEN RAISE EXCEPTION 'the receivables account must be a TRADE_RECEIVABLES control account' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'settings belong to one company' USING ERRCODE = '42501'; END IF;
    IF (NEW.invoice_prefix <> OLD.invoice_prefix OR NEW.invoice_start <> OLD.invoice_start)
       AND EXISTS (SELECT 1 FROM sales_sequence WHERE organisation_id = NEW.organisation_id AND company_id = NEW.company_id AND kind = 'INVOICE') THEN
      RAISE EXCEPTION 'invoice numbering cannot change after the first invoice is approved' USING ERRCODE = '23514';
    END IF;
    IF (NEW.credit_note_prefix <> OLD.credit_note_prefix OR NEW.credit_note_start <> OLD.credit_note_start)
       AND EXISTS (SELECT 1 FROM sales_sequence WHERE organisation_id = NEW.organisation_id AND company_id = NEW.company_id AND kind = 'CREDIT_NOTE') THEN
      RAISE EXCEPTION 'credit note numbering cannot change after the first credit note is approved' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_setting_guard_trg BEFORE INSERT OR UPDATE ON sales_setting FOR EACH ROW EXECUTE FUNCTION sales_setting_guard();
CREATE OR REPLACE FUNCTION sales_sequence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  SELECT invoice_start, credit_note_start INTO s FROM sales_setting WHERE organisation_id = NEW.organisation_id AND company_id = NEW.company_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_number <> (CASE NEW.kind WHEN 'INVOICE' THEN coalesce(s.invoice_start, 1) ELSE coalesce(s.credit_note_start, 1) END) THEN
      RAISE EXCEPTION 'the first number must be the configured start number' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.kind <> OLD.kind OR NEW.last_number <> OLD.last_number + 1 THEN
    RAISE EXCEPTION 'a document sequence only moves forward by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_sequence_guard_trg BEFORE INSERT OR UPDATE ON sales_sequence FOR EACH ROW EXECUTE FUNCTION sales_sequence_guard();

-- ───────── Documents ─────────
CREATE TABLE "sales_document" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "number" INTEGER,
    "document_number" TEXT,
    "customer_role_id" UUID NOT NULL,
    "party_role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "contact_id" UUID NOT NULL,
    "issue_date" DATE NOT NULL,
    "supply_date" DATE,
    "tax_point" DATE,
    "due_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amounts_include_vat" BOOLEAN NOT NULL DEFAULT false,
    "customer_reference" TEXT,
    "notes" TEXT,
    "original_invoice_id" UUID,
    "credit_reason" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "net_total" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "vat_total" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "gross_total" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "outstanding" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "functional_gross" NUMERIC(19,4),
    "functional_outstanding" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "exchange_rate_id" UUID,
    "rate" NUMERIC(19,8),
    "journal_id" UUID,
    "contact_snapshot" JSONB,
    "duplicate_override_reason" TEXT,
    "credit_limit_override_reason" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "ai_proposal_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "discarded_by_user_id" UUID,
    "discarded_at" TIMESTAMPTZ(3),
    "discarded_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT sales_document_kind_ck CHECK (kind IN ('INVOICE','CREDIT_NOTE')),
    CONSTRAINT sales_document_party_ck CHECK (party_role = 'CUSTOMER'),
    CONSTRAINT sales_document_status_ck CHECK (status IN ('DRAFT','APPROVED','DISCARDED')),
    CONSTRAINT sales_document_origin_ck CHECK ((origin = 'MANUAL' AND ai_proposal_id IS NULL) OR (origin = 'AI_PROPOSAL' AND ai_proposal_id IS NOT NULL)),
    CONSTRAINT sales_document_credit_ck CHECK ((kind = 'CREDIT_NOTE') = (original_invoice_id IS NOT NULL) AND (kind = 'INVOICE' OR (credit_reason IS NOT NULL AND char_length(btrim(credit_reason)) >= 3))),
    CONSTRAINT sales_document_approved_ck CHECK ((status = 'APPROVED') = (number IS NOT NULL AND document_number IS NOT NULL AND journal_id IS NOT NULL AND approved_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL AND contact_snapshot IS NOT NULL AND functional_gross IS NOT NULL)),
    CONSTRAINT sales_document_discarded_ck CHECK ((status = 'DISCARDED') = (discarded_by_user_id IS NOT NULL AND discarded_at IS NOT NULL AND discarded_reason IS NOT NULL)
      AND (discarded_reason IS NULL OR char_length(btrim(discarded_reason)) >= 3)),
    CONSTRAINT sales_document_totals_ck CHECK (net_total >= 0 AND vat_total >= 0 AND gross_total = net_total + vat_total),
    CONSTRAINT sales_document_outstanding_ck CHECK (outstanding >= 0 AND outstanding <= gross_total AND functional_outstanding >= 0
      AND (outstanding <> 0 OR functional_outstanding = 0) AND (status = 'APPROVED' OR (outstanding = 0 AND functional_outstanding = 0))),
    CONSTRAINT sales_document_dates_ck CHECK (due_date >= issue_date),
    CONSTRAINT sales_document_rate_ck CHECK ((exchange_rate_id IS NULL) = (rate IS NULL)),
    CONSTRAINT sales_document_text_ck CHECK ((customer_reference IS NULL OR char_length(customer_reference) <= 100) AND (notes IS NULL OR char_length(notes) <= 2000))
);
CREATE UNIQUE INDEX "sales_document_organisation_id_id_key" ON "sales_document"("organisation_id", "id");
CREATE UNIQUE INDEX "sales_document_number_key" ON "sales_document"("organisation_id", "company_id", "kind", "number") WHERE number IS NOT NULL;
CREATE UNIQUE INDEX "sales_document_journal_key" ON "sales_document"("journal_id") WHERE journal_id IS NOT NULL;
CREATE INDEX "sales_document_company_idx" ON "sales_document"("organisation_id", "company_id", "kind", "status", "issue_date");
CREATE INDEX "sales_document_customer_idx" ON "sales_document"("organisation_id", "company_id", "customer_role_id", "status");
CREATE INDEX "sales_document_original_idx" ON "sales_document"("organisation_id", "original_invoice_id") WHERE original_invoice_id IS NOT NULL;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_role_fkey" FOREIGN KEY ("customer_role_id", "party_role") REFERENCES "contact_role"("id", "role") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_org_role_fkey" FOREIGN KEY ("organisation_id", "customer_role_id") REFERENCES "contact_role"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_contact_fkey" FOREIGN KEY ("organisation_id", "contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_original_fkey" FOREIGN KEY ("organisation_id", "original_invoice_id") REFERENCES "sales_document"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_rate_fkey" FOREIGN KEY ("organisation_id", "exchange_rate_id") REFERENCES "exchange_rate"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_journal_fkey" FOREIGN KEY ("organisation_id", "company_id", "journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_ai_proposal_fkey" FOREIGN KEY ("ai_proposal_id") REFERENCES "ai_proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_approved_by_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document" ADD CONSTRAINT "sales_document_discarded_by_fkey" FOREIGN KEY ("discarded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lifecycle rules: DRAFT -> APPROVED | DISCARDED only; identity never changes; an approved document changes only in its outstanding amounts, and only
-- through an allocation (the allocation trigger sets a transaction-local switch); approval takes the next number and needs a matching posted journal.
CREATE OR REPLACE FUNCTION sales_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD; o RECORD; j RECORD; st RECORD; vs RECORD; base CHAR(3); seq INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.revision <> 1 THEN RAISE EXCEPTION 'a sales document starts as a DRAFT' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.kind <> OLD.kind OR NEW.origin <> OLD.origin OR NEW.ai_proposal_id IS DISTINCT FROM OLD.ai_proposal_id
       OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a sales document''s company, kind, origin and author never change' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'DISCARDED' THEN RAISE EXCEPTION 'a discarded sales document cannot change' USING ERRCODE = '42501'; END IF;
    IF OLD.status = 'APPROVED' THEN
      IF NEW.status <> 'APPROVED' OR coalesce(current_setting('app.sales_allocation', true), 'off') <> 'on'
         OR (to_jsonb(NEW) - ARRAY['outstanding','functional_outstanding','updated_at']) <> (to_jsonb(OLD) - ARRAY['outstanding','functional_outstanding','updated_at']) THEN
        RAISE EXCEPTION 'an approved sales document is immutable; correct it with a credit note' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1 THEN RAISE EXCEPTION 'a draft''s revision moves forward by one' USING ERRCODE = '23514'; END IF;
  END IF;
  -- the role is a customer role of this company and belongs to the contact
  SELECT company_id, contact_id INTO r FROM contact_role WHERE id = NEW.customer_role_id AND organisation_id = NEW.organisation_id;
  IF r.company_id IS DISTINCT FROM NEW.company_id OR r.contact_id IS DISTINCT FROM NEW.contact_id THEN RAISE EXCEPTION 'the customer role must belong to this company and contact' USING ERRCODE = '23514'; END IF;
  IF NEW.original_invoice_id IS NOT NULL THEN
    SELECT kind, status, customer_role_id, currency, company_id INTO o FROM sales_document WHERE id = NEW.original_invoice_id AND organisation_id = NEW.organisation_id;
    IF o.kind <> 'INVOICE' OR o.status <> 'APPROVED' OR o.customer_role_id <> NEW.customer_role_id OR o.currency <> NEW.currency OR o.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'a credit note credits an approved invoice of the same customer and currency' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'APPROVED' THEN
    -- the next number of the sequence (the service advanced it in this transaction)
    SELECT last_number INTO seq FROM sales_sequence WHERE organisation_id = NEW.organisation_id AND company_id = NEW.company_id AND kind = NEW.kind;
    IF seq IS DISTINCT FROM NEW.number THEN RAISE EXCEPTION 'a sales document takes the next number of its sequence' USING ERRCODE = '23514'; END IF;
    IF NEW.outstanding <> NEW.gross_total OR NEW.functional_outstanding <> NEW.functional_gross THEN RAISE EXCEPTION 'a new document is outstanding in full' USING ERRCODE = '23514'; END IF;
    SELECT source_type, source_id, journal_date INTO j FROM journal WHERE id = NEW.journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM (CASE NEW.kind WHEN 'INVOICE' THEN 'SALES_INVOICE' ELSE 'SALES_CREDIT_NOTE' END) OR j.source_id IS DISTINCT FROM NEW.id::text OR j.journal_date <> NEW.issue_date THEN
      RAISE EXCEPTION 'an approved sales document points at its own posted journal' USING ERRCODE = '23514';
    END IF;
    SELECT require_separate_approver INTO st FROM sales_setting WHERE organisation_id = NEW.organisation_id AND company_id = NEW.company_id;
    IF coalesce(st.require_separate_approver, false) AND NEW.approved_by_user_id = NEW.created_by_user_id THEN
      RAISE EXCEPTION 'the company requires a different person to approve a sales document' USING ERRCODE = '23514';
    END IF;
    -- DEC-031: until VAT on foreign-currency documents exists, a VAT-registered company does not approve one
    SELECT base_currency INTO base FROM company WHERE id = NEW.company_id AND organisation_id = NEW.organisation_id;
    SELECT registered, registered_from INTO vs FROM company_vat_setting WHERE organisation_id = NEW.organisation_id AND company_id = NEW.company_id;
    IF NEW.currency <> base AND coalesce(vs.registered, false) AND coalesce(NEW.tax_point, NEW.issue_date) >= vs.registered_from THEN
      RAISE EXCEPTION 'a VAT-registered company cannot approve a foreign-currency sales document yet' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_document_guard_trg BEFORE INSERT OR UPDATE ON sales_document FOR EACH ROW EXECUTE FUNCTION sales_document_guard();
CREATE TRIGGER sales_document_no_delete BEFORE DELETE ON sales_document FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sales_document_no_truncate BEFORE TRUNCATE ON sales_document FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Lines: append-only revisions (a draft edit writes a new revision; nothing is updated or deleted) ─────────
CREATE TABLE "sales_document_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" NUMERIC(18,4) NOT NULL,
    "unit_price" NUMERIC(19,4) NOT NULL,
    "account_id" UUID NOT NULL,
    "tax_code_id" UUID,
    "net" NUMERIC(19,4) NOT NULL,
    "vat" NUMERIC(19,4) NOT NULL,
    "gross" NUMERIC(19,4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_document_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT sales_document_line_no_ck CHECK (line_no BETWEEN 1 AND 200 AND revision >= 1),
    CONSTRAINT sales_document_line_amounts_ck CHECK (quantity > 0 AND unit_price >= 0 AND net >= 0 AND vat >= 0 AND gross = net + vat),
    CONSTRAINT sales_document_line_text_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "sales_document_line_key" ON "sales_document_line"("document_id", "revision", "line_no");
CREATE INDEX "sales_document_line_org_idx" ON "sales_document_line"("organisation_id", "document_id", "revision");
ALTER TABLE "sales_document_line" ADD CONSTRAINT "sales_document_line_document_fkey" FOREIGN KEY ("organisation_id", "document_id") REFERENCES "sales_document"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document_line" ADD CONSTRAINT "sales_document_line_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_document_line" ADD CONSTRAINT "sales_document_line_tax_code_fkey" FOREIGN KEY ("organisation_id", "tax_code_id") REFERENCES "tax_code"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION sales_document_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
  SELECT company_id, status, revision INTO d FROM sales_document WHERE id = NEW.document_id AND organisation_id = NEW.organisation_id;
  IF d.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'a line belongs to its document''s company' USING ERRCODE = '23514'; END IF;
  IF d.status <> 'DRAFT' OR NEW.revision <> d.revision THEN RAISE EXCEPTION 'lines are written only for the current revision of a draft' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_document_line_guard_trg BEFORE INSERT ON sales_document_line FOR EACH ROW EXECUTE FUNCTION sales_document_line_guard();
CREATE TRIGGER sales_document_line_no_update BEFORE UPDATE OR DELETE ON sales_document_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sales_document_line_no_truncate BEFORE TRUNCATE ON sales_document_line FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Allocations: the only way an outstanding amount moves (DEC-030) ─────────
CREATE TABLE "sales_allocation" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "credit_id" UUID NOT NULL,
    "amount" NUMERIC(19,4) NOT NULL,
    "invoice_functional" NUMERIC(19,4) NOT NULL,
    "credit_functional" NUMERIC(19,4) NOT NULL,
    "fx_difference" NUMERIC(19,4) NOT NULL,
    "fx_journal_id" UUID,
    "allocated_on" DATE NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_allocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT sales_allocation_amounts_ck CHECK (amount > 0 AND invoice_functional >= 0 AND credit_functional >= 0 AND fx_difference = invoice_functional - credit_functional),
    CONSTRAINT sales_allocation_fx_ck CHECK ((fx_difference = 0) = (fx_journal_id IS NULL))
);
CREATE UNIQUE INDEX "sales_allocation_organisation_id_id_key" ON "sales_allocation"("organisation_id", "id");
CREATE INDEX "sales_allocation_invoice_idx" ON "sales_allocation"("organisation_id", "invoice_id");
CREATE INDEX "sales_allocation_credit_idx" ON "sales_allocation"("organisation_id", "credit_id");
ALTER TABLE "sales_allocation" ADD CONSTRAINT "sales_allocation_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_allocation" ADD CONSTRAINT "sales_allocation_invoice_fkey" FOREIGN KEY ("organisation_id", "invoice_id") REFERENCES "sales_document"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_allocation" ADD CONSTRAINT "sales_allocation_credit_fkey" FOREIGN KEY ("organisation_id", "credit_id") REFERENCES "sales_document"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_allocation" ADD CONSTRAINT "sales_allocation_fx_journal_fkey" FOREIGN KEY ("organisation_id", "company_id", "fx_journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_allocation" ADD CONSTRAINT "sales_allocation_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION sales_allocation_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i RECORD; c RECORD; j RECORD;
BEGIN
  SELECT * INTO i FROM sales_document WHERE id = NEW.invoice_id AND organisation_id = NEW.organisation_id FOR UPDATE;
  SELECT * INTO c FROM sales_document WHERE id = NEW.credit_id AND organisation_id = NEW.organisation_id FOR UPDATE;
  IF i.kind <> 'INVOICE' OR i.status <> 'APPROVED' OR c.kind <> 'CREDIT_NOTE' OR c.status <> 'APPROVED' THEN RAISE EXCEPTION 'an allocation applies an approved credit to an approved invoice' USING ERRCODE = '23514'; END IF;
  IF i.company_id <> NEW.company_id OR c.company_id <> NEW.company_id OR i.customer_role_id <> c.customer_role_id OR i.currency <> c.currency THEN
    RAISE EXCEPTION 'an allocation joins documents of one company, customer and currency' USING ERRCODE = '23514';
  END IF;
  IF c.original_invoice_id <> i.id THEN RAISE EXCEPTION 'a credit note is allocated to the invoice it credits' USING ERRCODE = '23514'; END IF;
  IF NEW.allocated_on < greatest(i.issue_date, c.issue_date) THEN RAISE EXCEPTION 'an allocation cannot precede its documents' USING ERRCODE = '23514'; END IF;
  IF NEW.fx_journal_id IS NOT NULL THEN
    SELECT source_type, source_id, journal_date INTO j FROM journal WHERE id = NEW.fx_journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM 'SALES_ALLOCATION_FX' OR j.source_id IS DISTINCT FROM NEW.id::text OR j.journal_date <> NEW.allocated_on THEN
      RAISE EXCEPTION 'the realised FX journal of an allocation is its own' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- the document checks (never below zero; a cleared original amount leaves no functional remainder) do the rest
  PERFORM set_config('app.sales_allocation', 'on', true);
  UPDATE sales_document SET outstanding = outstanding - NEW.amount, functional_outstanding = functional_outstanding - NEW.invoice_functional, updated_at = now() WHERE id = i.id;
  UPDATE sales_document SET outstanding = outstanding - NEW.amount, functional_outstanding = functional_outstanding - NEW.credit_functional, updated_at = now() WHERE id = c.id;
  PERFORM set_config('app.sales_allocation', 'off', true);
  RETURN NULL;
END $$;
CREATE TRIGGER sales_allocation_apply_trg AFTER INSERT ON sales_allocation FOR EACH ROW EXECUTE FUNCTION sales_allocation_apply();
CREATE TRIGGER sales_allocation_no_update BEFORE UPDATE OR DELETE ON sales_allocation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sales_allocation_no_truncate BEFORE TRUNCATE ON sales_allocation FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Journals: sub-ledger journals are corrected in the sub-ledger, never reversed in the ledger ─────────
CREATE OR REPLACE FUNCTION journal_subledger_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  IF NEW.reverses_journal_id IS NOT NULL THEN
    SELECT source_type INTO st FROM journal WHERE id = NEW.reverses_journal_id AND organisation_id = NEW.organisation_id;
    IF st IN ('SALES_INVOICE','SALES_CREDIT_NOTE','SALES_ALLOCATION_FX') THEN
      RAISE EXCEPTION 'a % journal is corrected with a credit note, not reversed', st USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_subledger_reversal_trg BEFORE INSERT ON journal FOR EACH ROW EXECUTE FUNCTION journal_subledger_reversal_guard();

-- ───────── Credit-note VAT: the rate version of the supply being adjusted (DEC-029) ─────────
ALTER TABLE "journal_line" ADD COLUMN "vat_rate_point" DATE;
ALTER TABLE "journal_line" ADD CONSTRAINT journal_line_vat_rate_point_ck CHECK (vat_rate_point IS NULL OR (tax_rate_id IS NOT NULL AND vat_rate_point <= tax_point));
CREATE OR REPLACE FUNCTION journal_vat_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l RECORD; n RECORD; r RECORD; minor INTEGER; amt NUMERIC; base NUMERIC; expected NUMERIC; rp DATE;
BEGIN
  SELECT minor_units INTO minor FROM currency WHERE code = NEW.currency;
  FOR l IN SELECT * FROM journal_line WHERE journal_id = NEW.id AND organisation_id = NEW.organisation_id AND tax_rate_id IS NOT NULL ORDER BY line_no LOOP
    SELECT tax_code_id, rate, effective_from, effective_to, verification_status, superseded_by_id INTO r FROM tax_rate WHERE id = l.tax_rate_id AND organisation_id = l.organisation_id;
    IF r.tax_code_id <> l.tax_code_id THEN RAISE EXCEPTION 'line % uses a rate of another tax code', l.line_no USING ERRCODE = '23514'; END IF;
    IF r.verification_status <> 'VERIFIED' THEN RAISE EXCEPTION 'line % uses an UNVERIFIED tax rate', l.line_no USING ERRCODE = '23514'; END IF;
    -- an adjustment of an earlier supply (a credit note) takes the rate in force at that supply's tax point; only credit notes and reversals carry one
    IF l.vat_rate_point IS NOT NULL AND NEW.source_type NOT IN ('SALES_CREDIT_NOTE','REVERSAL') THEN RAISE EXCEPTION 'line % names an adjusted supply but the journal is not a credit note', l.line_no USING ERRCODE = '23514'; END IF;
    rp := coalesce(l.vat_rate_point, l.tax_point);
    -- a reversal mirrors history and a credit note adjusts it, so either may use a version superseded since; new supplies may not
    IF r.superseded_by_id IS NOT NULL AND NEW.reverses_journal_id IS NULL AND l.vat_rate_point IS NULL THEN RAISE EXCEPTION 'line % uses a superseded tax rate version', l.line_no USING ERRCODE = '23514'; END IF;
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

-- ───────── Evidence graph: sales documents can be evidence ends (attachments) ─────────
ALTER TABLE "evidence_link" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "evidence_link" DROP CONSTRAINT evidence_link_source_type_ck, DROP CONSTRAINT evidence_link_target_type_ck;
ALTER TABLE "evidence_link"
  ADD CONSTRAINT evidence_link_source_type_ck CHECK (source_type IN ('document','document_version','task','workflow_instance','ai_proposal','contact','company','accounting_period','journal','sales_document')),
  ADD CONSTRAINT evidence_link_target_type_ck CHECK (target_type IN ('document','document_version','task','workflow_instance','ai_proposal','contact','company','accounting_period','journal','sales_document'));
ALTER TABLE "evidence_link" FORCE ROW LEVEL SECURITY;

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_setting','sales_sequence','sales_document','sales_document_line','sales_allocation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "sales_document_line", "sales_allocation" FROM uk_app;

-- ───────── Permissions (DEC-027) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['sales:read','sales:manage','sales:approve']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner','accountant');
UPDATE "role" SET permissions = permissions || ARRAY['sales:read','sales:manage']::text[] WHERE organisation_id IS NULL AND key IN ('manager','bookkeeper');
UPDATE "role" SET permissions = permissions || ARRAY['sales:read']::text[] WHERE organisation_id IS NULL AND key = 'reviewer';
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'sales_setting', 'ACCOUNTING_RECORDS'), ('TABLE', 'sales_sequence', 'ACCOUNTING_RECORDS'),
  ('TABLE', 'sales_document', 'ACCOUNTING_RECORDS'), ('TABLE', 'sales_document_line', 'ACCOUNTING_RECORDS'), ('TABLE', 'sales_allocation', 'ACCOUNTING_RECORDS');
