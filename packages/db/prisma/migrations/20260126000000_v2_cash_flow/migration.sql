-- V2 / milestone V2-M5c: the cash flow statement (DEC-067). Additive. Version content, verified with the version and frozen after (DEC-052):
-- cash-flow classes and a map from V1 reporting lines to them or to cash; the sizes whose accounts include the statement and its captions.
-- Nothing is seeded.

ALTER TABLE "reporting_standard_version" ADD COLUMN "cash_flow_applies_to" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "reporting_standard_version" ADD COLUMN "cash_flow_captions" JSONB;
ALTER TABLE "reporting_standard_version" ADD CONSTRAINT rsv_cash_flow_sizes_ck CHECK (cash_flow_applies_to <@ ARRAY['MICRO','SMALL','MEDIUM','LARGE']::text[]);
ALTER TABLE "reporting_standard_version" ADD CONSTRAINT rsv_cash_flow_captions_ck CHECK (cash_flow_captions IS NULL OR (jsonb_typeof(cash_flow_captions) = 'object'
  AND cash_flow_captions ?& ARRAY['profit','operating','investing','financing','netChange','opening','closing']));

CREATE TABLE "cash_flow_class" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "adjustment_name" TEXT,
    "inflow_name" TEXT,
    "outflow_name" TEXT,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_flow_class_pkey" PRIMARY KEY ("id"),
    CONSTRAINT cfc_key_ck CHECK (key ~ '^[A-Z0-9][A-Z0-9_.-]{0,79}$' AND key <> 'CASH'),
    CONSTRAINT cfc_section_ck CHECK (section IN ('OPERATING','INVESTING','FINANCING')),
    CONSTRAINT cfc_names_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 300 AND (adjustment_name IS NULL OR char_length(btrim(adjustment_name)) BETWEEN 1 AND 300)
      AND (inflow_name IS NULL OR char_length(btrim(inflow_name)) BETWEEN 1 AND 300) AND (outflow_name IS NULL OR char_length(btrim(outflow_name)) BETWEEN 1 AND 300)),
    -- investing and financing classes caption their non-cash part; only they may be shown gross, with both captions
    CONSTRAINT cfc_shape_ck CHECK ((section = 'OPERATING' AND adjustment_name IS NULL AND inflow_name IS NULL AND outflow_name IS NULL)
      OR (section <> 'OPERATING' AND adjustment_name IS NOT NULL AND (inflow_name IS NULL) = (outflow_name IS NULL)))
);
CREATE UNIQUE INDEX "cash_flow_class_organisation_id_id_key" ON "cash_flow_class"("organisation_id", "id");
CREATE UNIQUE INDEX "cash_flow_class_version_key_key" ON "cash_flow_class"("organisation_id", "version_id", "key") WHERE NOT removed;
ALTER TABLE "cash_flow_class" ADD CONSTRAINT "cash_flow_class_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cash_flow_map_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "source_line" TEXT NOT NULL,
    "account_subtype" TEXT,
    "target" TEXT NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_flow_map_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT cfm_source_ck CHECK (source_line ~ '^(PL|BS)\.[A-Z0-9_.]{1,80}$'),
    CONSTRAINT cfm_target_ck CHECK (target ~ '^[A-Z0-9][A-Z0-9_.-]{0,79}$'),
    -- only balance-sheet cash is cash
    CONSTRAINT cfm_cash_ck CHECK (target <> 'CASH' OR source_line LIKE 'BS.%')
);
CREATE UNIQUE INDEX "cash_flow_map_entry_organisation_id_id_key" ON "cash_flow_map_entry"("organisation_id", "id");
CREATE UNIQUE INDEX "cash_flow_map_entry_unique" ON "cash_flow_map_entry"("organisation_id", "version_id", "source_line", (coalesce(account_subtype, ''))) WHERE NOT removed;
ALTER TABLE "cash_flow_map_entry" ADD CONSTRAINT "cash_flow_map_entry_version_fkey" FOREIGN KEY ("organisation_id", "version_id") REFERENCES "reporting_standard_version"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- the content changes only while its version is UNVERIFIED (the V2-M1 guard); never deleted (removed by a flag)
CREATE TRIGGER cash_flow_class_guard_trg BEFORE INSERT OR UPDATE ON cash_flow_class FOR EACH ROW EXECUTE FUNCTION rsv_content_guard();
CREATE TRIGGER cash_flow_map_entry_guard_trg BEFORE INSERT OR UPDATE ON cash_flow_map_entry FOR EACH ROW EXECUTE FUNCTION rsv_content_guard();
CREATE TRIGGER cash_flow_class_no_delete BEFORE DELETE ON cash_flow_class FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER cash_flow_map_entry_no_delete BEFORE DELETE ON cash_flow_map_entry FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- the version guard: the two new columns are frozen once verified, and checked when verified
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
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes OR NEW.turnover_line_key IS DISTINCT FROM OLD.turnover_line_key
     OR NEW.cash_flow_applies_to IS DISTINCT FROM OLD.cash_flow_applies_to OR NEW.cash_flow_captions IS DISTINCT FROM OLD.cash_flow_captions) THEN
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
    -- V2-M5b: the turnover line, when named, is a profit and loss line of the version
    IF NEW.turnover_line_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM statutory_line l WHERE l.version_id = NEW.id AND l.organisation_id = NEW.organisation_id
               AND l.key = NEW.turnover_line_key AND NOT l.removed AND l.statement = 'PL') THEN
      RAISE EXCEPTION 'the turnover line is not a profit and loss line of this version' USING ERRCODE = '23514';
    END IF;
    -- V2-M5c: a version whose accounts include a cash flow statement has its captions, a map to cash, and maps only to its classes or to cash
    IF cardinality(NEW.cash_flow_applies_to) > 0 AND (NEW.cash_flow_captions IS NULL
       OR NOT EXISTS (SELECT 1 FROM cash_flow_map_entry m WHERE m.version_id = NEW.id AND m.organisation_id = NEW.organisation_id AND NOT m.removed AND m.target = 'CASH')) THEN
      RAISE EXCEPTION 'a version with a cash flow statement needs its captions and a map entry to CASH' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM cash_flow_map_entry m WHERE m.version_id = NEW.id AND m.organisation_id = NEW.organisation_id AND NOT m.removed AND m.target <> 'CASH'
               AND NOT EXISTS (SELECT 1 FROM cash_flow_class c WHERE c.version_id = NEW.id AND c.organisation_id = NEW.organisation_id AND c.key = m.target AND NOT c.removed)) THEN
      RAISE EXCEPTION 'a cash-flow map entry points at a class that is not in this version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_flow_class','cash_flow_map_entry']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'cash_flow_class', 'ACCOUNTING_RECORDS'), ('TABLE', 'cash_flow_map_entry', 'ACCOUNTING_RECORDS');
