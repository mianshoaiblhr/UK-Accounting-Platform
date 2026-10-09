-- V0 Tranche A / increment 7b: OCR-ready document pipeline (specification §6 "OCR-ready pipeline", §10 OCRProvider).
-- Extraction output is DATA attached to a document version, never a decision. Only organisations that switched the `documents.ocr`
-- feature flag on get extractions; the table itself is inert otherwise.
CREATE UNIQUE INDEX IF NOT EXISTS "document_version_organisation_id_id_key" ON "document_version"("organisation_id", "id");

CREATE TABLE "document_extraction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "engine_version" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "text" TEXT,
    "char_count" INTEGER,
    "page_count" INTEGER,
    "confidence" NUMERIC(4,3),
    "language" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    CONSTRAINT "document_extraction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT document_extraction_status_ck CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED')),
    CONSTRAINT document_extraction_text_ck CHECK (text IS NULL OR char_length(text) <= 1000000),
    CONSTRAINT document_extraction_confidence_ck CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT document_extraction_succeeded_ck CHECK (status <> 'SUCCEEDED' OR (text IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX "document_extraction_document_version_id_provider_key" ON "document_extraction"("document_version_id", "provider");
CREATE INDEX "document_extraction_organisation_id_document_id_idx" ON "document_extraction"("organisation_id", "document_id");
ALTER TABLE "document_extraction" ADD CONSTRAINT "document_extraction_organisation_id_document_id_fkey" FOREIGN KEY ("organisation_id", "document_id") REFERENCES "document"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_extraction" ADD CONSTRAINT "document_extraction_organisation_id_version_id_fkey" FOREIGN KEY ("organisation_id", "document_version_id") REFERENCES "document_version"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The extraction belongs to the version's own document; a SUCCEEDED extraction is final (a different engine writes a new row).
CREATE OR REPLACE FUNCTION document_extraction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_doc uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT document_id INTO v_doc FROM document_version WHERE organisation_id = NEW.organisation_id AND id = NEW.document_version_id;
    IF v_doc IS DISTINCT FROM NEW.document_id THEN RAISE EXCEPTION 'the extraction version does not belong to the document' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.document_id <> OLD.document_id OR NEW.document_version_id <> OLD.document_version_id OR NEW.provider <> OLD.provider OR NEW.organisation_id <> OLD.organisation_id THEN
      RAISE EXCEPTION 'an extraction cannot be retargeted' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'SUCCEEDED' AND (NEW.status <> 'SUCCEEDED' OR NEW.text IS DISTINCT FROM OLD.text OR NEW.page_count IS DISTINCT FROM OLD.page_count OR NEW.confidence IS DISTINCT FROM OLD.confidence) THEN
      RAISE EXCEPTION 'a completed extraction is final' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_extraction_guard_trg BEFORE INSERT OR UPDATE ON "document_extraction" FOR EACH ROW EXECUTE FUNCTION document_extraction_guard();

ALTER TABLE "document_extraction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_extraction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_extraction" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE DELETE, TRUNCATE ON "document_extraction" FROM uk_app;
