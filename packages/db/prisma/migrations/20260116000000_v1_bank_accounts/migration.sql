-- V1 / milestone M7a: bank accounts, CSV statement imports and statement lines, transfers (DEC-038..041, ADR-61). Additive.
-- Written for a non-superuser owner (ADR-27): data statements lift RLS on the specific table for this transaction only.

-- ───────── Bank accounts: what the bank knows about a CURRENT_ASSET_BANK ledger account ─────────
CREATE TABLE "bank_account" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "bank_name" TEXT,
    "currency" CHAR(3) NOT NULL,
    -- sort code, account number, IBAN, BIC: AES-256-GCM with the platform field key (AAD = bank_account:<id>); only the masked form is ever listed
    "account_details_enc" TEXT,
    "account_details_masked" TEXT,
    "statement_opening_date" DATE NOT NULL,
    "statement_opening_balance" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "charges_account_id" UUID,
    "interest_received_account_id" UUID,
    "interest_paid_account_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_user_id" UUID,
    "closed_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT bank_account_status_ck CHECK ((status = 'ACTIVE' AND closed_at IS NULL AND closed_by_user_id IS NULL AND closed_reason IS NULL)
      OR (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL AND char_length(btrim(closed_reason)) >= 10)),
    CONSTRAINT bank_account_text_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 100 AND (bank_name IS NULL OR char_length(bank_name) <= 100)
      AND ((account_details_enc IS NULL) = (account_details_masked IS NULL)) AND (account_details_masked IS NULL OR char_length(account_details_masked) <= 200))
);
CREATE UNIQUE INDEX "bank_account_organisation_id_id_key" ON "bank_account"("organisation_id", "id");
CREATE UNIQUE INDEX "bank_account_company_id_id_key" ON "bank_account"("organisation_id", "company_id", "id");
CREATE UNIQUE INDEX "bank_account_ledger_account_key" ON "bank_account"("account_id");
CREATE INDEX "bank_account_company_idx" ON "bank_account"("organisation_id", "company_id", "status");
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_ledger_fkey" FOREIGN KEY ("organisation_id", "company_id", "account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_charges_fkey" FOREIGN KEY ("organisation_id", "company_id", "charges_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_int_rec_fkey" FOREIGN KEY ("organisation_id", "company_id", "interest_received_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_int_paid_fkey" FOREIGN KEY ("organisation_id", "company_id", "interest_paid_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_closed_by_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Statement imports (one uploaded CSV into one bank account) and their lines ─────────
CREATE TABLE "bank_statement_import" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "mapping" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "job_id" UUID,
    "rows_read" INTEGER,
    "rows_imported" INTEGER,
    "rows_duplicate" INTEGER,
    "errors" JSONB,
    "first_date" DATE,
    "last_date" DATE,
    "opening_balance" NUMERIC(19,4),
    "closing_balance" NUMERIC(19,4),
    "duplicate_override_reason" TEXT,
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_statement_import_pkey" PRIMARY KEY ("id"),
    CONSTRAINT bank_statement_import_status_ck CHECK (status IN ('QUEUED','COMPLETED','FAILED','VOID')
      AND ((status = 'VOID') = (voided_at IS NOT NULL)) AND ((voided_at IS NULL) = (voided_by_user_id IS NULL)) AND ((voided_at IS NULL) = (void_reason IS NULL))
      AND (void_reason IS NULL OR char_length(btrim(void_reason)) >= 10)
      AND (status = 'QUEUED' OR completed_at IS NOT NULL)
      AND (duplicate_override_reason IS NULL OR char_length(btrim(duplicate_override_reason)) >= 10))
);
CREATE UNIQUE INDEX "bank_statement_import_organisation_id_id_key" ON "bank_statement_import"("organisation_id", "id");
CREATE INDEX "bank_statement_import_account_idx" ON "bank_statement_import"("organisation_id", "bank_account_id", "requested_at");
CREATE INDEX "bank_statement_import_sha_idx" ON "bank_statement_import"("organisation_id", "bank_account_id", "file_sha256");
ALTER TABLE "bank_statement_import" ADD CONSTRAINT "bank_statement_import_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "bank_account_id") REFERENCES "bank_account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_statement_import" ADD CONSTRAINT "bank_statement_import_version_fkey" FOREIGN KEY ("organisation_id", "document_version_id") REFERENCES "document_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_statement_import" ADD CONSTRAINT "bank_statement_import_requested_by_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_statement_import" ADD CONSTRAINT "bank_statement_import_voided_by_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "bank_statement_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "source_row" INTEGER NOT NULL,
    "transaction_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    -- signed, in the bank account's currency: positive = money in, negative = money out
    "amount" NUMERIC(19,4) NOT NULL,
    "balance" NUMERIC(19,4),
    "fingerprint" CHAR(64) NOT NULL,
    -- M7b: the part already matched to ledger entries (same sign as the amount); moved only by a match or unmatch
    "matched_amount" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_statement_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT bank_statement_line_ck CHECK (amount <> 0 AND line_no >= 1 AND source_row >= 1 AND char_length(description) BETWEEN 1 AND 500 AND (reference IS NULL OR char_length(reference) <= 200)
      AND sign(matched_amount) IN (0, sign(amount)) AND abs(matched_amount) <= abs(amount) AND (NOT voided OR matched_amount = 0))
);
CREATE UNIQUE INDEX "bank_statement_line_organisation_id_id_key" ON "bank_statement_line"("organisation_id", "id");
CREATE UNIQUE INDEX "bank_statement_line_no_key" ON "bank_statement_line"("import_id", "line_no");
-- a line of the bank is imported once: overlapping statements skip what is already there (voided imports release their fingerprints)
CREATE UNIQUE INDEX "bank_statement_line_fingerprint_key" ON "bank_statement_line"("bank_account_id", "fingerprint") WHERE NOT voided;
CREATE INDEX "bank_statement_line_account_idx" ON "bank_statement_line"("organisation_id", "bank_account_id", "transaction_date");
ALTER TABLE "bank_statement_line" ADD CONSTRAINT "bank_statement_line_import_fkey" FOREIGN KEY ("organisation_id", "import_id") REFERENCES "bank_statement_import"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_statement_line" ADD CONSTRAINT "bank_statement_line_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "bank_account_id") REFERENCES "bank_account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Transfers between bank and cash accounts (one balanced journal) ─────────
CREATE TABLE "bank_transfer" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "from_account_id" UUID NOT NULL,
    "to_account_id" UUID NOT NULL,
    "transfer_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" NUMERIC(19,4) NOT NULL,
    "reference" TEXT,
    "description" TEXT NOT NULL,
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
    CONSTRAINT "bank_transfer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT bank_transfer_accounts_ck CHECK (from_account_id <> to_account_id AND amount > 0),
    CONSTRAINT bank_transfer_status_ck CHECK ((status = 'POSTED' AND reversal_journal_id IS NULL AND reversed_by_user_id IS NULL AND reversed_at IS NULL AND reversed_reason IS NULL)
      OR (status = 'REVERSED' AND reversal_journal_id IS NOT NULL AND reversed_by_user_id IS NOT NULL AND reversed_at IS NOT NULL AND char_length(btrim(reversed_reason)) >= 3)),
    CONSTRAINT bank_transfer_text_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 500 AND (reference IS NULL OR char_length(reference) <= 100)
      AND (duplicate_override_reason IS NULL OR char_length(btrim(duplicate_override_reason)) >= 10))
);
CREATE UNIQUE INDEX "bank_transfer_organisation_id_id_key" ON "bank_transfer"("organisation_id", "id");
CREATE UNIQUE INDEX "bank_transfer_journal_key" ON "bank_transfer"("journal_id");
CREATE INDEX "bank_transfer_date_idx" ON "bank_transfer"("organisation_id", "company_id", "transfer_date");
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_from_fkey" FOREIGN KEY ("organisation_id", "company_id", "from_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_to_fkey" FOREIGN KEY ("organisation_id", "company_id", "to_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_journal_fkey" FOREIGN KEY ("organisation_id", "company_id", "journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_reversal_fkey" FOREIGN KEY ("organisation_id", "company_id", "reversal_journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_reversed_by_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Guards (second line of defence behind the services) ─────────
-- A bank account sits on a CURRENT_ASSET_BANK account of its company; its ledger account never changes; its currency is fixed once a line exists.
CREATE OR REPLACE FUNCTION bank_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD;
BEGIN
  SELECT subtype INTO a FROM account WHERE id = NEW.account_id AND organisation_id = NEW.organisation_id AND company_id = NEW.company_id;
  IF a.subtype IS DISTINCT FROM 'CURRENT_ASSET_BANK' THEN RAISE EXCEPTION 'a bank account sits on a bank ledger account of its company' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id <> OLD.account_id OR NEW.company_id <> OLD.company_id OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a bank account keeps its ledger account and company' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'CLOSED' THEN RAISE EXCEPTION 'a closed bank account cannot change' USING ERRCODE = '42501'; END IF;
    IF (NEW.currency <> OLD.currency OR NEW.statement_opening_date <> OLD.statement_opening_date OR NEW.statement_opening_balance <> OLD.statement_opening_balance)
       AND EXISTS (SELECT 1 FROM bank_statement_line WHERE bank_account_id = NEW.id AND organisation_id = NEW.organisation_id AND NOT voided) THEN
      RAISE EXCEPTION 'the currency and statement opening point are fixed once statement lines exist' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_account_guard_trg BEFORE INSERT OR UPDATE ON bank_account FOR EACH ROW EXECUTE FUNCTION bank_account_guard();
CREATE TRIGGER bank_account_no_delete BEFORE DELETE ON bank_account FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bank_account_no_truncate BEFORE TRUNCATE ON bank_account FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- An import is requested QUEUED for an ACTIVE account and an AVAILABLE (scanned) document of the company; then QUEUED -> COMPLETED | FAILED once,
-- and COMPLETED -> VOID once, only while none of its lines is matched. What was imported never changes.
CREATE OR REPLACE FUNCTION bank_statement_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b RECORD; v RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' THEN RAISE EXCEPTION 'an import starts QUEUED' USING ERRCODE = '23514'; END IF;
    SELECT company_id, status INTO b FROM bank_account WHERE id = NEW.bank_account_id AND organisation_id = NEW.organisation_id;
    IF b.status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'statements are imported into an active bank account' USING ERRCODE = '23514'; END IF;
    SELECT dv.document_id, dv.status::text AS status, d.company_id INTO v FROM document_version dv JOIN document d ON d.id = dv.document_id AND d.organisation_id = dv.organisation_id
     WHERE dv.id = NEW.document_version_id AND dv.organisation_id = NEW.organisation_id;
    IF v.status IS DISTINCT FROM 'AVAILABLE' OR v.document_id <> NEW.document_id OR v.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'a statement is imported from a scanned, available document of the same company' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','job_id','rows_read','rows_imported','rows_duplicate','errors','first_date','last_date','opening_balance','closing_balance','completed_at','voided_by_user_id','voided_at','void_reason','updated_at'])
     <> (to_jsonb(OLD) - ARRAY['status','job_id','rows_read','rows_imported','rows_duplicate','errors','first_date','last_date','opening_balance','closing_balance','completed_at','voided_by_user_id','voided_at','void_reason','updated_at']) THEN
    RAISE EXCEPTION 'an import request is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('FAILED','VOID') THEN RAISE EXCEPTION 'a % import cannot change', lower(OLD.status) USING ERRCODE = '42501'; END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'QUEUED' AND NEW.status IN ('COMPLETED','FAILED')) OR (OLD.status = 'COMPLETED' AND NEW.status = 'VOID')) THEN
    RAISE EXCEPTION 'an import moves QUEUED -> COMPLETED | FAILED, then COMPLETED -> VOID' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'QUEUED' AND NEW.job_id IS DISTINCT FROM OLD.job_id THEN RAISE EXCEPTION 'the job of an import is fixed once it has run' USING ERRCODE = '42501'; END IF;
  IF OLD.status <> 'QUEUED' AND (NEW.rows_read IS DISTINCT FROM OLD.rows_read OR NEW.rows_imported IS DISTINCT FROM OLD.rows_imported OR NEW.rows_duplicate IS DISTINCT FROM OLD.rows_duplicate
     OR NEW.errors IS DISTINCT FROM OLD.errors OR NEW.first_date IS DISTINCT FROM OLD.first_date OR NEW.last_date IS DISTINCT FROM OLD.last_date OR NEW.opening_balance IS DISTINCT FROM OLD.opening_balance
     OR NEW.closing_balance IS DISTINCT FROM OLD.closing_balance OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'the outcome of an import is recorded once' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'COMPLETED' AND OLD.status = 'QUEUED' THEN
    IF NEW.rows_imported IS DISTINCT FROM (SELECT count(*)::int FROM bank_statement_line WHERE import_id = NEW.id AND organisation_id = NEW.organisation_id) THEN
      RAISE EXCEPTION 'a completed import counts exactly the lines it stored' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'FAILED' AND EXISTS (SELECT 1 FROM bank_statement_line WHERE import_id = NEW.id AND organisation_id = NEW.organisation_id) THEN
    RAISE EXCEPTION 'a failed import stores nothing (all or nothing)' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'VOID' AND OLD.status = 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM bank_statement_line WHERE import_id = NEW.id AND organisation_id = NEW.organisation_id AND matched_amount <> 0) THEN
      RAISE EXCEPTION 'an import with matched lines cannot be voided; unmatch them first' USING ERRCODE = '23514';
    END IF;
    PERFORM set_config('app.bank_void', 'on', true);
    UPDATE bank_statement_line SET voided = true WHERE import_id = NEW.id AND organisation_id = NEW.organisation_id;
    PERFORM set_config('app.bank_void', 'off', true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_import_guard_trg BEFORE INSERT OR UPDATE ON bank_statement_import FOR EACH ROW EXECUTE FUNCTION bank_statement_import_guard();
CREATE TRIGGER bank_statement_import_no_delete BEFORE DELETE ON bank_statement_import FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bank_statement_import_no_truncate BEFORE TRUNCATE ON bank_statement_import FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- A line is stored only while its import is QUEUED, for the import's account; afterwards only `voided` (with its import) and `matched_amount` (M7b) move.
CREATE OR REPLACE FUNCTION bank_statement_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, bank_account_id, company_id INTO i FROM bank_statement_import WHERE id = NEW.import_id AND organisation_id = NEW.organisation_id;
    IF i.status IS DISTINCT FROM 'QUEUED' OR i.bank_account_id <> NEW.bank_account_id OR i.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'statement lines are stored by their own import while it runs' USING ERRCODE = '42501';
    END IF;
    IF NEW.voided OR NEW.matched_amount <> 0 THEN RAISE EXCEPTION 'a statement line starts unmatched' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['matched_amount','voided']) <> (to_jsonb(OLD) - ARRAY['matched_amount','voided']) THEN
    RAISE EXCEPTION 'a statement line is a fact from the bank and is never edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.voided <> OLD.voided AND (OLD.voided OR coalesce(current_setting('app.bank_void', true), 'off') <> 'on') THEN
    RAISE EXCEPTION 'statement lines are voided only with their import' USING ERRCODE = '42501';
  END IF;
  IF NEW.matched_amount <> OLD.matched_amount AND coalesce(current_setting('app.bank_match', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'the matched part of a statement line moves only through a match or an unmatch' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_line_guard_trg BEFORE INSERT OR UPDATE ON bank_statement_line FOR EACH ROW EXECUTE FUNCTION bank_statement_line_guard();
CREATE TRIGGER bank_statement_line_no_delete BEFORE DELETE ON bank_statement_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bank_statement_line_no_truncate BEFORE TRUNCATE ON bank_statement_line FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- A transfer is POSTED by its own BANK_TRANSFER journal between two bank or cash accounts; REVERSED once by its own reversal journal, which mirrors it line by line.
CREATE OR REPLACE FUNCTION bank_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j RECORD; f TEXT; t TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'POSTED' THEN RAISE EXCEPTION 'a transfer starts POSTED' USING ERRCODE = '23514'; END IF;
    SELECT source_type, source_id, journal_date INTO j FROM journal WHERE id = NEW.journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM 'BANK_TRANSFER' OR j.source_id IS DISTINCT FROM NEW.id::text OR j.journal_date <> NEW.transfer_date THEN
      RAISE EXCEPTION 'a transfer points at its own posted journal' USING ERRCODE = '23514';
    END IF;
    SELECT subtype INTO f FROM account WHERE id = NEW.from_account_id AND organisation_id = NEW.organisation_id;
    SELECT subtype INTO t FROM account WHERE id = NEW.to_account_id AND organisation_id = NEW.organisation_id;
    IF f NOT IN ('CURRENT_ASSET_BANK','CURRENT_ASSET_CASH') OR t NOT IN ('CURRENT_ASSET_BANK','CURRENT_ASSET_CASH') THEN
      RAISE EXCEPTION 'a transfer moves money between bank or cash accounts' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','reversal_journal_id','reversed_by_user_id','reversed_at','reversed_reason','updated_at'])
     <> (to_jsonb(OLD) - ARRAY['status','reversal_journal_id','reversed_by_user_id','reversed_at','reversed_reason','updated_at']) THEN
    RAISE EXCEPTION 'a transfer is immutable; reverse it' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'a reversed transfer cannot change' USING ERRCODE = '42501'; END IF;
  IF NEW.status = 'REVERSED' THEN
    SELECT source_type, source_id, journal_date INTO j FROM journal WHERE id = NEW.reversal_journal_id AND organisation_id = NEW.organisation_id;
    IF j.source_type IS DISTINCT FROM 'BANK_TRANSFER_REVERSAL' OR j.source_id IS DISTINCT FROM NEW.id::text OR j.journal_date < NEW.transfer_date THEN
      RAISE EXCEPTION 'a transfer reversal points at its own reversal journal, dated on or after the transfer' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM (SELECT * FROM journal_line WHERE journal_id = NEW.journal_id AND organisation_id = NEW.organisation_id) o
        FULL JOIN (SELECT * FROM journal_line WHERE journal_id = NEW.reversal_journal_id AND organisation_id = NEW.organisation_id) r USING (line_no)
       WHERE o.account_id IS DISTINCT FROM r.account_id OR o.debit IS DISTINCT FROM r.credit OR o.credit IS DISTINCT FROM r.debit
          OR o.original_currency IS DISTINCT FROM r.original_currency OR o.original_debit IS DISTINCT FROM r.original_credit OR o.original_credit IS DISTINCT FROM r.original_debit
    ) THEN
      RAISE EXCEPTION 'a transfer reversal must mirror its posted journal line by line' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_transfer_guard_trg BEFORE INSERT OR UPDATE ON bank_transfer FOR EACH ROW EXECUTE FUNCTION bank_transfer_guard();
CREATE TRIGGER bank_transfer_no_delete BEFORE DELETE ON bank_transfer FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bank_transfer_no_truncate BEFORE TRUNCATE ON bank_transfer FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Transfer journals are corrected by their own mirror reversal, never by a ledger reversal ─────────
CREATE OR REPLACE FUNCTION journal_subledger_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  IF NEW.reverses_journal_id IS NOT NULL THEN
    SELECT source_type INTO st FROM journal WHERE id = NEW.reverses_journal_id AND organisation_id = NEW.organisation_id;
    IF st IN ('SALES_INVOICE','SALES_CREDIT_NOTE','SALES_ALLOCATION_FX','SALES_RECEIPT','SALES_RECEIPT_REVERSAL','PURCHASE_BILL','PURCHASE_DEBIT_NOTE','PURCHASE_ALLOCATION_FX','PURCHASE_PAYMENT','PURCHASE_PAYMENT_REVERSAL',
              'CASH_PAYMENT','CASH_RECEIPT','CASH_PAYMENT_REVERSAL','CASH_RECEIPT_REVERSAL','BANK_TRANSFER','BANK_TRANSFER_REVERSAL') THEN
      RAISE EXCEPTION 'a % journal is corrected in its sub-ledger (a credit or debit note, or a receipt, payment, cash transaction or transfer reversal), not reversed', st USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_account','bank_statement_import','bank_statement_line','bank_transfer']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

-- ───────── Permissions (DEC-039, DEC-041) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['bank:read','bank:manage','bank:transfer']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner','accountant');
UPDATE "role" SET permissions = permissions || ARRAY['bank:read','bank:manage']::text[] WHERE organisation_id IS NULL AND key IN ('manager','bookkeeper');
UPDATE "role" SET permissions = permissions || ARRAY['bank:read']::text[] WHERE organisation_id IS NULL AND key = 'reviewer';
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'bank_account', 'ACCOUNTING_RECORDS'), ('TABLE', 'bank_statement_import', 'ACCOUNTING_RECORDS'),
  ('TABLE', 'bank_statement_line', 'ACCOUNTING_RECORDS'), ('TABLE', 'bank_transfer', 'ACCOUNTING_RECORDS');
