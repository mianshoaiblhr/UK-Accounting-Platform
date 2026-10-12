-- V1 / milestone M4a: customers and suppliers as roles of the shared contact (DEC-011, DEC-023, DEC-024). Additive.
-- Written for a non-superuser owner (ADR-27): data statements lift RLS on the specific table for this transaction only.

-- ───────── Counterparty VAT number (format only; DEC-024) ─────────
ALTER TABLE "contact" ADD COLUMN "vat_number" TEXT;
ALTER TABLE "contact" ADD CONSTRAINT contact_vat_number_ck CHECK (vat_number IS NULL OR vat_number ~ '^((GB|XI)([0-9]{9}|[0-9]{12})|(?!GB|XI)[A-Z]{2}[0-9A-Z+*]{8,12})$') NOT VALID;

-- ───────── Roles ─────────
CREATE TABLE "contact_role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "account_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_user_id" UUID,
    "ended_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contact_role_pkey" PRIMARY KEY ("id"),
    CONSTRAINT contact_role_role_ck CHECK (role IN ('CUSTOMER','SUPPLIER')),
    CONSTRAINT contact_role_status_ck CHECK ((status = 'ACTIVE' AND ended_at IS NULL AND ended_by_user_id IS NULL AND ended_reason IS NULL)
      OR (status = 'ENDED' AND ended_at IS NOT NULL AND ended_by_user_id IS NOT NULL AND ended_reason IS NOT NULL AND char_length(btrim(ended_reason)) >= 3)),
    CONSTRAINT contact_role_account_code_ck CHECK (account_code IS NULL OR account_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$')
);
CREATE UNIQUE INDEX "contact_role_organisation_id_id_key" ON "contact_role"("organisation_id", "id");
CREATE UNIQUE INDEX "contact_role_id_role_key" ON "contact_role"("id", "role");
CREATE UNIQUE INDEX "contact_role_company_contact_role_key" ON "contact_role"("organisation_id", "company_id", "contact_id", "role");
CREATE UNIQUE INDEX "contact_role_account_code_key" ON "contact_role"("organisation_id", "company_id", "role", upper("account_code")) WHERE account_code IS NOT NULL;
CREATE INDEX "contact_role_company_idx" ON "contact_role"("organisation_id", "company_id", "role", "status");
ALTER TABLE "contact_role" ADD CONSTRAINT "contact_role_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contact_role" ADD CONSTRAINT "contact_role_contact_fkey" FOREIGN KEY ("organisation_id", "contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contact_role" ADD CONSTRAINT "contact_role_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contact_role" ADD CONSTRAINT "contact_role_ended_by_fkey" FOREIGN KEY ("ended_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- a company-linked contact takes roles only in its own company; the role's identity never changes
CREATE OR REPLACE FUNCTION contact_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cc UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.contact_id <> OLD.contact_id OR NEW.role <> OLD.role
       OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a contact role''s company, contact and role never change; end it and create another' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT company_id INTO cc FROM contact WHERE id = NEW.contact_id AND organisation_id = NEW.organisation_id;
  IF cc IS NOT NULL AND cc <> NEW.company_id THEN
    RAISE EXCEPTION 'this contact belongs to another company and cannot take a role here' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_role_guard_trg BEFORE INSERT OR UPDATE ON contact_role FOR EACH ROW EXECUTE FUNCTION contact_role_guard();
CREATE TRIGGER contact_role_no_delete BEFORE DELETE ON contact_role FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER contact_role_no_truncate BEFORE TRUNCATE ON contact_role FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Role-specific profiles; the database ties each profile to a role of the right kind ─────────
CREATE TABLE "customer_profile" (
    "role_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "credit_limit" NUMERIC(19,4),
    "default_currency" CHAR(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_profile_pkey" PRIMARY KEY ("role_id"),
    CONSTRAINT customer_profile_role_ck CHECK (role = 'CUSTOMER'),
    CONSTRAINT customer_profile_terms_ck CHECK (payment_terms_days BETWEEN 0 AND 365),
    CONSTRAINT customer_profile_limit_ck CHECK (credit_limit IS NULL OR credit_limit >= 0)
);
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_role_fkey" FOREIGN KEY ("role_id", "role") REFERENCES "contact_role"("id", "role") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_org_role_fkey" FOREIGN KEY ("organisation_id", "role_id") REFERENCES "contact_role"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_currency_fkey" FOREIGN KEY ("default_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "supplier_profile" (
    "role_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'SUPPLIER',
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "default_currency" CHAR(3),
    "default_expense_account_id" UUID,
    -- field-level encrypted JSON {accountName, sortCode, accountNumber, iban, bic}; never stored or logged in clear
    "bank_details_enc" TEXT,
    "bank_details_masked" TEXT,
    "bank_details_status" TEXT NOT NULL DEFAULT 'NONE',
    "bank_details_changed_by_user_id" UUID,
    "bank_details_changed_at" TIMESTAMPTZ(3),
    "bank_details_verified_by_user_id" UUID,
    "bank_details_verified_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "supplier_profile_pkey" PRIMARY KEY ("role_id"),
    CONSTRAINT supplier_profile_role_ck CHECK (role = 'SUPPLIER'),
    CONSTRAINT supplier_profile_terms_ck CHECK (payment_terms_days BETWEEN 0 AND 365),
    CONSTRAINT supplier_profile_bank_ck CHECK (
      (bank_details_status = 'NONE' AND bank_details_enc IS NULL AND bank_details_masked IS NULL AND bank_details_verified_by_user_id IS NULL)
      OR (bank_details_status = 'UNVERIFIED' AND bank_details_enc IS NOT NULL AND bank_details_masked IS NOT NULL AND bank_details_changed_by_user_id IS NOT NULL AND bank_details_verified_by_user_id IS NULL AND bank_details_verified_at IS NULL)
      OR (bank_details_status = 'VERIFIED' AND bank_details_enc IS NOT NULL AND bank_details_masked IS NOT NULL AND bank_details_verified_by_user_id IS NOT NULL AND bank_details_verified_at IS NOT NULL
          AND bank_details_verified_by_user_id <> bank_details_changed_by_user_id)),
    -- the ciphertext format of FieldEncryption (never plain digits)
    CONSTRAINT supplier_profile_enc_ck CHECK (bank_details_enc IS NULL OR bank_details_enc !~ '^[0-9 -]+$')
);
ALTER TABLE "supplier_profile" ADD CONSTRAINT "supplier_profile_role_fkey" FOREIGN KEY ("role_id", "role") REFERENCES "contact_role"("id", "role") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_profile" ADD CONSTRAINT "supplier_profile_org_role_fkey" FOREIGN KEY ("organisation_id", "role_id") REFERENCES "contact_role"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_profile" ADD CONSTRAINT "supplier_profile_currency_fkey" FOREIGN KEY ("default_currency") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_profile" ADD CONSTRAINT "supplier_profile_expense_fkey" FOREIGN KEY ("organisation_id", "company_id", "default_expense_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- a bank-detail change always resets verification; only a different person can verify it (DEC-023)
CREATE OR REPLACE FUNCTION supplier_bank_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role_id <> OLD.role_id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'a profile belongs to one role' USING ERRCODE = '42501';
  END IF;
  IF NEW.bank_details_enc IS DISTINCT FROM OLD.bank_details_enc AND NEW.bank_details_enc IS NOT NULL AND NEW.bank_details_status <> 'UNVERIFIED' THEN
    RAISE EXCEPTION 'changed bank details start UNVERIFIED' USING ERRCODE = '23514';
  END IF;
  IF NEW.bank_details_status = 'VERIFIED' AND OLD.bank_details_status <> 'VERIFIED' AND NEW.bank_details_enc IS DISTINCT FROM OLD.bank_details_enc THEN
    RAISE EXCEPTION 'bank details cannot be changed and verified in one step' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_bank_guard_trg BEFORE UPDATE ON supplier_profile FOR EACH ROW EXECUTE FUNCTION supplier_bank_guard();
CREATE OR REPLACE FUNCTION customer_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role_id <> OLD.role_id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'a profile belongs to one role' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_profile_guard_trg BEFORE UPDATE ON customer_profile FOR EACH ROW EXECUTE FUNCTION customer_profile_guard();
-- a profile's company is its role's company
CREATE OR REPLACE FUNCTION profile_company_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rc UUID;
BEGIN
  SELECT company_id INTO rc FROM contact_role WHERE id = NEW.role_id AND organisation_id = NEW.organisation_id;
  IF rc IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'profile company must be the role''s company' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_profile_company_trg BEFORE INSERT ON customer_profile FOR EACH ROW EXECUTE FUNCTION profile_company_guard();
CREATE TRIGGER supplier_profile_company_trg BEFORE INSERT ON supplier_profile FOR EACH ROW EXECUTE FUNCTION profile_company_guard();
CREATE TRIGGER customer_profile_no_delete BEFORE DELETE ON customer_profile FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER supplier_profile_no_delete BEFORE DELETE ON supplier_profile FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contact_role','customer_profile','supplier_profile']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

-- ───────── Permission: seeing and verifying supplier bank details ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['contact:bank-details']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin');
UPDATE "role" SET permissions = permissions || ARRAY['contact:bank-details']::text[] WHERE organisation_id IS NULL AND key IN ('partner','accountant');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'contact_role', 'WHILE_ACTIVE'), ('TABLE', 'customer_profile', 'WHILE_ACTIVE'), ('TABLE', 'supplier_profile', 'WHILE_ACTIVE');
