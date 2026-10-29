-- V4 / milestone V4-M4: losses, the computation and the canonical CT600 (DEC-101). Additive. Loss opening balances are entered with evidence and
-- verified by a second person; a computation is prepared by one person and approved by another, never changed, superseded once.

CREATE TABLE "ct_loss_opening" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
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
    CONSTRAINT "ct_loss_opening_pkey" PRIMARY KEY ("id"),
    CONSTRAINT clo_amount_ck CHECK (amount >= 0 AND char_length(btrim(reason)) BETWEEN 10 AND 1000),
    CONSTRAINT clo_verification_ck CHECK (verification_status IN ('UNVERIFIED','VERIFIED') AND (
      (verification_status = 'UNVERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL)
      OR (verification_status = 'VERIFIED' AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> entered_by_user_id)))
);
CREATE UNIQUE INDEX "ct_loss_opening_organisation_id_id_key" ON "ct_loss_opening"("organisation_id", "id");
CREATE UNIQUE INDEX "ct_loss_opening_current_key" ON "ct_loss_opening"("organisation_id", "company_id", "as_of") WHERE "superseded_by_id" IS NULL;
ALTER TABLE "ct_loss_opening" ADD CONSTRAINT "clo_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ct_loss_opening" ADD CONSTRAINT "clo_evidence_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_loss_opening" ADD CONSTRAINT "clo_entered_by_fkey" FOREIGN KEY ("entered_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_loss_opening" ADD CONSTRAINT "clo_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_loss_opening" ADD CONSTRAINT "clo_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "ct_loss_opening"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION ct_loss_opening_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new loss opening balance starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM document d WHERE d.id = NEW.evidence_document_id AND d.company_id = NEW.company_id) THEN RAISE EXCEPTION 'the evidence is a document of the company' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.as_of <> OLD.as_of OR NEW.amount <> OLD.amount
     OR NEW.evidence_document_id <> OLD.evidence_document_id OR NEW.reason <> OLD.reason OR NEW.entered_by_user_id <> OLD.entered_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a loss opening balance is immutable; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status AND (OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status <> 'VERIFIED') THEN
    RAISE EXCEPTION 'a loss opening balance is verified once and verification is not withdrawn' USING ERRCODE = '42501';
  END IF;
  IF NEW.verification_status = OLD.verification_status AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes) THEN
    RAISE EXCEPTION 'verification details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'a loss opening balance is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ct_loss_opening_guard_trg BEFORE INSERT OR UPDATE ON ct_loss_opening FOR EACH ROW EXECUTE FUNCTION ct_loss_opening_guard();
CREATE TRIGGER ct_loss_opening_no_delete BEFORE DELETE ON ct_loss_opening FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_loss_opening_no_truncate BEFORE TRUNCATE ON ct_loss_opening FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── The computation of a CT period ─────────
CREATE TABLE "ct_computation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "snapshot" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "carry_back" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "neighbours" JSONB NOT NULL,
    "prepared_by_user_id" UUID NOT NULL,
    "prepared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "approval_notes" TEXT,
    "superseded_by_id" UUID,
    CONSTRAINT "ct_computation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ctc_shape_ck CHECK (fingerprint ~ '^[0-9a-f]{64}$' AND jsonb_typeof(snapshot) = 'object' AND jsonb_typeof(neighbours) = 'object' AND carry_back >= 0),
    CONSTRAINT ctc_approval_ck CHECK (status IN ('PREPARED','APPROVED') AND (
      (status = 'PREPARED' AND approved_by_user_id IS NULL AND approved_at IS NULL AND approval_notes IS NULL)
      OR (status = 'APPROVED' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND char_length(btrim(approval_notes)) >= 10 AND approved_by_user_id <> prepared_by_user_id)))
);
CREATE UNIQUE INDEX "ct_computation_organisation_id_id_key" ON "ct_computation"("organisation_id", "id");
CREATE UNIQUE INDEX "ct_computation_current_key" ON "ct_computation"("organisation_id", "period_id") WHERE "superseded_by_id" IS NULL;
ALTER TABLE "ct_computation" ADD CONSTRAINT "ctc_period_fkey" FOREIGN KEY ("organisation_id", "period_id") REFERENCES "ct_period"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_computation" ADD CONSTRAINT "ctc_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ct_computation" ADD CONSTRAINT "ctc_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "ct_computation"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ct_computation" ADD CONSTRAINT "ctc_prepared_by_fkey" FOREIGN KEY ("prepared_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_computation" ADD CONSTRAINT "ctc_approved_by_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION ct_computation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PREPARED' THEN RAISE EXCEPTION 'a computation starts PREPARED' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.period_id <> OLD.period_id OR NEW.snapshot <> OLD.snapshot
     OR NEW.fingerprint <> OLD.fingerprint OR NEW.carry_back <> OLD.carry_back OR NEW.neighbours <> OLD.neighbours OR NEW.prepared_by_user_id <> OLD.prepared_by_user_id OR NEW.prepared_at <> OLD.prepared_at THEN
    RAISE EXCEPTION 'a Corporation Tax computation is never changed; prepare a new one' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status <> 'PREPARED' OR NEW.status <> 'APPROVED' OR OLD.superseded_by_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a computation is approved once, while it is current' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status AND (NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approval_notes IS DISTINCT FROM OLD.approval_notes) THEN
    RAISE EXCEPTION 'approval details cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND OLD.superseded_by_id IS NOT NULL THEN RAISE EXCEPTION 'a computation is superseded once' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ct_computation_guard_trg BEFORE INSERT OR UPDATE ON ct_computation FOR EACH ROW EXECUTE FUNCTION ct_computation_guard();
CREATE TRIGGER ct_computation_no_delete BEFORE DELETE ON ct_computation FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_computation_no_truncate BEFORE TRUNCATE ON ct_computation FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ct_loss_opening','ct_computation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

-- ───────── Permission (DEC-101) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['ct:approve']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'ct_loss_opening', 'ACCOUNTING_RECORDS'), ('TABLE', 'ct_computation', 'ACCOUNTING_RECORDS');
