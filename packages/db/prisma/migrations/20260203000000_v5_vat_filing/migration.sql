-- V5 / milestone V5-M2: the VAT filing record (DEC-091). Additive. NO presentation rule is inserted here: a firm enters each rule with its
-- source and a different person verifies it (DEC-021). There is no HMRC connection (DEC-082, DEC-086): a RECORDED filing is one made outside
-- the platform, evidenced by HMRC's receipt; a SIMULATED filing went through the fake adapter only and changes nothing else.

-- ───────── How boxes 6 to 9 are presented: sourced, effective-dated, verified versions (organisation data) ─────────
CREATE TABLE "vat_presentation_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source_url" TEXT NOT NULL,
    "source_provision" TEXT NOT NULL,
    "source_retrieved_on" DATE NOT NULL,
    "entered_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "verification_notes" TEXT,
    "evidence_document_id" UUID,
    "superseded_by_id" UUID,
    CONSTRAINT "vat_presentation_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT vpr_method_ck CHECK (method IN ('TRUNCATE_PENCE','ROUND_TO_POUND')),
    CONSTRAINT vpr_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT vpr_source_ck CHECK (char_length(source_url) BETWEEN 8 AND 500 AND source_url ~ '^https?://' AND char_length(btrim(source_provision)) BETWEEN 3 AND 300),
    CONSTRAINT vpr_verification_ck CHECK (verification_status IN ('UNVERIFIED','VERIFIED') AND (
      (verification_status = 'UNVERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL)
      OR (verification_status = 'VERIFIED' AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> entered_by_user_id)))
);
CREATE UNIQUE INDEX "vat_presentation_rule_organisation_id_id_key" ON "vat_presentation_rule"("organisation_id", "id");
ALTER TABLE "vat_presentation_rule" ADD CONSTRAINT "vpr_organisation_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vat_presentation_rule" ADD CONSTRAINT "vpr_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vat_presentation_rule" ADD CONSTRAINT "vpr_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vat_presentation_rule" ADD CONSTRAINT "vpr_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vat_presentation_rule" ADD CONSTRAINT "vpr_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "vat_presentation_rule"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION vat_presentation_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new presentation rule version starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM vat_presentation_rule r WHERE r.organisation_id = NEW.organisation_id AND r.superseded_by_id IS NULL AND r.id <> NEW.id
               AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')) THEN
      RAISE EXCEPTION 'the presentation rule overlaps another current version; supersede it first' USING ERRCODE = '23P01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.method <> OLD.method OR NEW.effective_from <> OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.source_url <> OLD.source_url OR NEW.source_provision <> OLD.source_provision
     OR NEW.source_retrieved_on <> OLD.source_retrieved_on OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a presentation rule version is immutable; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status AND (OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status <> 'VERIFIED') THEN
    RAISE EXCEPTION 'a presentation rule version is verified once and verification is not withdrawn' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status = OLD.verification_status AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id) THEN
    RAISE EXCEPTION 'verification details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'a presentation rule version is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vat_presentation_rule_guard_trg BEFORE INSERT OR UPDATE ON vat_presentation_rule FOR EACH ROW EXECUTE FUNCTION vat_presentation_rule_guard();
CREATE TRIGGER vat_presentation_rule_no_delete BEFORE DELETE ON vat_presentation_rule FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER vat_presentation_rule_no_truncate BEFORE TRUNCATE ON vat_presentation_rule FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── The VAT liability account on the VAT settings ─────────
ALTER TABLE "company_vat_setting" ADD COLUMN "liability_account_id" UUID;
ALTER TABLE "company_vat_setting" ADD CONSTRAINT "cvs_liability_account_fkey" FOREIGN KEY ("liability_account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Filings: append-only; one RECORDED filing per return ─────────
CREATE TABLE "vat_filing" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "vat_return_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "package" JSONB NOT NULL,
    "package_sha256" TEXT NOT NULL,
    "presentation_rule_id" UUID NOT NULL,
    "submitted_on" DATE NOT NULL,
    "receipt_reference" TEXT NOT NULL,
    "receipt" JSONB,
    "adapter" TEXT,
    "evidence_document_id" UUID,
    "journal_id" UUID,
    "note" TEXT,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "vat_filing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT vf_mode_ck CHECK ((mode = 'RECORDED' AND evidence_document_id IS NOT NULL AND adapter IS NULL AND receipt_reference ~ '^[0-9]{12}$')
                                 OR (mode = 'SIMULATED' AND evidence_document_id IS NULL AND journal_id IS NULL AND adapter IS NOT NULL AND receipt IS NOT NULL)),
    CONSTRAINT vf_sha_ck CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT vf_note_ck CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "vat_filing_recorded_key" ON "vat_filing"("organisation_id", "vat_return_id") WHERE mode = 'RECORDED';
CREATE INDEX "vat_filing_return_idx" ON "vat_filing"("organisation_id", "vat_return_id", "at");
ALTER TABLE "vat_filing" ADD CONSTRAINT "vf_return_fkey" FOREIGN KEY ("organisation_id", "vat_return_id") REFERENCES "vat_return"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vat_filing" ADD CONSTRAINT "vf_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vat_filing" ADD CONSTRAINT "vf_rule_fkey" FOREIGN KEY ("organisation_id", "presentation_rule_id") REFERENCES "vat_presentation_rule"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vat_filing" ADD CONSTRAINT "vf_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vat_filing" ADD CONSTRAINT "vf_journal_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vat_filing" ADD CONSTRAINT "vf_by_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A filing is made only of an approved (locked) return of the same client.
CREATE OR REPLACE FUNCTION vat_filing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vat_return r WHERE r.organisation_id = NEW.organisation_id AND r.id = NEW.vat_return_id AND r.company_id = NEW.company_id AND r.locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'only an approved VAT return of the same client is filed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vat_filing_guard_trg BEFORE INSERT ON vat_filing FOR EACH ROW EXECUTE FUNCTION vat_filing_guard();
CREATE TRIGGER vat_filing_no_update BEFORE UPDATE ON vat_filing FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER vat_filing_no_delete BEFORE DELETE ON vat_filing FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER vat_filing_no_truncate BEFORE TRUNCATE ON vat_filing FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vat_presentation_rule','vat_filing']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "vat_filing" FROM uk_app;

-- ───────── Permissions (DEC-091) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['vat:file']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; DEC-084) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
  ('TABLE', 'vat_presentation_rule', 'ACCOUNTING_RECORDS'), ('TABLE', 'vat_filing', 'FILING_EVIDENCE');
