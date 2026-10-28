-- V4 / milestone V4-M1: Corporation Tax rules, tax periods and the tax profile (DEC-097). Additive. NO rule is inserted here: a firm enters
-- (or imports) each rule with its source and a different person verifies it before use (the DEC-021 pattern).

CREATE TABLE "ct_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT 'UK',
    "kind" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "parameters" JSONB NOT NULL,
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
    CONSTRAINT "ct_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ctr_kind_ck CHECK (jurisdiction = 'UK' AND kind ~ '^[A-Z][A-Z0-9_]{1,39}$' AND jsonb_typeof(parameters) = 'object'),
    CONSTRAINT ctr_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT ctr_source_ck CHECK (char_length(source_url) BETWEEN 8 AND 500 AND source_url ~ '^https?://' AND char_length(btrim(source_provision)) BETWEEN 3 AND 300),
    CONSTRAINT ctr_verification_ck CHECK (verification_status IN ('UNVERIFIED','VERIFIED') AND (
      (verification_status = 'UNVERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL)
      OR (verification_status = 'VERIFIED' AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> entered_by_user_id)))
);
CREATE UNIQUE INDEX "ct_rule_organisation_id_id_key" ON "ct_rule"("organisation_id", "id");
CREATE INDEX "ct_rule_kind_idx" ON "ct_rule"("organisation_id", "kind", "effective_from");
ALTER TABLE "ct_rule" ADD CONSTRAINT "ctr_organisation_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ct_rule" ADD CONSTRAINT "ctr_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_rule" ADD CONSTRAINT "ctr_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_rule" ADD CONSTRAINT "ctr_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_rule" ADD CONSTRAINT "ctr_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "ct_rule"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION ct_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new CT rule version starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM ct_rule r WHERE r.organisation_id = NEW.organisation_id AND r.jurisdiction = NEW.jurisdiction AND r.kind = NEW.kind AND r.superseded_by_id IS NULL AND r.id <> NEW.id
               AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')) THEN
      RAISE EXCEPTION 'the CT rule overlaps another current version of the same kind; supersede it first' USING ERRCODE = '23P01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.jurisdiction <> OLD.jurisdiction OR NEW.kind <> OLD.kind OR NEW.effective_from <> OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.parameters <> OLD.parameters OR NEW.source_url <> OLD.source_url OR NEW.source_provision <> OLD.source_provision
     OR NEW.source_retrieved_on <> OLD.source_retrieved_on OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a CT rule version is immutable; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status AND (OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status <> 'VERIFIED') THEN
    RAISE EXCEPTION 'a CT rule version is verified once and verification is not withdrawn' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status = OLD.verification_status AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id) THEN
    RAISE EXCEPTION 'verification details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'a CT rule version is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ct_rule_guard_trg BEFORE INSERT OR UPDATE ON ct_rule FOR EACH ROW EXECUTE FUNCTION ct_rule_guard();
CREATE TRIGGER ct_rule_no_delete BEFORE DELETE ON ct_rule FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_rule_no_truncate BEFORE TRUNCATE ON ct_rule FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── The company's tax profile ─────────
CREATE TABLE "company_tax_profile" (
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "utr" TEXT,
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_tax_profile_pkey" PRIMARY KEY ("organisation_id", "company_id"),
    CONSTRAINT ctp_utr_ck CHECK (utr IS NULL OR utr ~ '^[0-9]{10}$')
);
ALTER TABLE "company_tax_profile" ADD CONSTRAINT "ctp_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_tax_profile" ADD CONSTRAINT "ctp_updated_by_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── CT accounting periods ─────────
CREATE TABLE "ct_period" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "period_rule_id" UUID NOT NULL,
    "associated_companies" INTEGER NOT NULL DEFAULT 0,
    "associated_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ct_period_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ctp_dates_ck CHECK (start_date <= end_date),
    CONSTRAINT ctp_assoc_ck CHECK (associated_companies >= 0 AND (associated_reason IS NULL OR char_length(btrim(associated_reason)) BETWEEN 10 AND 1000) AND version >= 1)
);
CREATE UNIQUE INDEX "ct_period_organisation_id_id_key" ON "ct_period"("organisation_id", "id");
CREATE UNIQUE INDEX "ct_period_start_key" ON "ct_period"("organisation_id", "company_id", "start_date");
ALTER TABLE "ct_period" ADD CONSTRAINT "ctpd_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ct_period" ADD CONSTRAINT "ctpd_framework_fkey" FOREIGN KEY ("framework_id") REFERENCES "company_reporting_framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_period" ADD CONSTRAINT "ctpd_rule_fkey" FOREIGN KEY ("organisation_id", "period_rule_id") REFERENCES "ct_rule"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_period" ADD CONSTRAINT "ctpd_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What a period is never changes; only its associated companies, each change advancing the version by one.
CREATE OR REPLACE FUNCTION ct_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.framework_id <> OLD.framework_id
     OR NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date OR NEW.period_rule_id <> OLD.period_rule_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the dates of a CT accounting period never change' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'a CT period update must advance its version by one' USING ERRCODE = '40001'; END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER ct_period_guard_trg BEFORE UPDATE ON ct_period FOR EACH ROW EXECUTE FUNCTION ct_period_guard();
CREATE TRIGGER ct_period_no_delete BEFORE DELETE ON ct_period FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_period_no_truncate BEFORE TRUNCATE ON ct_period FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ct_rule','company_tax_profile','ct_period']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

-- ───────── Permissions (DEC-097) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['ct:manage','ct:prepare']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner','accountant');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; DEC-084) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
  ('TABLE', 'ct_rule', 'ACCOUNTING_RECORDS'), ('TABLE', 'ct_period', 'ACCOUNTING_RECORDS'), ('TABLE', 'company_tax_profile', 'WHILE_ACTIVE');
