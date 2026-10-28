-- V3 / milestone V3-M1: the taxonomy and its mapping (DEC-093). Additive. NO taxonomy version or concept is inserted here: a firm enters (or
-- imports) each version with its source, and a different person verifies it before use (the DEC-021 pattern). Nothing of the taxonomy is in code.

CREATE TABLE "xbrl_taxonomy_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "standard_code" TEXT NOT NULL,
    "entry_point" TEXT NOT NULL,
    "namespaces" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source_url" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "source_retrieved_on" DATE NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "copied_from_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "verification_notes" TEXT,
    "superseded_by_id" UUID,
    CONSTRAINT "xbrl_taxonomy_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT xtv_label_ck CHECK (char_length(btrim(label)) BETWEEN 3 AND 200 AND char_length(btrim(standard_code)) BETWEEN 2 AND 40),
    CONSTRAINT xtv_entry_ck CHECK (entry_point ~ '^https?://' AND char_length(entry_point) <= 500 AND jsonb_typeof(namespaces) = 'object'),
    CONSTRAINT xtv_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT xtv_source_ck CHECK (source_url ~ '^https?://' AND char_length(source_url) <= 500 AND char_length(btrim(source_reference)) BETWEEN 3 AND 300),
    CONSTRAINT xtv_status_ck CHECK (
      (status = 'UNVERIFIED' AND verified_by_user_id IS NULL AND verified_at IS NULL AND superseded_by_id IS NULL)
      OR (status IN ('VERIFIED','SUPERSEDED') AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verified_by_user_id <> created_by_user_id
          AND char_length(btrim(coalesce(verification_notes, ''))) >= 10 AND (status = 'SUPERSEDED') = (superseded_by_id IS NOT NULL)))
);
CREATE UNIQUE INDEX "xbrl_taxonomy_version_organisation_id_id_key" ON "xbrl_taxonomy_version"("organisation_id", "id");
CREATE INDEX "xtv_standard_idx" ON "xbrl_taxonomy_version"("organisation_id", "standard_code", "effective_from");
ALTER TABLE "xbrl_taxonomy_version" ADD CONSTRAINT "xtv_organisation_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "xbrl_taxonomy_version" ADD CONSTRAINT "xtv_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "xbrl_taxonomy_version" ADD CONSTRAINT "xtv_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "xbrl_taxonomy_version" ADD CONSTRAINT "xtv_copied_from_fkey" FOREIGN KEY ("organisation_id", "copied_from_id") REFERENCES "xbrl_taxonomy_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "xbrl_taxonomy_version" ADD CONSTRAINT "xtv_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "xbrl_taxonomy_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- A version starts UNVERIFIED; its content changes only while UNVERIFIED; it is verified once (UNVERIFIED -> VERIFIED) and superseded once (VERIFIED -> SUPERSEDED).
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
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.source_url <> OLD.source_url OR NEW.source_reference <> OLD.source_reference
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
CREATE TRIGGER xbrl_taxonomy_version_guard_trg BEFORE INSERT OR UPDATE ON xbrl_taxonomy_version FOR EACH ROW EXECUTE FUNCTION xbrl_taxonomy_version_guard();
CREATE TRIGGER xbrl_taxonomy_version_no_delete BEFORE DELETE ON xbrl_taxonomy_version FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER xbrl_taxonomy_version_no_truncate BEFORE TRUNCATE ON xbrl_taxonomy_version FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── The concept map of a version ─────────
CREATE TABLE "xbrl_concept_map" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "data_type" TEXT NOT NULL,
    "period_type" TEXT NOT NULL,
    "negate" BOOLEAN NOT NULL DEFAULT false,
    "decimals" SMALLINT,
    "dimensions" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "xbrl_concept_map_pkey" PRIMARY KEY ("id"),
    CONSTRAINT xcm_kind_ck CHECK (source_kind IN ('LINE','FACT','COMPANY') AND char_length(btrim(source_key)) BETWEEN 1 AND 100),
    CONSTRAINT xcm_concept_ck CHECK (concept ~ '^[a-z][a-z0-9-]{0,19}:[A-Za-z_][A-Za-z0-9_.-]{0,199}$'),
    CONSTRAINT xcm_type_ck CHECK (data_type IN ('MONETARY','TEXT','DATE') AND period_type IN ('INSTANT','DURATION')),
    CONSTRAINT xcm_monetary_ck CHECK ((data_type = 'MONETARY' AND decimals IS NOT NULL AND decimals BETWEEN -6 AND 6) OR (data_type <> 'MONETARY' AND decimals IS NULL AND NOT negate)),
    CONSTRAINT xcm_dimensions_ck CHECK (jsonb_typeof(dimensions) = 'array' AND jsonb_array_length(dimensions) <= 5)
);
CREATE UNIQUE INDEX "xbrl_concept_map_source_key" ON "xbrl_concept_map"("organisation_id", "version_id", "source_kind", "source_key");
ALTER TABLE "xbrl_concept_map" ADD CONSTRAINT "xcm_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "xbrl_taxonomy_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Entries are added, changed or removed only while their version is UNVERIFIED.
CREATE OR REPLACE FUNCTION xbrl_concept_map_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'UPDATE' AND (NEW.version_id <> OLD.version_id OR NEW.organisation_id <> OLD.organisation_id) THEN
    RAISE EXCEPTION 'an entry stays in its taxonomy version' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM xbrl_taxonomy_version v WHERE v.organisation_id = r.organisation_id AND v.id = r.version_id AND v.status = 'UNVERIFIED') THEN
    RAISE EXCEPTION 'the entries of a verified taxonomy version are frozen; supersede the version' USING ERRCODE = '42501';
  END IF;
  RETURN r;
END $$;
CREATE TRIGGER xbrl_concept_map_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON xbrl_concept_map FOR EACH ROW EXECUTE FUNCTION xbrl_concept_map_guard();
-- entries may be deleted (while UNVERIFIED, above), so the shared append-only function is not used here; a truncate is still refused
CREATE OR REPLACE FUNCTION xbrl_concept_map_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on xbrl_concept_map is not permitted' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER xbrl_concept_map_no_truncate BEFORE TRUNCATE ON xbrl_concept_map FOR EACH STATEMENT EXECUTE FUNCTION xbrl_concept_map_no_truncate();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['xbrl_taxonomy_version','xbrl_concept_map']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE DELETE ON "xbrl_taxonomy_version" FROM uk_app;

-- ───────── Permissions (DEC-093): as the standards permissions ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['ixbrl:rules-manage','ixbrl:rule-verify']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; DEC-084) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
  ('TABLE', 'xbrl_taxonomy_version', 'ACCOUNTING_RECORDS'), ('TABLE', 'xbrl_concept_map', 'ACCOUNTING_RECORDS');
