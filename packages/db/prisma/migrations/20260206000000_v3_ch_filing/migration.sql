-- V3 / milestone V3-M3: the Companies House filing workflow (DEC-095). Additive. There is no Companies House connection: the port's only adapter
-- is a fake, refused in production. A filing moves DRAFT -> VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED / REJECTED, or is recorded as
-- ACCEPTED when it was made elsewhere; every move leaves an append-only event.

CREATE TABLE "ch_filing" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "mode" TEXT NOT NULL DEFAULT 'PORT',
    "payload_sha256" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_by_user_id" UUID,
    "authorised_by_user_id" UUID,
    "director_contact_id" UUID,
    "authorised_on" DATE,
    "authority_evidence_id" UUID,
    "submission_id" TEXT,
    "ch_reference" TEXT,
    "accepted_on" DATE,
    "acceptance_evidence_id" UUID,
    "rejection_reasons" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ch_filing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT chf_status_ck CHECK (status IN ('DRAFT','VALIDATED','AUTHORISED','SUBMITTED','ACCEPTED','REJECTED') AND mode IN ('PORT','RECORDED')),
    CONSTRAINT chf_sha_ck CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chf_validated_ck CHECK (status = 'DRAFT' OR validated_by_user_id IS NOT NULL),
    CONSTRAINT chf_authority_ck CHECK ((authorised_by_user_id IS NULL) = (director_contact_id IS NULL) AND (authorised_by_user_id IS NULL) = (authorised_on IS NULL)
                                       AND (authorised_by_user_id IS NULL) = (authority_evidence_id IS NULL)
                                       AND (authorised_by_user_id IS NULL OR authorised_by_user_id <> validated_by_user_id)),
    CONSTRAINT chf_submitted_ck CHECK (status NOT IN ('SUBMITTED','REJECTED') OR (mode = 'PORT' AND submission_id IS NOT NULL AND authorised_by_user_id IS NOT NULL)),
    CONSTRAINT chf_accepted_ck CHECK ((status = 'ACCEPTED') = (ch_reference IS NOT NULL AND accepted_on IS NOT NULL)
                                      AND (mode = 'PORT' OR (status = 'ACCEPTED' AND acceptance_evidence_id IS NOT NULL)))
);
CREATE UNIQUE INDEX "ch_filing_organisation_id_id_key" ON "ch_filing"("organisation_id", "id");
-- one live filing per document: a REJECTED filing is final and a new one may follow
CREATE UNIQUE INDEX "ch_filing_document_live_key" ON "ch_filing"("organisation_id", "document_id") WHERE status <> 'REJECTED';
CREATE INDEX "ch_filing_company_idx" ON "ch_filing"("organisation_id", "company_id", "created_at");
ALTER TABLE "ch_filing" ADD CONSTRAINT "chf_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ch_filing" ADD CONSTRAINT "chf_document_fkey" FOREIGN KEY ("organisation_id", "document_id") REFERENCES "ixbrl_document"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ch_filing" ADD CONSTRAINT "chf_director_fkey" FOREIGN KEY ("organisation_id", "director_contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ch_filing" ADD CONSTRAINT "chf_authority_evidence_fkey" FOREIGN KEY ("authority_evidence_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ch_filing" ADD CONSTRAINT "chf_acceptance_evidence_fkey" FOREIGN KEY ("acceptance_evidence_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ch_filing" ADD CONSTRAINT "chf_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ch_filing" ADD CONSTRAINT "chf_validated_by_fkey" FOREIGN KEY ("validated_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ch_filing" ADD CONSTRAINT "chf_authorised_by_fkey" FOREIGN KEY ("authorised_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A filing starts DRAFT; it moves only along the specification's path; what it files and each step's facts, once recorded, never change.
CREATE OR REPLACE FUNCTION ch_filing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.mode <> 'PORT' THEN RAISE EXCEPTION 'a Companies House filing starts as a DRAFT' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.document_id <> OLD.document_id
     OR NEW.payload_sha256 <> OLD.payload_sha256 OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what a filing files cannot change' USING ERRCODE = '42501';
  END IF;
  IF (OLD.validated_by_user_id IS NOT NULL AND NEW.validated_by_user_id IS DISTINCT FROM OLD.validated_by_user_id)
     OR (OLD.authorised_by_user_id IS NOT NULL AND (NEW.authorised_by_user_id IS DISTINCT FROM OLD.authorised_by_user_id OR NEW.director_contact_id IS DISTINCT FROM OLD.director_contact_id
         OR NEW.authorised_on IS DISTINCT FROM OLD.authorised_on OR NEW.authority_evidence_id IS DISTINCT FROM OLD.authority_evidence_id))
     OR (OLD.submission_id IS NOT NULL AND NEW.submission_id IS DISTINCT FROM OLD.submission_id)
     OR (OLD.ch_reference IS NOT NULL AND NEW.ch_reference IS DISTINCT FROM OLD.ch_reference) THEN
    RAISE EXCEPTION 'the facts of a filing step, once recorded, cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'VALIDATED') OR (OLD.status = 'VALIDATED' AND NEW.status = 'AUTHORISED')
    OR (OLD.status = 'AUTHORISED' AND NEW.status = 'SUBMITTED') OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('ACCEPTED','REJECTED'))
    OR (OLD.status IN ('VALIDATED','AUTHORISED') AND NEW.status = 'ACCEPTED' AND NEW.mode = 'RECORDED')) THEN
    RAISE EXCEPTION 'a filing moves only DRAFT -> VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED or REJECTED, or is recorded as ACCEPTED' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status AND OLD.status IN ('ACCEPTED','REJECTED') THEN RAISE EXCEPTION 'an ACCEPTED or REJECTED filing is final' USING ERRCODE = '42501'; END IF;
  IF NEW.mode <> OLD.mode AND NOT (NEW.mode = 'RECORDED' AND NEW.status = 'ACCEPTED' AND OLD.status IN ('VALIDATED','AUTHORISED')) THEN RAISE EXCEPTION 'the mode of a filing changes only when it is recorded' USING ERRCODE = '42501'; END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER ch_filing_guard_trg BEFORE INSERT OR UPDATE ON ch_filing FOR EACH ROW EXECUTE FUNCTION ch_filing_guard();
CREATE TRIGGER ch_filing_no_delete BEFORE DELETE ON ch_filing FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ch_filing_no_truncate BEFORE TRUNCATE ON ch_filing FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── The evidence of each move: append-only ─────────
CREATE TABLE "ch_filing_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" INTEGER GENERATED BY DEFAULT AS IDENTITY,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "filing_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "submission_id" TEXT,
    "request" JSONB,
    "response" JSONB,
    "note" TEXT,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "ch_filing_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT chfe_status_ck CHECK (to_status IN ('DRAFT','VALIDATED','AUTHORISED','SUBMITTED','ACCEPTED','REJECTED')),
    CONSTRAINT chfe_note_ck CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "ch_filing_event_seq_key" ON "ch_filing_event"("seq");
CREATE INDEX "ch_filing_event_filing_idx" ON "ch_filing_event"("organisation_id", "filing_id", "seq");
ALTER TABLE "ch_filing_event" ADD CONSTRAINT "chfe_filing_fkey" FOREIGN KEY ("organisation_id", "filing_id") REFERENCES "ch_filing"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ch_filing_event" ADD CONSTRAINT "chfe_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ch_filing_event" ADD CONSTRAINT "chfe_by_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER ch_filing_event_no_update BEFORE UPDATE ON ch_filing_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ch_filing_event_no_delete BEFORE DELETE ON ch_filing_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ch_filing_event_no_truncate BEFORE TRUNCATE ON ch_filing_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ch_filing','ch_filing_event']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "ch_filing_event" FROM uk_app;

-- ───────── Permissions (DEC-095) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['ixbrl:file']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; DEC-084) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'ch_filing', 'FILING_EVIDENCE'), ('TABLE', 'ch_filing_event', 'FILING_EVIDENCE');
