-- V3 / milestone V3-M2: the iXBRL document and its validation (DEC-094). Additive. The document is built from the approved accounts package
-- (DEC-070) and the verified taxonomy mapping (DEC-093); it changes no accounting record and nothing is filed here.

-- ───────── The entity identifier scheme is data of the taxonomy version, frozen with it ─────────
ALTER TABLE "xbrl_taxonomy_version" ADD COLUMN "entity_scheme" TEXT;
ALTER TABLE "xbrl_taxonomy_version" ADD CONSTRAINT xtv_entity_scheme_ck CHECK (entity_scheme IS NULL OR (entity_scheme ~ '^https?://' AND char_length(entity_scheme) <= 500));
CREATE OR REPLACE FUNCTION xbrl_taxonomy_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new taxonomy version starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.standard_code <> OLD.standard_code OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.created_at <> OLD.created_at OR NEW.copied_from_id IS DISTINCT FROM OLD.copied_from_id THEN
    RAISE EXCEPTION 'what a taxonomy version is cannot change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'UNVERIFIED' AND (NEW.label <> OLD.label OR NEW.entry_point <> OLD.entry_point OR NEW.namespaces <> OLD.namespaces OR NEW.effective_from <> OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.entity_scheme IS DISTINCT FROM OLD.entity_scheme OR NEW.source_url <> OLD.source_url OR NEW.source_reference <> OLD.source_reference
     OR NEW.source_retrieved_on <> OLD.source_retrieved_on OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes) THEN
    RAISE EXCEPTION 'a verified taxonomy version is frozen; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'UNVERIFIED' AND NEW.status = 'VERIFIED') OR (OLD.status = 'VERIFIED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a taxonomy version moves only from UNVERIFIED to VERIFIED, and from VERIFIED to SUPERSEDED' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'VERIFIED' AND OLD.status = 'UNVERIFIED' AND NEW.verified_by_user_id IS NULL THEN RAISE EXCEPTION 'verification names the verifier' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

-- ───────── Generated documents: append-only ─────────
CREATE TABLE "ixbrl_document" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "taxonomy_version_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "fact_count" INTEGER NOT NULL,
    "context_count" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "ixbrl_document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ixd_status_ck CHECK (status IN ('VALID','INVALID') AND (status = 'VALID') = (jsonb_array_length(errors) = 0)),
    CONSTRAINT ixd_sha_ck CHECK (sha256 ~ '^[0-9a-f]{64}$' AND fact_count >= 0 AND context_count >= 0 AND jsonb_typeof(warnings) = 'array')
);
CREATE UNIQUE INDEX "ixbrl_document_organisation_id_id_key" ON "ixbrl_document"("organisation_id", "id");
CREATE INDEX "ixbrl_document_package_idx" ON "ixbrl_document"("organisation_id", "package_id", "at");
ALTER TABLE "ixbrl_document" ADD CONSTRAINT "ixd_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ixbrl_document" ADD CONSTRAINT "ixd_package_fkey" FOREIGN KEY ("package_id") REFERENCES "accounts_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ixbrl_document" ADD CONSTRAINT "ixd_taxonomy_fkey" FOREIGN KEY ("organisation_id", "taxonomy_version_id") REFERENCES "xbrl_taxonomy_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ixbrl_document" ADD CONSTRAINT "ixd_by_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER ixbrl_document_no_update BEFORE UPDATE ON ixbrl_document FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ixbrl_document_no_delete BEFORE DELETE ON ixbrl_document FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ixbrl_document_no_truncate BEFORE TRUNCATE ON ixbrl_document FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE "ixbrl_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ixbrl_document" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ixbrl_document" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE UPDATE, DELETE, TRUNCATE ON "ixbrl_document" FROM uk_app;

-- ───────── Retention classification (ADR-39; DEC-084) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'ixbrl_document', 'FILING_EVIDENCE');
