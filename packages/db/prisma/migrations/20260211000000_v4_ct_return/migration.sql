-- V4 / milestone V4-M5: the CT return and its submission (DEC-102). Additive. There is no HMRC connection: the port's only adapter is a fake,
-- refused in production. A return of an approved computation moves DRAFT -> VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED / REJECTED, or is
-- recorded as ACCEPTED when it was filed elsewhere; every move leaves an append-only event. Mirrors the Companies House filing (DEC-095).

CREATE TABLE "ct_return" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "computation_id" UUID NOT NULL,
    "accounts_ixbrl_document_id" UUID NOT NULL,
    "package" JSONB NOT NULL,
    "computation_ixbrl" TEXT NOT NULL,
    "computation_ixbrl_sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "mode" TEXT NOT NULL DEFAULT 'PORT',
    "payload_sha256" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_by_user_id" UUID,
    "authorised_by_user_id" UUID,
    "director_contact_id" UUID,
    "declared_on" DATE,
    "authority_evidence_id" UUID,
    "submission_id" TEXT,
    "hmrc_reference" TEXT,
    "accepted_on" DATE,
    "acceptance_evidence_id" UUID,
    "rejection_reasons" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ct_return_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ctr2_status_ck CHECK (status IN ('DRAFT','VALIDATED','AUTHORISED','SUBMITTED','ACCEPTED','REJECTED') AND mode IN ('PORT','RECORDED')),
    CONSTRAINT ctr2_sha_ck CHECK (payload_sha256 ~ '^[0-9a-f]{64}$' AND computation_ixbrl_sha256 ~ '^[0-9a-f]{64}$' AND jsonb_typeof(package) = 'object'),
    CONSTRAINT ctr2_validated_ck CHECK (status = 'DRAFT' OR validated_by_user_id IS NOT NULL),
    CONSTRAINT ctr2_authority_ck CHECK ((authorised_by_user_id IS NULL) = (director_contact_id IS NULL) AND (authorised_by_user_id IS NULL) = (declared_on IS NULL)
                                       AND (authorised_by_user_id IS NULL) = (authority_evidence_id IS NULL)
                                       AND (authorised_by_user_id IS NULL OR authorised_by_user_id <> validated_by_user_id)),
    CONSTRAINT ctr2_submitted_ck CHECK (status NOT IN ('SUBMITTED','REJECTED') OR (mode = 'PORT' AND submission_id IS NOT NULL AND authorised_by_user_id IS NOT NULL)),
    CONSTRAINT ctr2_accepted_ck CHECK ((status = 'ACCEPTED') = (hmrc_reference IS NOT NULL AND accepted_on IS NOT NULL)
                                      AND (mode = 'PORT' OR (status = 'ACCEPTED' AND acceptance_evidence_id IS NOT NULL)))
);
CREATE UNIQUE INDEX "ct_return_organisation_id_id_key" ON "ct_return"("organisation_id", "id");
-- one live return per computation: a REJECTED return is final and a new one may follow
CREATE UNIQUE INDEX "ct_return_computation_live_key" ON "ct_return"("organisation_id", "computation_id") WHERE status <> 'REJECTED';
CREATE INDEX "ct_return_company_idx" ON "ct_return"("organisation_id", "company_id", "created_at");
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_period_fkey" FOREIGN KEY ("organisation_id", "period_id") REFERENCES "ct_period"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_computation_fkey" FOREIGN KEY ("organisation_id", "computation_id") REFERENCES "ct_computation"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_accounts_fkey" FOREIGN KEY ("organisation_id", "accounts_ixbrl_document_id") REFERENCES "ixbrl_document"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_director_fkey" FOREIGN KEY ("organisation_id", "director_contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_authority_evidence_fkey" FOREIGN KEY ("authority_evidence_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_acceptance_evidence_fkey" FOREIGN KEY ("acceptance_evidence_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_validated_by_fkey" FOREIGN KEY ("validated_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return" ADD CONSTRAINT "ctr2_authorised_by_fkey" FOREIGN KEY ("authorised_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION ct_return_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.mode <> 'PORT' THEN RAISE EXCEPTION 'a CT return starts as a DRAFT' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM ct_computation c WHERE c.id = NEW.computation_id AND c.period_id = NEW.period_id AND c.company_id = NEW.company_id AND c.status = 'APPROVED') THEN
      RAISE EXCEPTION 'a CT return files an approved computation of its period' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.period_id <> OLD.period_id OR NEW.computation_id <> OLD.computation_id
     OR NEW.accounts_ixbrl_document_id <> OLD.accounts_ixbrl_document_id OR NEW.package <> OLD.package OR NEW.computation_ixbrl <> OLD.computation_ixbrl
     OR NEW.computation_ixbrl_sha256 <> OLD.computation_ixbrl_sha256 OR NEW.payload_sha256 <> OLD.payload_sha256 OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what a CT return files cannot change' USING ERRCODE = '42501';
  END IF;
  IF (OLD.validated_by_user_id IS NOT NULL AND NEW.validated_by_user_id IS DISTINCT FROM OLD.validated_by_user_id)
     OR (OLD.authorised_by_user_id IS NOT NULL AND (NEW.authorised_by_user_id IS DISTINCT FROM OLD.authorised_by_user_id OR NEW.director_contact_id IS DISTINCT FROM OLD.director_contact_id
         OR NEW.declared_on IS DISTINCT FROM OLD.declared_on OR NEW.authority_evidence_id IS DISTINCT FROM OLD.authority_evidence_id))
     OR (OLD.submission_id IS NOT NULL AND NEW.submission_id IS DISTINCT FROM OLD.submission_id)
     OR (OLD.hmrc_reference IS NOT NULL AND NEW.hmrc_reference IS DISTINCT FROM OLD.hmrc_reference) THEN
    RAISE EXCEPTION 'the facts of a return step, once recorded, cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'VALIDATED') OR (OLD.status = 'VALIDATED' AND NEW.status = 'AUTHORISED')
    OR (OLD.status = 'AUTHORISED' AND NEW.status = 'SUBMITTED') OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('ACCEPTED','REJECTED'))
    OR (OLD.status IN ('VALIDATED','AUTHORISED') AND NEW.status = 'ACCEPTED' AND NEW.mode = 'RECORDED')) THEN
    RAISE EXCEPTION 'a CT return moves only DRAFT -> VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED or REJECTED, or is recorded as ACCEPTED' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status AND OLD.status IN ('ACCEPTED','REJECTED') THEN RAISE EXCEPTION 'an ACCEPTED or REJECTED return is final' USING ERRCODE = '42501'; END IF;
  IF NEW.mode <> OLD.mode AND NOT (NEW.mode = 'RECORDED' AND NEW.status = 'ACCEPTED' AND OLD.status IN ('VALIDATED','AUTHORISED')) THEN RAISE EXCEPTION 'the mode of a return changes only when it is recorded' USING ERRCODE = '42501'; END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER ct_return_guard_trg BEFORE INSERT OR UPDATE ON ct_return FOR EACH ROW EXECUTE FUNCTION ct_return_guard();
CREATE TRIGGER ct_return_no_delete BEFORE DELETE ON ct_return FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_return_no_truncate BEFORE TRUNCATE ON ct_return FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE "ct_return_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" INTEGER GENERATED BY DEFAULT AS IDENTITY,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "submission_id" TEXT,
    "request" JSONB,
    "response" JSONB,
    "note" TEXT,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "ct_return_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ctre_status_ck CHECK (to_status IN ('DRAFT','VALIDATED','AUTHORISED','SUBMITTED','ACCEPTED','REJECTED')),
    CONSTRAINT ctre_note_ck CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "ct_return_event_seq_key" ON "ct_return_event"("seq");
CREATE INDEX "ct_return_event_return_idx" ON "ct_return_event"("organisation_id", "return_id", "seq");
ALTER TABLE "ct_return_event" ADD CONSTRAINT "ctre_return_fkey" FOREIGN KEY ("organisation_id", "return_id") REFERENCES "ct_return"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ct_return_event" ADD CONSTRAINT "ctre_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ct_return_event" ADD CONSTRAINT "ctre_by_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER ct_return_event_no_update BEFORE UPDATE ON ct_return_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_return_event_no_delete BEFORE DELETE ON ct_return_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ct_return_event_no_truncate BEFORE TRUNCATE ON ct_return_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ct_return','ct_return_event']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "ct_return_event" FROM uk_app;

ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['ct:file']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'ct_return', 'FILING_EVIDENCE'), ('TABLE', 'ct_return_event', 'FILING_EVIDENCE');
