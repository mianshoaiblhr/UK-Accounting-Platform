-- V7 / milestone V7-M1: the compliance calendar (DEC-088). Additive. NO deadline rule is inserted here: a firm enters (or imports) each rule with
-- its official source, and a different person verifies it before it is used (the DEC-021 pattern). Obligations record what a client must file or
-- pay, with a status, an owner and filing evidence; the platform files nothing (DEC-082, DEC-086).

-- ───────── Deadline rules: sourced, effective-dated, verified versions (organisation data) ─────────
CREATE TABLE "deadline_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "legal_forms" TEXT[] NOT NULL,
    "days_before_months" SMALLINT NOT NULL DEFAULT 0,
    "months" SMALLINT NOT NULL,
    "days_after_months" SMALLINT NOT NULL DEFAULT 0,
    "month_end_rule" BOOLEAN NOT NULL DEFAULT false,
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
    CONSTRAINT "deadline_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT deadline_rule_kind_ck CHECK (kind IN ('ACCOUNTS_FILING','CT_PAYMENT','CT_RETURN','CONFIRMATION_STATEMENT','VAT_RETURN')),
    CONSTRAINT deadline_rule_forms_ck CHECK (cardinality(legal_forms) >= 1 AND legal_forms <@ ARRAY['LTD','LLP','SOLE_TRADER','PARTNERSHIP','CHARITY','OTHER']::text[]),
    CONSTRAINT deadline_rule_offset_ck CHECK (days_before_months BETWEEN 0 AND 31 AND months BETWEEN 0 AND 24 AND days_after_months BETWEEN 0 AND 60
      AND days_before_months + months + days_after_months > 0),
    CONSTRAINT deadline_rule_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT deadline_rule_source_ck CHECK (char_length(source_url) BETWEEN 8 AND 500 AND source_url ~ '^https?://' AND char_length(btrim(source_provision)) BETWEEN 3 AND 300),
    CONSTRAINT deadline_rule_verification_ck CHECK (verification_status IN ('UNVERIFIED','VERIFIED') AND (
      (verification_status = 'UNVERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL)
      OR (verification_status = 'VERIFIED' AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> entered_by_user_id)))
);
CREATE UNIQUE INDEX "deadline_rule_organisation_id_id_key" ON "deadline_rule"("organisation_id", "id");
CREATE INDEX "deadline_rule_kind_idx" ON "deadline_rule"("organisation_id", "kind", "effective_from");
ALTER TABLE "deadline_rule" ADD CONSTRAINT "deadline_rule_organisation_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deadline_rule" ADD CONSTRAINT "deadline_rule_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deadline_rule" ADD CONSTRAINT "deadline_rule_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deadline_rule" ADD CONSTRAINT "deadline_rule_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deadline_rule" ADD CONSTRAINT "deadline_rule_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "deadline_rule"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Insert: starts UNVERIFIED, and no current version of the same kind that shares a legal form overlaps its dates.
-- Update: only verification (once) and supersession (once) ever change a version.
CREATE OR REPLACE FUNCTION deadline_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new deadline rule version starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM deadline_rule r WHERE r.organisation_id = NEW.organisation_id AND r.kind = NEW.kind AND r.superseded_by_id IS NULL AND r.id <> NEW.id
               AND r.legal_forms && NEW.legal_forms AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')) THEN
      RAISE EXCEPTION 'the deadline rule overlaps another current version of the same kind for a shared legal form; supersede it first' USING ERRCODE = '23P01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.kind <> OLD.kind OR NEW.legal_forms <> OLD.legal_forms
     OR NEW.days_before_months <> OLD.days_before_months OR NEW.months <> OLD.months OR NEW.days_after_months <> OLD.days_after_months OR NEW.month_end_rule <> OLD.month_end_rule
     OR NEW.effective_from <> OLD.effective_from OR NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.source_url <> OLD.source_url
     OR NEW.source_provision <> OLD.source_provision OR NEW.source_retrieved_on <> OLD.source_retrieved_on OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a deadline rule version is immutable; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status AND (OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status <> 'VERIFIED') THEN
    RAISE EXCEPTION 'a deadline rule version is verified once and verification is not withdrawn' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status = OLD.verification_status AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id) THEN
    RAISE EXCEPTION 'verification details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'a deadline rule version is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deadline_rule_guard_trg BEFORE INSERT OR UPDATE ON deadline_rule FOR EACH ROW EXECUTE FUNCTION deadline_rule_guard();
CREATE TRIGGER deadline_rule_no_delete BEFORE DELETE ON deadline_rule FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER deadline_rule_no_truncate BEFORE TRUNCATE ON deadline_rule FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── A client's compliance profile: the confirmation date the next confirmation statement is made up to ─────────
CREATE TABLE "company_compliance_profile" (
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "confirmation_date" DATE,
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_compliance_profile_pkey" PRIMARY KEY ("organisation_id", "company_id")
);
ALTER TABLE "company_compliance_profile" ADD CONSTRAINT "ccp_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_compliance_profile" ADD CONSTRAINT "ccp_updated_by_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Obligations: what a client must file or pay, and where it stands ─────────
CREATE TABLE "compliance_obligation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "period_start" DATE,
    "period_end" DATE,
    "due_date" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "deadline_rule_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "assignee_user_id" UUID,
    "done_on" DATE,
    "done_reference" TEXT,
    "evidence_document_id" UUID,
    "status_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "compliance_obligation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT co_kind_ck CHECK (kind IN ('ACCOUNTS_FILING','CT_PAYMENT','CT_RETURN','CONFIRMATION_STATEMENT','VAT_RETURN','OTHER')),
    CONSTRAINT co_status_ck CHECK (status IN ('NOT_STARTED','IN_PROGRESS','WAITING_ON_CLIENT','READY','DONE','NOT_REQUIRED')),
    CONSTRAINT co_source_ck CHECK ((source = 'RULE' AND deadline_rule_id IS NOT NULL AND period_end IS NOT NULL AND kind <> 'OTHER')
                                   OR (source = 'MANUAL' AND deadline_rule_id IS NULL)),
    CONSTRAINT co_title_ck CHECK ((title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 200) AND (kind <> 'OTHER' OR title IS NOT NULL)),
    CONSTRAINT co_period_ck CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end),
    CONSTRAINT co_done_ck CHECK ((status = 'DONE') = (done_on IS NOT NULL) AND (status = 'DONE' OR done_reference IS NULL)),
    CONSTRAINT co_done_reference_ck CHECK (done_reference IS NULL OR char_length(btrim(done_reference)) BETWEEN 1 AND 200),
    CONSTRAINT co_not_required_ck CHECK (status <> 'NOT_REQUIRED' OR char_length(btrim(coalesce(status_reason, ''))) >= 10),
    CONSTRAINT co_version_ck CHECK (version >= 1)
);
CREATE UNIQUE INDEX "compliance_obligation_organisation_id_id_key" ON "compliance_obligation"("organisation_id", "id");
-- one generated obligation per client, kind and anchor date: generation is idempotent
CREATE UNIQUE INDEX "co_rule_anchor_key" ON "compliance_obligation"("organisation_id", "company_id", "kind", "period_end") WHERE source = 'RULE';
CREATE INDEX "co_company_due_idx" ON "compliance_obligation"("organisation_id", "company_id", "due_date");
CREATE INDEX "co_due_idx" ON "compliance_obligation"("organisation_id", "due_date") WHERE status NOT IN ('DONE','NOT_REQUIRED');
ALTER TABLE "compliance_obligation" ADD CONSTRAINT "co_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "compliance_obligation" ADD CONSTRAINT "co_rule_fkey" FOREIGN KEY ("organisation_id", "deadline_rule_id") REFERENCES "deadline_rule"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_obligation" ADD CONSTRAINT "co_assignee_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_obligation" ADD CONSTRAINT "co_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "compliance_obligation" ADD CONSTRAINT "co_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What an obligation is never changes; every change bumps the version by exactly one (optimistic concurrency, proven here as well as in the service).
CREATE OR REPLACE FUNCTION compliance_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.kind <> OLD.kind OR NEW.source <> OLD.source
     OR NEW.deadline_rule_id IS DISTINCT FROM OLD.deadline_rule_id OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what an obligation is cannot change; record a new obligation instead' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'an obligation update must advance its version by one' USING ERRCODE = '40001'; END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_obligation_guard_trg BEFORE UPDATE ON compliance_obligation FOR EACH ROW EXECUTE FUNCTION compliance_obligation_guard();
CREATE TRIGGER compliance_obligation_no_delete BEFORE DELETE ON compliance_obligation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER compliance_obligation_no_truncate BEFORE TRUNCATE ON compliance_obligation FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deadline_rule','company_compliance_profile','compliance_obligation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

-- ───────── Permissions (DEC-088) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['compliance:read','compliance:manage','compliance:rules-manage','compliance:rule-verify']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin');
UPDATE "role" SET permissions = permissions || ARRAY['compliance:read','compliance:manage']::text[] WHERE organisation_id IS NULL AND key IN ('partner','manager','accountant');
UPDATE "role" SET permissions = permissions || ARRAY['compliance:read']::text[] WHERE organisation_id IS NULL AND key IN ('bookkeeper','reviewer');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
  ('TABLE', 'deadline_rule', 'ACCOUNTING_RECORDS'), ('TABLE', 'company_compliance_profile', 'WHILE_ACTIVE'), ('TABLE', 'compliance_obligation', 'FILING_EVIDENCE');
