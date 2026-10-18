-- V2 / milestone V2-M1: accounting standards as data (DEC-051..054; ADR-62, ADR-63). Additive.
-- NO standard content is inserted here: firms enter standards, versions, lines, maps and rules with their source; a different person verifies each version.

-- ───────── Standards: what a firm reports under (FRS105, FRS102-1A, ...); immutable ─────────
CREATE TABLE "reporting_standard" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reporting_standard_pkey" PRIMARY KEY ("id"),
    CONSTRAINT reporting_standard_code_ck CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,23}$'),
    CONSTRAINT reporting_standard_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX "reporting_standard_organisation_id_id_key" ON "reporting_standard"("organisation_id", "id");
CREATE UNIQUE INDEX "reporting_standard_organisation_id_code_key" ON "reporting_standard"("organisation_id", "code");
ALTER TABLE "reporting_standard" ADD CONSTRAINT "reporting_standard_organisation_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reporting_standard" ADD CONSTRAINT "reporting_standard_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER reporting_standard_no_mutation BEFORE UPDATE OR DELETE ON reporting_standard FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reporting_standard_no_truncate BEFORE TRUNCATE ON reporting_standard FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── Versions: effective-dated, sourced, verified by a second person (DEC-052) ─────────
CREATE TABLE "reporting_standard_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "standard_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
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
    CONSTRAINT "reporting_standard_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT rsv_label_ck CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
    CONSTRAINT rsv_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT rsv_source_ck CHECK (char_length(source_url) BETWEEN 8 AND 500 AND source_url ~ '^https?://' AND char_length(btrim(source_reference)) BETWEEN 3 AND 300),
    CONSTRAINT rsv_status_ck CHECK (status IN ('UNVERIFIED','VERIFIED','SUPERSEDED')),
    CONSTRAINT rsv_verification_ck CHECK (
      (verified_by_user_id IS NULL AND verified_at IS NULL AND status = 'UNVERIFIED')
      OR (status IN ('VERIFIED','SUPERSEDED') AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> created_by_user_id)),
    CONSTRAINT rsv_superseded_ck CHECK ((status = 'SUPERSEDED') = (superseded_by_id IS NOT NULL))
);
CREATE UNIQUE INDEX "rsv_organisation_id_id_key" ON "reporting_standard_version"("organisation_id", "id");
CREATE INDEX "rsv_standard_idx" ON "reporting_standard_version"("organisation_id", "standard_id", "effective_from");
ALTER TABLE "reporting_standard_version" ADD CONSTRAINT "rsv_standard_fkey" FOREIGN KEY ("organisation_id", "standard_id") REFERENCES "reporting_standard"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reporting_standard_version" ADD CONSTRAINT "rsv_copied_from_fkey" FOREIGN KEY ("organisation_id", "copied_from_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reporting_standard_version" ADD CONSTRAINT "rsv_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "reporting_standard_version" ADD CONSTRAINT "rsv_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reporting_standard_version" ADD CONSTRAINT "rsv_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Insert: a version starts UNVERIFIED. Update: while UNVERIFIED its own fields may change; it is verified once (by another person); only a VERIFIED
-- version is superseded (an unverified one is simply edited); a VERIFIED version's content never changes; a SUPERSEDED one never changes again.
CREATE OR REPLACE FUNCTION rsv_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the current (not superseded) versions of one standard never overlap in effect (a supersession marks the old version first)
  IF NEW.status <> 'SUPERSEDED' AND EXISTS (SELECT 1 FROM reporting_standard_version v WHERE v.standard_id = NEW.standard_id AND v.organisation_id = NEW.organisation_id
       AND v.id <> NEW.id AND v.status <> 'SUPERSEDED' AND daterange(v.effective_from, v.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')) THEN
    RAISE EXCEPTION 'the version overlaps another current version of the same standard; supersede it or end it first' USING ERRCODE = '23P01';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new standard version starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.standard_id <> OLD.standard_id OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.created_at <> OLD.created_at OR NEW.copied_from_id IS DISTINCT FROM OLD.copied_from_id THEN
    RAISE EXCEPTION 'a standard version belongs to one standard and one author' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'SUPERSEDED' THEN RAISE EXCEPTION 'a superseded standard version is final' USING ERRCODE = '42501'; END IF;
  IF OLD.status = 'VERIFIED' AND (NEW.label <> OLD.label OR NEW.effective_from <> OLD.effective_from OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.source_url <> OLD.source_url OR NEW.source_reference <> OLD.source_reference OR NEW.source_retrieved_on <> OLD.source_retrieved_on
     OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes) THEN
    RAISE EXCEPTION 'a verified standard version is immutable; supersede it with a new version' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'UNVERIFIED' AND NEW.status = 'VERIFIED') OR (OLD.status = 'VERIFIED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a standard version is verified once and superseded once' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'VERIFIED' AND OLD.status = 'UNVERIFIED' THEN
    -- the content is consistent: every map entry lands on a line of the version that is fed from accounts
    IF EXISTS (SELECT 1 FROM statutory_map_entry m WHERE m.version_id = NEW.id AND m.organisation_id = NEW.organisation_id AND NOT m.removed
               AND NOT EXISTS (SELECT 1 FROM statutory_line l WHERE l.version_id = NEW.id AND l.organisation_id = NEW.organisation_id AND l.key = m.target_key AND NOT l.removed AND l.kind = 'ACCOUNTS')) THEN
      RAISE EXCEPTION 'a map entry points at a line that is not an accounts line of this version' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM statutory_line l WHERE l.version_id = NEW.id AND l.organisation_id = NEW.organisation_id AND NOT l.removed) THEN
      RAISE EXCEPTION 'a version without statement lines cannot be verified' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rsv_guard_trg BEFORE INSERT OR UPDATE ON reporting_standard_version FOR EACH ROW EXECUTE FUNCTION rsv_guard();
CREATE TRIGGER rsv_no_delete BEFORE DELETE ON reporting_standard_version FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER rsv_no_truncate BEFORE TRUNCATE ON reporting_standard_version FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────── The content of a version: statement lines, map, validation and disclosure rules ─────────
CREATE TABLE "statutory_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "parent_key" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "natural_side" TEXT,
    "formula" JSONB,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "statutory_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT statutory_line_key_ck CHECK (key ~ '^[A-Z0-9][A-Z0-9_.-]{0,79}$'),
    CONSTRAINT statutory_line_statement_ck CHECK (statement IN ('PL','BS')),
    CONSTRAINT statutory_line_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 300),
    CONSTRAINT statutory_line_kind_ck CHECK (kind IN ('ACCOUNTS','TOTAL','RETAINED_PROFIT')),
    CONSTRAINT statutory_line_side_ck CHECK ((kind = 'TOTAL') = (natural_side IS NULL) AND (natural_side IS NULL OR natural_side IN ('DEBIT','CREDIT'))),
    CONSTRAINT statutory_line_formula_ck CHECK ((kind = 'TOTAL') = (formula IS NOT NULL) AND (formula IS NULL OR jsonb_typeof(formula) = 'array'))
);
CREATE UNIQUE INDEX "statutory_line_organisation_id_id_key" ON "statutory_line"("organisation_id", "id");
CREATE UNIQUE INDEX "statutory_line_version_key_key" ON "statutory_line"("organisation_id", "version_id", "key") WHERE NOT removed;
ALTER TABLE "statutory_line" ADD CONSTRAINT "statutory_line_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "statutory_map_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "source_line" TEXT NOT NULL,
    "account_subtype" TEXT,
    "target_key" TEXT NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "statutory_map_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT statutory_map_entry_source_ck CHECK (source_line ~ '^(PL|BS)\.[A-Z0-9_.]{1,80}$')
);
CREATE UNIQUE INDEX "statutory_map_entry_organisation_id_id_key" ON "statutory_map_entry"("organisation_id", "id");
CREATE UNIQUE INDEX "statutory_map_entry_unique" ON "statutory_map_entry"("organisation_id", "version_id", "source_line", (coalesce(account_subtype, ''))) WHERE NOT removed;
ALTER TABLE "statutory_map_entry" ADD CONSTRAINT "statutory_map_entry_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "validation_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "applies_to" TEXT[] NOT NULL DEFAULT ARRAY['MICRO','SMALL','MEDIUM','LARGE']::text[],
    "expression" JSONB NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "validation_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT validation_rule_key_ck CHECK (key ~ '^[A-Z0-9][A-Z0-9_.-]{0,79}$'),
    CONSTRAINT validation_rule_description_ck CHECK (char_length(btrim(description)) BETWEEN 3 AND 500),
    CONSTRAINT validation_rule_severity_ck CHECK (severity IN ('ERROR','WARNING')),
    CONSTRAINT validation_rule_sizes_ck CHECK (applies_to <@ ARRAY['MICRO','SMALL','MEDIUM','LARGE']::text[] AND cardinality(applies_to) > 0),
    CONSTRAINT validation_rule_expression_ck CHECK (jsonb_typeof(expression) = 'object')
);
CREATE UNIQUE INDEX "validation_rule_organisation_id_id_key" ON "validation_rule"("organisation_id", "id");
CREATE UNIQUE INDEX "validation_rule_version_key_key" ON "validation_rule"("organisation_id", "version_id", "key") WHERE NOT removed;
ALTER TABLE "validation_rule" ADD CONSTRAINT "validation_rule_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "disclosure_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "applies_to" TEXT[] NOT NULL DEFAULT ARRAY['MICRO','SMALL','MEDIUM','LARGE']::text[],
    "requires" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "disclosure_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT disclosure_rule_key_ck CHECK (key ~ '^[A-Z0-9][A-Z0-9_.-]{0,79}$'),
    CONSTRAINT disclosure_rule_title_ck CHECK (char_length(btrim(title)) BETWEEN 3 AND 300),
    CONSTRAINT disclosure_rule_sizes_ck CHECK (applies_to <@ ARRAY['MICRO','SMALL','MEDIUM','LARGE']::text[] AND cardinality(applies_to) > 0),
    CONSTRAINT disclosure_rule_requires_ck CHECK (jsonb_typeof(requires) = 'object')
);
CREATE UNIQUE INDEX "disclosure_rule_organisation_id_id_key" ON "disclosure_rule"("organisation_id", "id");
CREATE UNIQUE INDEX "disclosure_rule_version_key_key" ON "disclosure_rule"("organisation_id", "version_id", "key") WHERE NOT removed;
ALTER TABLE "disclosure_rule" ADD CONSTRAINT "disclosure_rule_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The content of a version changes only while the version is UNVERIFIED, and never moves to another version
CREATE OR REPLACE FUNCTION rsv_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.version_id <> OLD.version_id OR NEW.organisation_id <> OLD.organisation_id OR NEW.id <> OLD.id) THEN
    RAISE EXCEPTION 'standard content belongs to one version' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO st FROM reporting_standard_version WHERE id = NEW.version_id AND organisation_id = NEW.organisation_id;
  IF st IS DISTINCT FROM 'UNVERIFIED' THEN RAISE EXCEPTION 'the standard version is % and its content cannot change; supersede it with a new version', lower(coalesce(st, 'missing')) USING ERRCODE = '42501'; END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER statutory_line_guard_trg BEFORE INSERT OR UPDATE ON statutory_line FOR EACH ROW EXECUTE FUNCTION rsv_content_guard();
CREATE TRIGGER statutory_map_entry_guard_trg BEFORE INSERT OR UPDATE ON statutory_map_entry FOR EACH ROW EXECUTE FUNCTION rsv_content_guard();
CREATE TRIGGER validation_rule_guard_trg BEFORE INSERT OR UPDATE ON validation_rule FOR EACH ROW EXECUTE FUNCTION rsv_content_guard();
CREATE TRIGGER disclosure_rule_guard_trg BEFORE INSERT OR UPDATE ON disclosure_rule FOR EACH ROW EXECUTE FUNCTION rsv_content_guard();
CREATE TRIGGER statutory_line_no_delete BEFORE DELETE ON statutory_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER statutory_map_entry_no_delete BEFORE DELETE ON statutory_map_entry FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER validation_rule_no_delete BEFORE DELETE ON validation_rule FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER disclosure_rule_no_delete BEFORE DELETE ON disclosure_rule FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────── Per company: account overrides and the framework of each financial year ─────────
CREATE TABLE "statutory_account_override" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "target_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_user_id" UUID,
    "ended_reason" TEXT,
    CONSTRAINT "statutory_account_override_pkey" PRIMARY KEY ("id"),
    CONSTRAINT sao_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
    CONSTRAINT sao_end_ck CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL) AND (ended_at IS NULL) = (ended_reason IS NULL))
);
CREATE UNIQUE INDEX "sao_organisation_id_id_key" ON "statutory_account_override"("organisation_id", "id");
CREATE UNIQUE INDEX "sao_active_key" ON "statutory_account_override"("organisation_id", "company_id", "version_id", "account_id") WHERE ended_at IS NULL;
ALTER TABLE "statutory_account_override" ADD CONSTRAINT "sao_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "statutory_account_override" ADD CONSTRAINT "sao_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "statutory_account_override" ADD CONSTRAINT "sao_account_fkey" FOREIGN KEY ("organisation_id", "company_id", "account_id") REFERENCES "account"("organisation_id", "company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "statutory_account_override" ADD CONSTRAINT "sao_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "statutory_account_override" ADD CONSTRAINT "sao_ended_by_fkey" FOREIGN KEY ("ended_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- An override is written once and ended once; it must point at an accounts line of its version
CREATE OR REPLACE FUNCTION sao_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM statutory_line l WHERE l.version_id = NEW.version_id AND l.organisation_id = NEW.organisation_id AND l.key = NEW.target_key AND l.kind = 'ACCOUNTS' AND NOT l.removed) THEN
      RAISE EXCEPTION 'an override points at an accounts line of its version' USING ERRCODE = '23514';
    END IF;
    IF NEW.ended_at IS NOT NULL THEN RAISE EXCEPTION 'a new override is active' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.version_id <> OLD.version_id
     OR NEW.account_id <> OLD.account_id OR NEW.target_key <> OLD.target_key OR NEW.reason <> OLD.reason OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an override is ended, never edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sao_guard_trg BEFORE INSERT OR UPDATE ON statutory_account_override FOR EACH ROW EXECUTE FUNCTION sao_guard();
CREATE TRIGGER sao_no_delete BEFORE DELETE ON statutory_account_override FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE "company_reporting_framework" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "year_start" DATE NOT NULL,
    "year_end" DATE NOT NULL,
    "version_id" UUID NOT NULL,
    "entity_size" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "chosen_by_user_id" UUID NOT NULL,
    "chosen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    CONSTRAINT "company_reporting_framework_pkey" PRIMARY KEY ("id"),
    CONSTRAINT crf_range_ck CHECK (year_end > year_start AND year_end < year_start + 549),
    CONSTRAINT crf_size_ck CHECK (entity_size IN ('MICRO','SMALL','MEDIUM','LARGE')),
    CONSTRAINT crf_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE UNIQUE INDEX "crf_organisation_id_id_key" ON "company_reporting_framework"("organisation_id", "id");
CREATE UNIQUE INDEX "crf_company_year_key" ON "company_reporting_framework"("organisation_id", "company_id", "year_start");
ALTER TABLE "company_reporting_framework" ADD CONSTRAINT "crf_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_reporting_framework" ADD CONSTRAINT "crf_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_reporting_framework" ADD CONSTRAINT "crf_chosen_by_fkey" FOREIGN KEY ("chosen_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Financial years of a company never overlap; a locked year never changes (locking arrives in V2-M6)
CREATE OR REPLACE FUNCTION crf_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.locked_at IS NOT NULL THEN RAISE EXCEPTION 'the reporting framework of an approved year is locked' USING ERRCODE = '42501'; END IF;
    IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.year_start <> OLD.year_start THEN
      RAISE EXCEPTION 'a financial year belongs to one company and starts on one date' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM company_reporting_framework f WHERE f.company_id = NEW.company_id AND f.organisation_id = NEW.organisation_id AND f.id <> NEW.id
             AND daterange(f.year_start, f.year_end, '[]') && daterange(NEW.year_start, NEW.year_end, '[]')) THEN
    RAISE EXCEPTION 'financial years of a company do not overlap' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crf_guard_trg BEFORE INSERT OR UPDATE ON company_reporting_framework FOR EACH ROW EXECUTE FUNCTION crf_guard();
CREATE TRIGGER crf_no_delete BEFORE DELETE ON company_reporting_framework FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reporting_standard','reporting_standard_version','statutory_line','statutory_map_entry','validation_rule','disclosure_rule','statutory_account_override','company_reporting_framework']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "reporting_standard" FROM uk_app;

-- ───────── Permissions (DEC-052): authoring rules, verifying them (the firm grants this to its named accountant), preparing accounts ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['accounts:rules-manage','accounts:rule-verify','accounts:prepare']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin');
UPDATE "role" SET permissions = permissions || ARRAY['accounts:rules-manage','accounts:prepare']::text[] WHERE organisation_id IS NULL AND key = 'partner';
UPDATE "role" SET permissions = permissions || ARRAY['accounts:prepare']::text[] WHERE organisation_id IS NULL AND key = 'accountant';
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
  ('TABLE', 'reporting_standard', 'ACCOUNTING_RECORDS'), ('TABLE', 'reporting_standard_version', 'ACCOUNTING_RECORDS'), ('TABLE', 'statutory_line', 'ACCOUNTING_RECORDS'),
  ('TABLE', 'statutory_map_entry', 'ACCOUNTING_RECORDS'), ('TABLE', 'validation_rule', 'ACCOUNTING_RECORDS'), ('TABLE', 'disclosure_rule', 'ACCOUNTING_RECORDS'),
  ('TABLE', 'statutory_account_override', 'ACCOUNTING_RECORDS'), ('TABLE', 'company_reporting_framework', 'ACCOUNTING_RECORDS');
