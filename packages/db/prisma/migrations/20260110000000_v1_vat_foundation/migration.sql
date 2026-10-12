-- V1 / milestone M4b: VAT foundation, standard VAT accounting (DEC-010, DEC-021, DEC-022, DEC-025; ADR-51). Additive.
-- NO VAT rate or rule figure is inserted here: firms enter codes and rates with their official source; a different person verifies each rate version.

-- ───────── Tax codes: what a line is (treatment and direction); immutable ─────────
CREATE TABLE "tax_code" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "treatment" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tax_code_pkey" PRIMARY KEY ("id"),
    CONSTRAINT tax_code_code_ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$'),
    CONSTRAINT tax_code_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT tax_code_treatment_ck CHECK (treatment IN ('STANDARD','REDUCED','ZERO','EXEMPT','OUTSIDE_SCOPE')),
    CONSTRAINT tax_code_direction_ck CHECK (direction IN ('SALES','PURCHASES','BOTH')),
    CONSTRAINT tax_code_rc_ck CHECK (NOT reverse_charge OR (direction = 'PURCHASES' AND treatment IN ('STANDARD','REDUCED')))
);
CREATE UNIQUE INDEX "tax_code_organisation_id_id_key" ON "tax_code"("organisation_id", "id");
CREATE UNIQUE INDEX "tax_code_organisation_id_code_key" ON "tax_code"("organisation_id", "code");
ALTER TABLE "tax_code" ADD CONSTRAINT "tax_code_organisation_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tax_code" ADD CONSTRAINT "tax_code_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER tax_code_no_mutation BEFORE UPDATE OR DELETE ON tax_code FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER tax_code_no_truncate BEFORE TRUNCATE ON tax_code FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Tax rates: effective-dated, sourced, verified versions ─────────
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "tax_code_id" UUID NOT NULL,
    "rate" NUMERIC(7,4) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "net_boxes" SMALLINT[] NOT NULL DEFAULT ARRAY[]::smallint[],
    "vat_boxes" SMALLINT[] NOT NULL DEFAULT ARRAY[]::smallint[],
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
    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT tax_rate_rate_ck CHECK (rate >= 0 AND rate <= 100),
    CONSTRAINT tax_rate_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT tax_rate_boxes_ck CHECK (net_boxes <@ ARRAY[6,7,8,9]::smallint[] AND vat_boxes <@ ARRAY[1,2,4]::smallint[]),
    CONSTRAINT tax_rate_source_ck CHECK (char_length(source_url) BETWEEN 8 AND 500 AND source_url ~ '^https?://' AND char_length(btrim(source_provision)) BETWEEN 3 AND 300),
    CONSTRAINT tax_rate_verification_ck CHECK (verification_status IN ('UNVERIFIED','VERIFIED') AND (
      (verification_status = 'UNVERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL)
      OR (verification_status = 'VERIFIED' AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> entered_by_user_id)))
);
CREATE UNIQUE INDEX "tax_rate_organisation_id_id_key" ON "tax_rate"("organisation_id", "id");
CREATE INDEX "tax_rate_code_idx" ON "tax_rate"("organisation_id", "tax_code_id", "effective_from");
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_code_fkey" FOREIGN KEY ("organisation_id", "tax_code_id") REFERENCES "tax_code"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "tax_rate"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Insert: the rate fits its code's treatment (zero / exempt / outside scope are 0; standard / reduced are above 0) and no current version of the same
-- code overlaps it. Update: only verification (once) and supersession (once) ever change a version.
CREATE OR REPLACE FUNCTION tax_rate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT treatment INTO c FROM tax_code WHERE id = NEW.tax_code_id AND organisation_id = NEW.organisation_id;
    IF c.treatment IN ('ZERO','EXEMPT','OUTSIDE_SCOPE') AND NEW.rate <> 0 THEN RAISE EXCEPTION 'a % code has a rate of 0', lower(c.treatment) USING ERRCODE = '23514'; END IF;
    IF c.treatment IN ('STANDARD','REDUCED') AND NEW.rate = 0 THEN RAISE EXCEPTION 'a % code has a rate above 0', lower(c.treatment) USING ERRCODE = '23514'; END IF;
    IF NEW.verification_status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new rate version starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM tax_rate r WHERE r.tax_code_id = NEW.tax_code_id AND r.organisation_id = NEW.organisation_id AND r.superseded_by_id IS NULL AND r.id <> NEW.id
               AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')) THEN
      RAISE EXCEPTION 'the rate overlaps another current version of the same code; supersede it first' USING ERRCODE = '23P01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.tax_code_id <> OLD.tax_code_id OR NEW.rate <> OLD.rate OR NEW.effective_from <> OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.net_boxes <> OLD.net_boxes OR NEW.vat_boxes <> OLD.vat_boxes OR NEW.source_url <> OLD.source_url
     OR NEW.source_provision <> OLD.source_provision OR NEW.source_retrieved_on <> OLD.source_retrieved_on OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a tax rate version is immutable; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status AND (OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status <> 'VERIFIED') THEN
    RAISE EXCEPTION 'a rate version is verified once and verification is not withdrawn' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status = OLD.verification_status AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id) THEN
    RAISE EXCEPTION 'verification details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'a rate version is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rate_guard_trg BEFORE INSERT OR UPDATE ON tax_rate FOR EACH ROW EXECUTE FUNCTION tax_rate_guard();
CREATE TRIGGER tax_rate_no_delete BEFORE DELETE ON tax_rate FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER tax_rate_no_truncate BEFORE TRUNCATE ON tax_rate FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Company VAT settings: registration, scheme (only STANDARD exists), periods, control accounts ─────────
CREATE TABLE "company_vat_setting" (
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "vrn" TEXT,
    "registered_from" DATE,
    "scheme" TEXT NOT NULL DEFAULT 'STANDARD',
    "period_months" SMALLINT NOT NULL DEFAULT 3,
    "anchor_period_end" DATE,
    "output_account_id" UUID,
    "input_account_id" UUID,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_vat_setting_pkey" PRIMARY KEY ("organisation_id", "company_id"),
    -- CASH and FLAT_RATE are deferred (DEC-010): enabling one is a migration together with its implementation
    CONSTRAINT company_vat_setting_scheme_ck CHECK (scheme IN ('STANDARD')),
    CONSTRAINT company_vat_setting_period_ck CHECK (period_months IN (1, 3)),
    CONSTRAINT company_vat_setting_vrn_ck CHECK (vrn IS NULL OR vrn ~ '^(GB)?([0-9]{9}|[0-9]{12})$'),
    CONSTRAINT company_vat_setting_registered_ck CHECK (NOT registered OR (vrn IS NOT NULL AND registered_from IS NOT NULL AND anchor_period_end IS NOT NULL AND output_account_id IS NOT NULL AND input_account_id IS NOT NULL))
);
ALTER TABLE "company_vat_setting" ADD CONSTRAINT "company_vat_setting_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_vat_setting" ADD CONSTRAINT "company_vat_setting_output_fkey" FOREIGN KEY ("organisation_id", "company_id", "output_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_vat_setting" ADD CONSTRAINT "company_vat_setting_input_fkey" FOREIGN KEY ("organisation_id", "company_id", "input_account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Journal lines: VAT facts (net line, VAT line, reverse-charge pair) ─────────
ALTER TABLE "journal_line"
  ADD COLUMN "tax_code_id" UUID,
  ADD COLUMN "tax_rate_id" UUID,
  ADD COLUMN "vat_role" TEXT,
  ADD COLUMN "tax_point" DATE,
  ADD COLUMN "vat_net_line_no" INTEGER,
  ADD COLUMN "vat_inclusive" BOOLEAN;
ALTER TABLE "journal_line"
  ADD CONSTRAINT journal_line_vat_all_or_none_ck CHECK (
    (tax_code_id IS NULL AND tax_rate_id IS NULL AND vat_role IS NULL AND tax_point IS NULL AND vat_net_line_no IS NULL AND vat_inclusive IS NULL)
    OR (tax_code_id IS NOT NULL AND tax_rate_id IS NOT NULL AND vat_role IS NOT NULL AND tax_point IS NOT NULL AND vat_inclusive IS NOT NULL)),
  ADD CONSTRAINT journal_line_vat_role_ck CHECK (vat_role IS NULL OR vat_role IN ('NET','VAT','RC_OUTPUT','RC_INPUT')),
  ADD CONSTRAINT journal_line_vat_link_ck CHECK (vat_role IS NULL OR (vat_role = 'NET') = (vat_net_line_no IS NULL)),
  -- VAT on foreign-currency lines waits for the verified rule on the VAT amount's currency (M4b limitation)
  ADD CONSTRAINT journal_line_vat_fx_ck CHECK (tax_code_id IS NULL OR original_currency IS NULL);
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_tax_code_fkey" FOREIGN KEY ("organisation_id", "tax_code_id") REFERENCES "tax_code"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_tax_rate_fkey" FOREIGN KEY ("organisation_id", "tax_rate_id") REFERENCES "tax_rate"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "journal_line_vat_idx" ON "journal_line"("organisation_id", "company_id", "tax_point") WHERE tax_rate_id IS NOT NULL;

-- At commit (with the other journal integrity checks): every VAT fact uses a VERIFIED, current version of its own code that covers the tax point;
-- every VAT line is exactly the VAT on its net line (exclusive: round(net x r/100); inclusive: round(gross x r/(100+r))); a reverse-charge pair is equal.
CREATE OR REPLACE FUNCTION journal_vat_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l RECORD; n RECORD; r RECORD; minor INTEGER; amt NUMERIC; base NUMERIC; expected NUMERIC;
BEGIN
  SELECT minor_units INTO minor FROM currency WHERE code = NEW.currency;
  FOR l IN SELECT * FROM journal_line WHERE journal_id = NEW.id AND organisation_id = NEW.organisation_id AND tax_rate_id IS NOT NULL ORDER BY line_no LOOP
    SELECT tax_code_id, rate, effective_from, effective_to, verification_status, superseded_by_id INTO r FROM tax_rate WHERE id = l.tax_rate_id AND organisation_id = l.organisation_id;
    IF r.tax_code_id <> l.tax_code_id THEN RAISE EXCEPTION 'line % uses a rate of another tax code', l.line_no USING ERRCODE = '23514'; END IF;
    IF r.verification_status <> 'VERIFIED' THEN RAISE EXCEPTION 'line % uses an UNVERIFIED tax rate', l.line_no USING ERRCODE = '23514'; END IF;
    -- a reversal mirrors history and may use a version superseded since; new postings may not
    IF r.superseded_by_id IS NOT NULL AND NEW.reverses_journal_id IS NULL THEN RAISE EXCEPTION 'line % uses a superseded tax rate version', l.line_no USING ERRCODE = '23514'; END IF;
    IF l.tax_point < r.effective_from OR (r.effective_to IS NOT NULL AND l.tax_point > r.effective_to) THEN RAISE EXCEPTION 'line % has a tax point outside the rate''s effective dates', l.line_no USING ERRCODE = '23514'; END IF;
    IF l.vat_role <> 'NET' THEN
      SELECT debit, credit, tax_rate_id, vat_role, tax_point INTO n FROM journal_line WHERE journal_id = NEW.id AND organisation_id = NEW.organisation_id AND line_no = l.vat_net_line_no;
      IF NOT FOUND OR n.vat_role <> 'NET' OR n.tax_rate_id <> l.tax_rate_id OR n.tax_point <> l.tax_point THEN RAISE EXCEPTION 'VAT line % does not point at its net line', l.line_no USING ERRCODE = '23514'; END IF;
      amt := l.debit + l.credit; base := n.debit + n.credit;
      expected := CASE WHEN l.vat_inclusive THEN round((base + amt) * r.rate / (100 + r.rate), minor) ELSE round(base * r.rate / 100, minor) END;
      IF l.vat_role IN ('RC_OUTPUT','RC_INPUT') THEN expected := round(base * r.rate / 100, minor); END IF;
      IF amt <> expected THEN RAISE EXCEPTION 'VAT line % is % but the VAT on its net line is %', l.line_no, amt, expected USING ERRCODE = '23514'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_vat_trg AFTER INSERT ON journal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_vat_check();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_code','tax_rate','company_vat_setting']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "tax_code" FROM uk_app;

-- ───────── Permissions: maintaining VAT codes/rates/settings, and verifying rules (the firm grants the latter to its named reviewer) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['vat:manage','tax:rule-verify']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin');
UPDATE "role" SET permissions = permissions || ARRAY['vat:manage']::text[] WHERE organisation_id IS NULL AND key IN ('partner','accountant');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'tax_code', 'ACCOUNTING_RECORDS'), ('TABLE', 'tax_rate', 'ACCOUNTING_RECORDS'), ('TABLE', 'company_vat_setting', 'ACCOUNTING_RECORDS');
