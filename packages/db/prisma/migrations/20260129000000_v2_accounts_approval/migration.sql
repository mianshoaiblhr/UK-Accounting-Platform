-- V2 / milestone V2-M6c: partner review, client approval, locking and the filing-ready package (DEC-070). Additive. The fingerprint of the
-- accounts document ties the records together; client approval locks the year's periods (through the period service) and its framework; a
-- locked year takes no new facts, flag responses, workflow sign-offs or approvals; the package is written once, only for an approved year
-- whose standard version was verified by a second person (V2-ARC-04).

CREATE TABLE "accounts_approval" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "note" TEXT,
    "director_contact_id" UUID,
    "approved_on" DATE,
    "evidence_document_id" UUID,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "accounts_approval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT aap_stage_ck CHECK (stage IN ('PARTNER_REVIEW','CLIENT_APPROVAL')),
    CONSTRAINT aap_fingerprint_ck CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT aap_note_ck CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 3 AND 2000),
    -- a client approval names the approving director, the date and its evidence; a partner review names none of them
    CONSTRAINT aap_client_ck CHECK (CASE stage WHEN 'CLIENT_APPROVAL' THEN director_contact_id IS NOT NULL AND approved_on IS NOT NULL AND evidence_document_id IS NOT NULL
                                               ELSE director_contact_id IS NULL AND approved_on IS NULL AND evidence_document_id IS NULL END)
);
CREATE INDEX "aap_framework_idx" ON "accounts_approval"("organisation_id", "framework_id", "stage", "at");
CREATE UNIQUE INDEX "aap_one_client_approval" ON "accounts_approval"("organisation_id", "framework_id") WHERE stage = 'CLIENT_APPROVAL';
ALTER TABLE "accounts_approval" ADD CONSTRAINT "aap_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounts_approval" ADD CONSTRAINT "aap_framework_fkey" FOREIGN KEY ("framework_id") REFERENCES "company_reporting_framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounts_approval" ADD CONSTRAINT "aap_director_fkey" FOREIGN KEY ("organisation_id", "director_contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounts_approval" ADD CONSTRAINT "aap_evidence_fkey" FOREIGN KEY ("organisation_id", "evidence_document_id") REFERENCES "document"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounts_approval" ADD CONSTRAINT "aap_by_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The second-person rule of the partner review and the conditions of the client approval (DEC-070)
CREATE OR REPLACE FUNCTION aap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fw company_reporting_framework%ROWTYPE; s11 year_end_step_signoff%ROWTYPE; review_fp TEXT;
BEGIN
  SELECT * INTO fw FROM company_reporting_framework f WHERE f.id = NEW.framework_id AND f.organisation_id = NEW.organisation_id AND f.company_id = NEW.company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'an accounts approval belongs to a framework year of its company' USING ERRCODE = '23514'; END IF;
  IF NEW.stage = 'PARTNER_REVIEW' THEN
    SELECT * INTO s11 FROM year_end_step_signoff s WHERE s.organisation_id = NEW.organisation_id AND s.framework_id = NEW.framework_id AND s.step = 11 ORDER BY s.at DESC, s.id DESC LIMIT 1;
    IF NOT FOUND OR s11.action <> 'SIGN_OFF' THEN RAISE EXCEPTION 'a partner review needs the accounts signed off (step 11)' USING ERRCODE = '23514'; END IF;
    IF s11.by_user_id = NEW.by_user_id THEN RAISE EXCEPTION 'a partner review is recorded by someone other than the person who signed off the accounts' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.stage = 'CLIENT_APPROVAL' THEN
    SELECT a.fingerprint INTO review_fp FROM accounts_approval a WHERE a.organisation_id = NEW.organisation_id AND a.framework_id = NEW.framework_id AND a.stage = 'PARTNER_REVIEW' ORDER BY a.at DESC, a.id DESC LIMIT 1;
    IF review_fp IS DISTINCT FROM NEW.fingerprint THEN RAISE EXCEPTION 'a client approval needs a partner review of the same accounts' USING ERRCODE = '23514'; END IF;
    IF NEW.approved_on <= fw.year_end THEN RAISE EXCEPTION 'accounts are approved after the year end' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM company_officer o WHERE o.organisation_id = NEW.organisation_id AND o.company_id = NEW.company_id AND o.contact_id = NEW.director_contact_id
                   AND o.role::text = 'DIRECTOR' AND o.appointed_on <= NEW.approved_on AND (o.resigned_on IS NULL OR o.resigned_on >= NEW.approved_on)) THEN
      RAISE EXCEPTION 'the approving director serves the company on the approval date' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM document d WHERE d.organisation_id = NEW.organisation_id AND d.id = NEW.evidence_document_id AND d.company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'the approval evidence is a document of the company' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aap_guard_trg BEFORE INSERT ON accounts_approval FOR EACH ROW EXECUTE FUNCTION aap_guard();

CREATE TABLE "accounts_package" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "accounts_package_pkey" PRIMARY KEY ("id"),
    CONSTRAINT apk_fingerprint_ck CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT apk_sha256_ck CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT apk_content_ck CHECK (jsonb_typeof(content) = 'object')
);
CREATE UNIQUE INDEX "apk_framework_key" ON "accounts_package"("organisation_id", "framework_id");
ALTER TABLE "accounts_package" ADD CONSTRAINT "apk_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounts_package" ADD CONSTRAINT "apk_framework_fkey" FOREIGN KEY ("framework_id") REFERENCES "company_reporting_framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounts_package" ADD CONSTRAINT "apk_by_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only for an approved (locked) year, of the approved accounts, under a standard version verified by a second person (V2-ARC-04)
CREATE OR REPLACE FUNCTION apk_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fw company_reporting_framework%ROWTYPE;
BEGIN
  SELECT * INTO fw FROM company_reporting_framework f WHERE f.id = NEW.framework_id AND f.organisation_id = NEW.organisation_id AND f.company_id = NEW.company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'a filing package belongs to a framework year of its company' USING ERRCODE = '23514'; END IF;
  IF fw.locked_at IS NULL THEN RAISE EXCEPTION 'a filing package is generated only for an approved year' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts_approval a WHERE a.organisation_id = NEW.organisation_id AND a.framework_id = NEW.framework_id AND a.stage = 'CLIENT_APPROVAL' AND a.fingerprint = NEW.fingerprint) THEN
    RAISE EXCEPTION 'a filing package holds the accounts as approved' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM reporting_standard_version v WHERE v.id = fw.version_id AND v.organisation_id = fw.organisation_id AND v.verified_at IS NOT NULL AND v.verified_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a filing package needs a standard version verified by a second person' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER apk_guard_trg BEFORE INSERT ON accounts_package FOR EACH ROW EXECUTE FUNCTION apk_guard();

-- ───────── Locking (DEC-070) ─────────
-- The framework is locked only when a client approval of it exists, and nothing else changes as it is locked; once locked it never changes (V2-M1).
CREATE OR REPLACE FUNCTION crf_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.locked_at IS NOT NULL THEN RAISE EXCEPTION 'the reporting framework of an approved year is locked' USING ERRCODE = '42501'; END IF;
    IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.year_start <> OLD.year_start THEN
      RAISE EXCEPTION 'a financial year belongs to one company and starts on one date' USING ERRCODE = '42501';
    END IF;
    IF NEW.locked_at IS NOT NULL THEN
      IF NEW.year_end <> OLD.year_end OR NEW.version_id <> OLD.version_id OR NEW.entity_size <> OLD.entity_size THEN
        RAISE EXCEPTION 'a reporting framework is locked as it stands' USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM accounts_approval a WHERE a.organisation_id = NEW.organisation_id AND a.framework_id = NEW.id AND a.stage = 'CLIENT_APPROVAL') THEN
        RAISE EXCEPTION 'a reporting framework is locked only by the client approval of its accounts' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF NEW.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a reporting framework is locked only by the client approval of its accounts' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM company_reporting_framework f WHERE f.company_id = NEW.company_id AND f.organisation_id = NEW.organisation_id AND f.id <> NEW.id
             AND daterange(f.year_start, f.year_end, '[]') && daterange(NEW.year_start, NEW.year_end, '[]')) THEN
    RAISE EXCEPTION 'financial years of a company do not overlap' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;

-- A period of an approved year stays locked
CREATE OR REPLACE FUNCTION accounting_period_year_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status::text = 'LOCKED' AND NEW.status::text <> 'LOCKED' AND EXISTS (SELECT 1 FROM company_reporting_framework f WHERE f.organisation_id = OLD.organisation_id
       AND f.company_id = OLD.company_id AND f.locked_at IS NOT NULL AND f.year_start <= OLD.end_date AND f.year_end >= OLD.start_date) THEN
    RAISE EXCEPTION 'the accounts of this year are approved; its periods stay locked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounting_period_year_lock_trg BEFORE UPDATE OF status ON accounting_period FOR EACH ROW EXECUTE FUNCTION accounting_period_year_lock();

-- An approved year takes no new facts, flag responses, workflow sign-offs or approvals
CREATE OR REPLACE FUNCTION forbid_in_approved_year() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM company_reporting_framework f WHERE f.id = NEW.framework_id AND f.locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the accounts of this year are approved; the year is locked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER af_year_lock_trg BEFORE INSERT ON accounts_fact FOR EACH ROW EXECUTE FUNCTION forbid_in_approved_year();
CREATE TRIGGER rfr_year_lock_trg BEFORE INSERT ON review_flag_response FOR EACH ROW EXECUTE FUNCTION forbid_in_approved_year();
CREATE TRIGGER yess_year_lock_trg BEFORE INSERT ON year_end_step_signoff FOR EACH ROW EXECUTE FUNCTION forbid_in_approved_year();
CREATE TRIGGER aap_year_lock_trg BEFORE INSERT ON accounts_approval FOR EACH ROW EXECUTE FUNCTION forbid_in_approved_year();

-- ───────── Row-level security (forced) and least privilege ─────────
ALTER TABLE "accounts_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts_approval" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "accounts_approval" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE UPDATE, DELETE, TRUNCATE ON "accounts_approval" FROM uk_app;
ALTER TABLE "accounts_package" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts_package" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "accounts_package" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE UPDATE, DELETE, TRUNCATE ON "accounts_package" FROM uk_app;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'accounts_approval', 'ACCOUNTING_RECORDS'), ('TABLE', 'accounts_package', 'ACCOUNTING_RECORDS');
