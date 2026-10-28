-- V4 / milestone V4-M3: capital allowances (DEC-100). Additive. Pool opening balances are entered with evidence and verified by a second person;
-- a stored computation is append-only and superseded once; the next CT period opens from the current one.

CREATE TABLE "ca_pool_opening" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "pool" TEXT NOT NULL,
    "asset_id" UUID,
    "as_of" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "evidence_document_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "entered_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "verification_notes" TEXT,
    "superseded_by_id" UUID,
    CONSTRAINT "ca_pool_opening_pkey" PRIMARY KEY ("id"),
    CONSTRAINT cpo_pool_ck CHECK (pool IN ('MAIN','SPECIAL_RATE','SINGLE_ASSET') AND ((pool = 'SINGLE_ASSET') = (asset_id IS NOT NULL)) AND amount >= 0),
    CONSTRAINT cpo_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
    CONSTRAINT cpo_verification_ck CHECK (verification_status IN ('UNVERIFIED','VERIFIED') AND (
      (verification_status = 'UNVERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL)
      OR (verification_status = 'VERIFIED' AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> entered_by_user_id)))
);
CREATE UNIQUE INDEX "ca_pool_opening_organisation_id_id_key" ON "ca_pool_opening"("organisation_id", "id");
CREATE UNIQUE INDEX "ca_pool_opening_current_key" ON "ca_pool_opening"("organisation_id", "company_id", "pool", COALESCE("asset_id", '00000000-0000-0000-0000-000000000000'::uuid), "as_of") WHERE "superseded_by_id" IS NULL;
ALTER TABLE "ca_pool_opening" ADD CONSTRAINT "cpo_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ca_pool_opening" ADD CONSTRAINT "cpo_asset_fkey" FOREIGN KEY ("organisation_id", "asset_id") REFERENCES "fixed_asset"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ca_pool_opening" ADD CONSTRAINT "cpo_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ca_pool_opening" ADD CONSTRAINT "cpo_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ca_pool_opening" ADD CONSTRAINT "cpo_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ca_pool_opening" ADD CONSTRAINT "cpo_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "ca_pool_opening"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION ca_pool_opening_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new opening balance starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM document d WHERE d.id = NEW.evidence_document_id AND d.company_id = NEW.company_id) THEN RAISE EXCEPTION 'the evidence is a document of the company' USING ERRCODE = '23514'; END IF;
    IF NEW.asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fixed_asset a WHERE a.id = NEW.asset_id AND a.company_id = NEW.company_id) THEN RAISE EXCEPTION 'the asset belongs to the company' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.pool <> OLD.pool OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.as_of <> OLD.as_of OR NEW.amount <> OLD.amount OR NEW.evidence_document_id <> OLD.evidence_document_id OR NEW.reason <> OLD.reason
     OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an opening balance is immutable; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status AND (OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status <> 'VERIFIED') THEN
    RAISE EXCEPTION 'an opening balance is verified once and verification is not withdrawn' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status = OLD.verification_status AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes) THEN
    RAISE EXCEPTION 'verification details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'an opening balance is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ca_pool_opening_guard_trg BEFORE INSERT OR UPDATE ON ca_pool_opening FOR EACH ROW EXECUTE FUNCTION ca_pool_opening_guard();
CREATE TRIGGER ca_pool_opening_no_delete BEFORE DELETE ON ca_pool_opening FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ca_pool_opening_no_truncate BEFORE TRUNCATE ON ca_pool_opening FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Stored computations ─────────
CREATE TABLE "ca_computation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "prior_computation_id" UUID,
    "snapshot" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "prepared_by_user_id" UUID NOT NULL,
    "prepared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_by_id" UUID,
    CONSTRAINT "ca_computation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT cac_fingerprint_ck CHECK (fingerprint ~ '^[0-9a-f]{64}$' AND jsonb_typeof(snapshot) = 'object')
);
CREATE UNIQUE INDEX "ca_computation_organisation_id_id_key" ON "ca_computation"("organisation_id", "id");
CREATE UNIQUE INDEX "ca_computation_current_key" ON "ca_computation"("organisation_id", "period_id") WHERE "superseded_by_id" IS NULL;
ALTER TABLE "ca_computation" ADD CONSTRAINT "cac_period_fkey" FOREIGN KEY ("organisation_id", "period_id") REFERENCES "ct_period"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ca_computation" ADD CONSTRAINT "cac_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ca_computation" ADD CONSTRAINT "cac_prior_fkey" FOREIGN KEY ("organisation_id", "prior_computation_id") REFERENCES "ca_computation"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ca_computation" ADD CONSTRAINT "cac_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "ca_computation"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ca_computation" ADD CONSTRAINT "cac_prepared_by_fkey" FOREIGN KEY ("prepared_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION ca_computation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.period_id <> OLD.period_id
     OR NEW.prior_computation_id IS DISTINCT FROM OLD.prior_computation_id OR NEW.snapshot <> OLD.snapshot OR NEW.fingerprint <> OLD.fingerprint
     OR NEW.prepared_by_user_id <> OLD.prepared_by_user_id OR NEW.prepared_at <> OLD.prepared_at THEN
    RAISE EXCEPTION 'a stored capital allowances computation is never changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'a computation is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ca_computation_guard_trg BEFORE UPDATE ON ca_computation FOR EACH ROW EXECUTE FUNCTION ca_computation_guard();
CREATE TRIGGER ca_computation_no_delete BEFORE DELETE ON ca_computation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ca_computation_no_truncate BEFORE TRUNCATE ON ca_computation FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ca_pool_opening','ca_computation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'ca_pool_opening', 'ACCOUNTING_RECORDS'), ('TABLE', 'ca_computation', 'ACCOUNTING_RECORDS');
