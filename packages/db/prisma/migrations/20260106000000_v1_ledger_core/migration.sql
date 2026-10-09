-- V1 / milestone M1: ledger core (ADR-44..48). Additive only: new tables, three nullable columns, new permissions for the system roles.
-- Written for a non-superuser owner (ADR-27): the only data statements are the role UPDATEs, with RLS lifted on "role" for this transaction only.

CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- ───────── Chart of accounts ─────────
CREATE TABLE "account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "subtype" TEXT NOT NULL,
    "is_control" BOOLEAN NOT NULL DEFAULT false,
    "control_kind" TEXT,
    "tax_treatment" TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
    "reporting_mapping" TEXT NOT NULL,
    "active_from" DATE,
    "active_to" DATE,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT account_code_ck CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$'),
    CONSTRAINT account_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT account_control_ck CHECK ((is_control AND control_kind IS NOT NULL) OR (NOT is_control AND control_kind IS NULL)),
    CONSTRAINT account_control_kind_ck CHECK (control_kind IS NULL OR control_kind IN ('TRADE_RECEIVABLES','TRADE_PAYABLES','VAT_CONTROL','BANK','CASH','SUSPENSE','RETAINED_EARNINGS')),
    CONSTRAINT account_tax_treatment_ck CHECK (tax_treatment IN ('NOT_APPLICABLE','VATABLE','EXEMPT','OUT_OF_SCOPE','VAT_CONTROL')),
    CONSTRAINT account_active_ck CHECK (active_to IS NULL OR active_from IS NULL OR active_to >= active_from),
    CONSTRAINT account_system_active_ck CHECK (NOT is_system OR active_to IS NULL)
);
CREATE UNIQUE INDEX "account_organisation_id_company_id_code_key" ON "account"("organisation_id", "company_id", "code");
CREATE UNIQUE INDEX "account_organisation_id_company_id_id_key" ON "account"("organisation_id", "company_id", "id");
ALTER TABLE "account" ADD CONSTRAINT "account_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── Per-company journal numbering ─────────
CREATE TABLE "ledger_sequence" (
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ledger_sequence_pkey" PRIMARY KEY ("organisation_id", "company_id"),
    CONSTRAINT ledger_sequence_ck CHECK (last_number >= 0)
);
ALTER TABLE "ledger_sequence" ADD CONSTRAINT "ledger_sequence_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── Journals (immutable) ─────────
CREATE TABLE "journal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "journal_number" INTEGER NOT NULL,
    "journal_date" DATE NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "source_reference" TEXT,
    "description" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total" NUMERIC(19,4) NOT NULL,
    "line_count" INTEGER NOT NULL,
    "actor_type" TEXT NOT NULL,
    "posted_by_user_id" UUID,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "reverses_journal_id" UUID,
    CONSTRAINT "journal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT journal_number_ck CHECK (journal_number > 0),
    CONSTRAINT journal_source_ck CHECK (source_type ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    CONSTRAINT journal_description_ck CHECK (length(btrim(description)) BETWEEN 1 AND 500),
    CONSTRAINT journal_total_ck CHECK (total > 0 AND line_count >= 2),
    CONSTRAINT journal_actor_ck CHECK (actor_type IN ('USER','SYSTEM') AND (actor_type <> 'USER' OR posted_by_user_id IS NOT NULL)),
    CONSTRAINT journal_reversal_ck CHECK ((source_type = 'REVERSAL') = (reverses_journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX "journal_organisation_id_company_id_journal_number_key" ON "journal"("organisation_id", "company_id", "journal_number");
CREATE UNIQUE INDEX "journal_organisation_id_company_id_idempotency_key_key" ON "journal"("organisation_id", "company_id", "idempotency_key");
CREATE UNIQUE INDEX "journal_organisation_id_company_id_id_key" ON "journal"("organisation_id", "company_id", "id");
CREATE UNIQUE INDEX "journal_organisation_id_id_key" ON "journal"("organisation_id", "id");
CREATE UNIQUE INDEX "journal_reverses_journal_id_key" ON "journal"("reverses_journal_id") WHERE reverses_journal_id IS NOT NULL;
CREATE INDEX "journal_organisation_id_company_id_journal_date_idx" ON "journal"("organisation_id", "company_id", "journal_date");
CREATE INDEX "journal_organisation_id_company_id_source_type_source_id_idx" ON "journal"("organisation_id", "company_id", "source_type", "source_id");
ALTER TABLE "journal" ADD CONSTRAINT "journal_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal" ADD CONSTRAINT "journal_organisation_id_period_id_fkey" FOREIGN KEY ("organisation_id", "period_id") REFERENCES "accounting_period"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal" ADD CONSTRAINT "journal_organisation_id_reverses_journal_id_fkey" FOREIGN KEY ("organisation_id", "reverses_journal_id") REFERENCES "journal"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal" ADD CONSTRAINT "journal_posted_by_user_id_fkey" FOREIGN KEY ("posted_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "journal_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "debit" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "credit" NUMERIC(19,4) NOT NULL DEFAULT 0,
    "description" TEXT,
    CONSTRAINT "journal_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT journal_line_amount_ck CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0) <> (credit > 0))),
    CONSTRAINT journal_line_no_ck CHECK (line_no > 0)
);
CREATE UNIQUE INDEX "journal_line_journal_id_line_no_key" ON "journal_line"("journal_id", "line_no");
CREATE INDEX "journal_line_account_idx" ON "journal_line"("organisation_id", "company_id", "account_id", "journal_id");
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_journal_fkey" FOREIGN KEY ("organisation_id", "company_id", "journal_id") REFERENCES "journal"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Accounting periods: who/when/why the state last changed ─────────
ALTER TABLE "accounting_period"
  ADD COLUMN "status_changed_at" TIMESTAMPTZ(3),
  ADD COLUMN "status_changed_by_user_id" UUID,
  ADD COLUMN "status_reason" TEXT;

-- ───────── Row-level security (forced) ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account','ledger_sequence','journal','journal_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
  END LOOP;
END $$;

-- Least privilege (default privileges would grant full DML): the ledger is append-only, accounts are deactivated never deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON "journal" FROM uk_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "journal_line" FROM uk_app;
REVOKE DELETE, TRUNCATE ON "account" FROM uk_app;
REVOKE DELETE, TRUNCATE ON "ledger_sequence" FROM uk_app;

-- ───────── Ledger guards (second line of defence behind the PostingService) ─────────
-- 1. Journals exist only through the PostingService, in an OPEN period that contains their date, in the company's base currency.
CREATE OR REPLACE FUNCTION journal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p RECORD; base CHAR(3); orig RECORD;
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
  RETURN NEW;
END $$;
CREATE TRIGGER journal_insert_guard_trg BEFORE INSERT ON journal FOR EACH ROW EXECUTE FUNCTION journal_insert_guard();

-- 2. Lines can only be added by the PostingService, in the transaction that created their journal, to an active account, with amounts that
--    respect the currency's minor units.
CREATE OR REPLACE FUNCTION journal_line_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j RECORD; a RECORD; minor INTEGER;
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
  RETURN NEW;
END $$;
CREATE TRIGGER journal_line_insert_guard_trg BEFORE INSERT ON journal_line FOR EACH ROW EXECUTE FUNCTION journal_line_insert_guard();

-- 3. At COMMIT: debits equal credits, the header agrees with its lines, line numbers are contiguous, a reversal mirrors its original per account.
CREATE OR REPLACE FUNCTION journal_integrity_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d NUMERIC; c NUMERIC; n INTEGER; mx INTEGER;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*), coalesce(max(line_no), 0) INTO d, c, n, mx FROM journal_line WHERE journal_id = NEW.id AND organisation_id = NEW.organisation_id;
  IF d <> c THEN RAISE EXCEPTION 'journal % is not balanced (debits % credits %)', NEW.journal_number, d, c USING ERRCODE = '23514'; END IF;
  IF d <> NEW.total OR n <> NEW.line_count OR n < 2 OR mx <> n THEN
    RAISE EXCEPTION 'journal % header does not match its lines', NEW.journal_number USING ERRCODE = '23514';
  END IF;
  IF NEW.reverses_journal_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM (SELECT account_id, sum(debit) AS d, sum(credit) AS c FROM journal_line WHERE journal_id = NEW.id AND organisation_id = NEW.organisation_id GROUP BY account_id) r
      FULL JOIN (SELECT account_id, sum(debit) AS d, sum(credit) AS c FROM journal_line WHERE journal_id = NEW.reverses_journal_id AND organisation_id = NEW.organisation_id GROUP BY account_id) o USING (account_id)
     WHERE coalesce(r.d, 0) <> coalesce(o.c, 0) OR coalesce(r.c, 0) <> coalesce(o.d, 0)
  ) THEN
    RAISE EXCEPTION 'reversal journal % must mirror the journal it reverses', NEW.journal_number USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_integrity_trg AFTER INSERT ON journal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_integrity_check();

-- 4. Posted journals are immutable (privileges are the first line; this is the second).
CREATE TRIGGER journal_no_mutation BEFORE UPDATE OR DELETE ON journal FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON journal FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_line_no_mutation BEFORE UPDATE OR DELETE ON journal_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_line_no_truncate BEFORE TRUNCATE ON journal_line FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- 5. Accounts: identity fields cannot change once the account has postings; system accounts stay active; deactivation cannot precede a posting.
CREATE OR REPLACE FUNCTION account_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_posting DATE; used BOOLEAN;
BEGIN
  IF NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.is_system <> OLD.is_system THEN
    RAISE EXCEPTION 'account ownership and the system flag are immutable' USING ERRCODE = '42501';
  END IF;
  SELECT max(j.journal_date), count(*) > 0 INTO last_posting, used FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
   WHERE l.account_id = OLD.id AND l.organisation_id = OLD.organisation_id;
  IF used THEN
    IF NEW.code <> OLD.code OR NEW.type <> OLD.type OR NEW.is_control <> OLD.is_control OR NEW.control_kind IS DISTINCT FROM OLD.control_kind THEN
      RAISE EXCEPTION 'code, type and control flags cannot change once the account has postings' USING ERRCODE = '23514';
    END IF;
    IF NEW.active_to IS NOT NULL AND NEW.active_to < last_posting THEN
      RAISE EXCEPTION 'account cannot be deactivated before its last posting (%)', last_posting USING ERRCODE = '23514';
    END IF;
    IF NEW.active_from IS NOT NULL AND (SELECT min(j.journal_date) FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id WHERE l.account_id = OLD.id AND l.organisation_id = OLD.organisation_id) < NEW.active_from THEN
      RAISE EXCEPTION 'account cannot start after its first posting' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_update_guard_trg BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION account_update_guard();

-- 6. Accounting period states: OPEN <-> CLOSED -> LOCKED -> CLOSED; always by a signed-in user (never an anonymous or system context).
CREATE OR REPLACE FUNCTION accounting_period_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status::text = 'OPEN' AND NEW.status::text = 'CLOSED') OR (OLD.status::text = 'CLOSED' AND NEW.status::text IN ('OPEN','LOCKED')) OR (OLD.status::text = 'LOCKED' AND NEW.status::text = 'CLOSED')) THEN
      RAISE EXCEPTION 'accounting period cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF app_user() IS NULL THEN RAISE EXCEPTION 'accounting period state changes need a signed-in user' USING ERRCODE = '42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounting_period_state_guard_trg BEFORE UPDATE OF status ON accounting_period FOR EACH ROW EXECUTE FUNCTION accounting_period_state_guard();

-- ───────── System roles gain the five new COMPANY permissions ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['account:read','account:manage','ledger:read','journal:post','period:lock']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner');
UPDATE "role" SET permissions = permissions || ARRAY['account:read','account:manage','ledger:read','journal:post']::text[] WHERE organisation_id IS NULL AND key IN ('manager','accountant');
UPDATE "role" SET permissions = permissions || ARRAY['account:read','ledger:read']::text[] WHERE organisation_id IS NULL AND key IN ('bookkeeper','reviewer');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification of the new tables (ADR-39; reference data, classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
('TABLE', 'account', 'ACCOUNTING_RECORDS'), ('TABLE', 'journal', 'ACCOUNTING_RECORDS'), ('TABLE', 'journal_line', 'ACCOUNTING_RECORDS'), ('TABLE', 'ledger_sequence', 'ACCOUNTING_RECORDS');
