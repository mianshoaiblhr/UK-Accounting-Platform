-- V0 Tranche A / increment 7a: document management (specification §6) - types, folders, period link, metadata, visibility, filing-evidence lock.
-- Additive. Existing documents become STANDARD, unlocked, in no folder, with their current class carried over as a document type.

-- ───────── Document types (REFERENCE data: global, read-only for the runtime role; changed by migrations) ─────────
CREATE TABLE "document_type" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "document_type_pkey" PRIMARY KEY ("code"),
    CONSTRAINT document_type_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]{1,59}$')
);
INSERT INTO "document_type"(code, name) VALUES
('GENERAL', 'General document'),
('BANK_STATEMENT', 'Bank statement'),
('SALES_INVOICE', 'Sales invoice'),
('PURCHASE_INVOICE', 'Purchase invoice'),
('CREDIT_NOTE', 'Credit note'),
('RECEIPT', 'Receipt'),
('CONTRACT', 'Contract or agreement'),
('LETTER_OF_ENGAGEMENT', 'Letter of engagement'),
('PAYROLL_RECORD', 'Payroll record'),
('VAT_WORKING', 'VAT working'),
('TAX_CORRESPONDENCE', 'Tax correspondence'),
('STATUTORY_ACCOUNTS', 'Statutory accounts'),
('FILING_EVIDENCE', 'Filing evidence'),
('IDENTITY_VERIFICATION', 'Identity verification'),
('MINUTES', 'Minutes or resolution'),
('OTHER', 'Other');
-- FORCE ROW LEVEL SECURITY applies to the migration owner (ADR-27): without lifting it here, the statements below would see NO rows (and
-- the foreign key validation would silently check nothing). Re-forced as soon as the constraints on `document` are in place.
ALTER TABLE "document" NO FORCE ROW LEVEL SECURITY;
-- Legacy free-text classes: well-formed ones are kept as types (so the foreign key cannot fail); anything else becomes OTHER.
INSERT INTO "document_type"(code, name)
  SELECT DISTINCT d.document_class, d.document_class FROM "document" d
   WHERE d.document_class ~ '^[A-Z][A-Z0-9_]{1,59}$' AND NOT EXISTS (SELECT 1 FROM "document_type" t WHERE t.code = d.document_class);
UPDATE "document" SET document_class = 'OTHER' WHERE document_class !~ '^[A-Z][A-Z0-9_]{1,59}$';
GRANT SELECT ON "document_type" TO uk_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "document_type" FROM uk_app;

-- ───────── Folders ─────────
CREATE TABLE "document_folder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "document_folder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT document_folder_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[/\\]'),
    CONSTRAINT document_folder_not_own_parent_ck CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX "document_folder_organisation_id_id_key" ON "document_folder"("organisation_id", "id");
CREATE UNIQUE INDEX "document_folder_sibling_name_uq" ON "document_folder"("organisation_id", coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX "document_folder_organisation_id_company_id_idx" ON "document_folder"("organisation_id", "company_id");
ALTER TABLE "document_folder" ADD CONSTRAINT "document_folder_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_folder" ADD CONSTRAINT "document_folder_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_folder" ADD CONSTRAINT "document_folder_organisation_id_parent_id_fkey" FOREIGN KEY ("organisation_id", "parent_id") REFERENCES "document_folder"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A folder lives in its parent's company, the tree is at most 8 levels deep and has no cycles.
CREATE OR REPLACE FUNCTION document_folder_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p_company uuid; p_found boolean; depth int := 1; cur uuid := NEW.parent_id;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT company_id, true INTO p_company, p_found FROM document_folder WHERE organisation_id = NEW.organisation_id AND id = NEW.parent_id;
    IF NOT coalesce(p_found, false) THEN RAISE EXCEPTION 'parent folder not found' USING ERRCODE = '23503'; END IF;
    IF p_company IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'a folder must belong to the same company as its parent' USING ERRCODE = '23514'; END IF;
    WHILE cur IS NOT NULL LOOP
      IF cur = NEW.id THEN RAISE EXCEPTION 'a folder cannot be moved into itself or its own subfolder' USING ERRCODE = '23514'; END IF;
      depth := depth + 1;
      IF depth > 8 THEN RAISE EXCEPTION 'folders can be nested at most 8 levels deep' USING ERRCODE = '23514'; END IF;
      SELECT parent_id INTO cur FROM document_folder WHERE organisation_id = NEW.organisation_id AND id = cur;
    END LOOP;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'a folder cannot change company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_folder_guard_trg BEFORE INSERT OR UPDATE OF parent_id, company_id ON "document_folder" FOR EACH ROW EXECUTE FUNCTION document_folder_guard();

-- ───────── Document columns ─────────
ALTER TABLE "document"
  ADD COLUMN "folder_id" UUID,
  ADD COLUMN "period_id" UUID,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "document_date" DATE,
  ADD COLUMN "reference" TEXT,
  ADD COLUMN "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "evidence_locked_at" TIMESTAMPTZ(3),
  ADD COLUMN "evidence_locked_by_user_id" UUID,
  ADD COLUMN "evidence_version_id" UUID,
  ADD COLUMN "evidence_sha256" TEXT,
  ADD COLUMN "evidence_reason" TEXT,
  ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "document" ADD CONSTRAINT document_visibility_ck CHECK (visibility IN ('STANDARD','RESTRICTED'));
ALTER TABLE "document" ADD CONSTRAINT document_labels_ck CHECK (cardinality(labels) <= 10);
ALTER TABLE "document" ADD CONSTRAINT document_description_ck CHECK (description IS NULL OR char_length(description) <= 2000);
ALTER TABLE "document" ADD CONSTRAINT document_metadata_ck CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192);
ALTER TABLE "document" ADD CONSTRAINT document_evidence_complete_ck CHECK (
  (evidence_locked_at IS NULL AND evidence_version_id IS NULL AND evidence_sha256 IS NULL AND evidence_locked_by_user_id IS NULL AND evidence_reason IS NULL)
  OR (evidence_locked_at IS NOT NULL AND evidence_version_id IS NOT NULL AND evidence_sha256 IS NOT NULL AND evidence_locked_by_user_id IS NOT NULL AND evidence_reason IS NOT NULL AND retain_until IS NOT NULL));
ALTER TABLE "document" ADD CONSTRAINT "document_document_class_fkey" FOREIGN KEY ("document_class") REFERENCES "document_type"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document" ADD CONSTRAINT "document_organisation_id_folder_id_fkey" FOREIGN KEY ("organisation_id", "folder_id") REFERENCES "document_folder"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_period_organisation_id_id_key" ON "accounting_period"("organisation_id", "id");
ALTER TABLE "document" ADD CONSTRAINT "document_organisation_id_period_id_fkey" FOREIGN KEY ("organisation_id", "period_id") REFERENCES "accounting_period"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "document_organisation_id_folder_id_idx" ON "document"("organisation_id", "folder_id");
CREATE INDEX "document_organisation_id_period_id_idx" ON "document"("organisation_id", "period_id");
CREATE INDEX "document_organisation_id_document_class_idx" ON "document"("organisation_id", "document_class");
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;

-- Folder and period must belong to the document's own company.
CREATE OR REPLACE FUNCTION document_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f_company uuid; f_found boolean; p_company uuid; p_found boolean;
BEGIN
  IF NEW.folder_id IS NOT NULL THEN
    SELECT company_id, true INTO f_company, f_found FROM document_folder WHERE organisation_id = NEW.organisation_id AND id = NEW.folder_id;
    IF NOT coalesce(f_found, false) THEN RAISE EXCEPTION 'folder not found' USING ERRCODE = '23503'; END IF;
    IF f_company IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'a document can only be filed in a folder of its own company' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.period_id IS NOT NULL THEN
    IF NEW.company_id IS NULL THEN RAISE EXCEPTION 'only company documents can be linked to an accounting period' USING ERRCODE = '23514'; END IF;
    SELECT company_id, true INTO p_company, p_found FROM accounting_period WHERE organisation_id = NEW.organisation_id AND id = NEW.period_id;
    IF NOT coalesce(p_found, false) THEN RAISE EXCEPTION 'accounting period not found' USING ERRCODE = '23503'; END IF;
    IF p_company <> NEW.company_id THEN RAISE EXCEPTION 'a document can only be linked to a period of its own company' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_scope_guard_trg BEFORE INSERT OR UPDATE OF folder_id, period_id, company_id ON "document" FOR EACH ROW EXECUTE FUNCTION document_scope_guard();

-- ───────── Filing evidence: a one-way door, enforced here and not only in the API ─────────
CREATE OR REPLACE FUNCTION document_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_sha text;
BEGIN
  IF OLD.evidence_locked_at IS NOT NULL THEN
    -- locked: nothing may change except placing a legal hold (never lifting the lock or the retention)
    IF NEW.evidence_locked_at IS DISTINCT FROM OLD.evidence_locked_at OR NEW.evidence_version_id IS DISTINCT FROM OLD.evidence_version_id
       OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256 OR NEW.evidence_locked_by_user_id IS DISTINCT FROM OLD.evidence_locked_by_user_id
       OR NEW.evidence_reason IS DISTINCT FROM OLD.evidence_reason THEN
      RAISE EXCEPTION 'filing evidence cannot be unlocked or re-locked' USING ERRCODE = '42501';
    END IF;
    IF NEW.retain_until IS DISTINCT FROM OLD.retain_until AND NEW.retain_until < OLD.retain_until THEN
      RAISE EXCEPTION 'the retention period of filing evidence cannot be shortened' USING ERRCODE = '42501';
    END IF;
    IF (to_jsonb(NEW) - 'legal_hold' - 'retain_until' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'legal_hold' - 'retain_until' - 'updated_at')
       OR (OLD.legal_hold AND NOT NEW.legal_hold) THEN
      RAISE EXCEPTION 'filing evidence is immutable' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.evidence_locked_at IS NOT NULL THEN
    SELECT status::text, sha256 INTO v_status, v_sha FROM document_version WHERE organisation_id = NEW.organisation_id AND id = NEW.evidence_version_id AND document_id = NEW.id;
    IF v_status IS DISTINCT FROM 'AVAILABLE' THEN RAISE EXCEPTION 'only an AVAILABLE version of this document can be locked as evidence' USING ERRCODE = '23514'; END IF;
    IF v_sha IS NULL OR v_sha <> NEW.evidence_sha256 THEN RAISE EXCEPTION 'the evidence hash must match the stored version hash' USING ERRCODE = '23514'; END IF;
    IF NEW.status::text <> 'ACTIVE' THEN RAISE EXCEPTION 'an archived document cannot be locked as evidence' USING ERRCODE = '23514'; END IF;
    IF NEW.retain_until < CURRENT_DATE THEN RAISE EXCEPTION 'the retention date of filing evidence cannot be in the past' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_evidence_guard_trg BEFORE UPDATE ON "document" FOR EACH ROW EXECUTE FUNCTION document_evidence_guard();

-- No new versions on locked evidence; the locked version itself never changes again.
CREATE OR REPLACE FUNCTION document_version_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM document d WHERE d.organisation_id = NEW.organisation_id AND d.id = NEW.document_id AND d.evidence_locked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'filing evidence accepts no new versions' USING ERRCODE = '42501';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM document d WHERE d.organisation_id = OLD.organisation_id AND d.evidence_version_id = OLD.id) THEN
    RAISE EXCEPTION 'a locked evidence version cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_version_evidence_guard_trg BEFORE INSERT OR UPDATE ON "document_version" FOR EACH ROW EXECUTE FUNCTION document_version_evidence_guard();

-- Documents are archived, never deleted, by the application.
REVOKE DELETE, TRUNCATE ON "document" FROM uk_app;

-- ───────── Restricted documents: explicit access grants ─────────
CREATE TABLE "document_access" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "granted_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "document_access_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_access_document_id_user_id_key" ON "document_access"("document_id", "user_id");
CREATE INDEX "document_access_organisation_id_user_id_idx" ON "document_access"("organisation_id", "user_id");
ALTER TABLE "document_access" ADD CONSTRAINT "document_access_organisation_id_document_id_fkey" FOREIGN KEY ("organisation_id", "document_id") REFERENCES "document"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── Row-level security (fail closed) ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_folder','document_access']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
  END LOOP;
END $$;
REVOKE UPDATE, TRUNCATE ON "document_access" FROM uk_app;
REVOKE TRUNCATE ON "document_folder" FROM uk_app;

-- ───────── System roles gain the four new COMPANY permissions ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['document:confidential','evidence:lock','evidence:read','evidence:manage']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner');
UPDATE "role" SET permissions = permissions || ARRAY['document:confidential','evidence:read','evidence:manage']::text[] WHERE organisation_id IS NULL AND key = 'manager';
UPDATE "role" SET permissions = permissions || ARRAY['evidence:read','evidence:manage']::text[] WHERE organisation_id IS NULL AND key IN ('accountant','bookkeeper');
UPDATE "role" SET permissions = permissions || ARRAY['evidence:read']::text[] WHERE organisation_id IS NULL AND key = 'reviewer';
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;
