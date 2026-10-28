-- V4 / milestone V4-M2: tax adjustments (DEC-099). Additive. Account adjustment rules are company data verified by a second person; manual
-- adjustments carry evidence and are withdrawn, never changed or removed. The adjusted profit itself is read from the ledger, not stored.

CREATE TABLE "ct_adjustment_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "provision" TEXT,
    "reason" TEXT NOT NULL,
    "entered_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "verification_notes" TEXT,
    "superseded_by_id" UUID,
    CONSTRAINT "ct_adjustment_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ctar_category_ck CHECK (category IN ('DISALLOWABLE','DEPRECIATION','ENTERTAINING','PROVISION','LEGAL_PROFESSIONAL','NON_TAXABLE_INCOME','OTHER')),
    CONSTRAINT ctar_percentage_ck CHECK (percentage > 0 AND percentage <= 100),
    CONSTRAINT ctar_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT ctar_text_ck CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000 AND (provision IS NULL OR char_length(btrim(provision)) BETWEEN 3 AND 300)),
    CONSTRAINT ctar_verification_ck CHECK (verification_status IN ('UNVERIFIED','VERIFIED') AND (
      (verification_status = 'UNVERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL)
      OR (verification_status = 'VERIFIED' AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> entered_by_user_id)))
);
CREATE UNIQUE INDEX "ct_adjustment_rule_organisation_id_id_key" ON "ct_adjustment_rule"("organisation_id", "id");
CREATE INDEX "ct_adjustment_rule_account_idx" ON "ct_adjustment_rule"("organisation_id", "company_id", "account_id", "effective_from");
ALTER TABLE "ct_adjustment_rule" ADD CONSTRAINT "ctar_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_adjustment_rule" ADD CONSTRAINT "ctar_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_adjustment_rule" ADD CONSTRAINT "ctar_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_adjustment_rule" ADD CONSTRAINT "ctar_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "ct_adjustment_rule"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION ct_adjustment_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new adjustment rule starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM account a WHERE a.id = NEW.account_id AND a.organisation_id = NEW.organisation_id AND a.type::text IN ('INCOME','EXPENSE')) THEN
      RAISE EXCEPTION 'an adjustment rule names an income or expense account' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM ct_adjustment_rule r WHERE r.organisation_id = NEW.organisation_id AND r.account_id = NEW.account_id AND r.superseded_by_id IS NULL AND r.id <> NEW.id
               AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')) THEN
      RAISE EXCEPTION 'the adjustment rule overlaps another current rule of the same account; supersede it first' USING ERRCODE = '23P01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.account_id <> OLD.account_id OR NEW.category <> OLD.category
     OR NEW.percentage <> OLD.percentage OR NEW.effective_from <> OLD.effective_from OR NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.provision IS DISTINCT FROM OLD.provision
     OR NEW.reason <> OLD.reason OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an adjustment rule is immutable; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status AND (OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status <> 'VERIFIED') THEN
    RAISE EXCEPTION 'an adjustment rule is verified once and verification is not withdrawn' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status = OLD.verification_status AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes) THEN
    RAISE EXCEPTION 'verification details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'an adjustment rule is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ct_adjustment_rule_guard_trg BEFORE INSERT OR UPDATE ON ct_adjustment_rule FOR EACH ROW EXECUTE FUNCTION ct_adjustment_rule_guard();
CREATE TRIGGER ct_adjustment_rule_no_delete BEFORE DELETE ON ct_adjustment_rule FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_adjustment_rule_no_truncate BEFORE TRUNCATE ON ct_adjustment_rule FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Manual adjustments of a CT period ─────────
CREATE TABLE "ct_adjustment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT NOT NULL,
    "evidence_document_id" UUID NOT NULL,
    "entered_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_by_user_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawal_reason" TEXT,
    CONSTRAINT "ct_adjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT cta_category_ck CHECK (category IN ('DISALLOWABLE','DEPRECIATION','ENTERTAINING','PROVISION','LEGAL_PROFESSIONAL','NON_TAXABLE_INCOME','OTHER') AND direction IN ('ADD','DEDUCT')),
    CONSTRAINT cta_amount_ck CHECK (amount > 0 AND char_length(btrim(description)) BETWEEN 5 AND 500),
    CONSTRAINT cta_withdrawal_ck CHECK ((withdrawn_at IS NULL AND withdrawn_by_user_id IS NULL AND withdrawal_reason IS NULL)
      OR (withdrawn_at IS NOT NULL AND withdrawn_by_user_id IS NOT NULL AND char_length(btrim(withdrawal_reason)) BETWEEN 10 AND 1000))
);
CREATE UNIQUE INDEX "ct_adjustment_organisation_id_id_key" ON "ct_adjustment"("organisation_id", "id");
CREATE INDEX "ct_adjustment_period_idx" ON "ct_adjustment"("organisation_id", "period_id", "created_at");
ALTER TABLE "ct_adjustment" ADD CONSTRAINT "cta_period_fkey" FOREIGN KEY ("organisation_id", "period_id") REFERENCES "ct_period"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_adjustment" ADD CONSTRAINT "cta_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ct_adjustment" ADD CONSTRAINT "cta_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_adjustment" ADD CONSTRAINT "cta_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_adjustment" ADD CONSTRAINT "cta_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION ct_adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'a new adjustment is not withdrawn' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM ct_period p WHERE p.id = NEW.period_id AND p.company_id = NEW.company_id) THEN RAISE EXCEPTION 'the adjustment belongs to a period of its company' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM document d WHERE d.id = NEW.evidence_document_id AND d.company_id = NEW.company_id) THEN RAISE EXCEPTION 'the evidence is a document of the company' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.period_id <> OLD.period_id OR NEW.category <> OLD.category
     OR NEW.direction <> OLD.direction OR NEW.amount <> OLD.amount OR NEW.description <> OLD.description OR NEW.evidence_document_id <> OLD.evidence_document_id
     OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an adjustment is never changed; withdraw it and enter another' USING ERRCODE = '42501';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'an adjustment is withdrawn once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ct_adjustment_guard_trg BEFORE INSERT OR UPDATE ON ct_adjustment FOR EACH ROW EXECUTE FUNCTION ct_adjustment_guard();
CREATE TRIGGER ct_adjustment_no_delete BEFORE DELETE ON ct_adjustment FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_adjustment_no_truncate BEFORE TRUNCATE ON ct_adjustment FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ct_adjustment_rule','ct_adjustment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'ct_adjustment_rule', 'ACCOUNTING_RECORDS'), ('TABLE', 'ct_adjustment', 'ACCOUNTING_RECORDS');
