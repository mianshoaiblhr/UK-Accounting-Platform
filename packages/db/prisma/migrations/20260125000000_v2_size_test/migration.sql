-- V2 / milestone V2-M5b: the size test (DEC-066). Additive. Company-law size thresholds become organisation data in effective-dated threshold
-- sets, created UNVERIFIED with a source and verified by a second person (DEC-052); a standard version names its turnover line; the earliest
-- framework year takes two facts about the preceding year. Nothing is seeded.

-- ───────── A standard version names its turnover line (verified with the version, frozen after) ─────────
ALTER TABLE "reporting_standard_version" ADD COLUMN "turnover_line_key" TEXT;
ALTER TABLE "reporting_standard_version" ADD CONSTRAINT rsv_turnover_line_ck CHECK (turnover_line_key IS NULL OR turnover_line_key ~ '^[A-Z0-9][A-Z0-9_.-]{0,79}$');

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
     OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes OR NEW.turnover_line_key IS DISTINCT FROM OLD.turnover_line_key) THEN
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
  END IF;
  RETURN NEW;
END $$;

-- ───────── Size threshold sets ─────────
CREATE TABLE "size_threshold_set" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "prior_year_on_first" BOOLEAN NOT NULL DEFAULT false,
    "micro_turnover" DECIMAL(19,4) NOT NULL,
    "micro_balance_sheet_total" DECIMAL(19,4) NOT NULL,
    "micro_employees" INTEGER NOT NULL,
    "small_turnover" DECIMAL(19,4) NOT NULL,
    "small_balance_sheet_total" DECIMAL(19,4) NOT NULL,
    "small_employees" INTEGER NOT NULL,
    "medium_turnover" DECIMAL(19,4) NOT NULL,
    "medium_balance_sheet_total" DECIMAL(19,4) NOT NULL,
    "medium_employees" INTEGER NOT NULL,
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
    CONSTRAINT "size_threshold_set_pkey" PRIMARY KEY ("id"),
    CONSTRAINT sts_label_ck CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
    CONSTRAINT sts_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT sts_source_ck CHECK (char_length(source_url) BETWEEN 8 AND 500 AND source_url ~ '^https?://' AND char_length(btrim(source_reference)) BETWEEN 3 AND 300),
    CONSTRAINT sts_notes_ck CHECK (notes IS NULL OR char_length(notes) <= 5000),
    -- limits are positive and nested: micro <= small <= medium for each measure
    CONSTRAINT sts_positive_ck CHECK (micro_turnover > 0 AND micro_balance_sheet_total > 0 AND micro_employees > 0),
    CONSTRAINT sts_nested_ck CHECK (micro_turnover <= small_turnover AND small_turnover <= medium_turnover
      AND micro_balance_sheet_total <= small_balance_sheet_total AND small_balance_sheet_total <= medium_balance_sheet_total
      AND micro_employees <= small_employees AND small_employees <= medium_employees),
    CONSTRAINT sts_scale_ck CHECK (medium_turnover < 1000000000000 AND medium_balance_sheet_total < 1000000000000 AND medium_employees <= 10000000),
    CONSTRAINT sts_status_ck CHECK (status IN ('UNVERIFIED','VERIFIED','SUPERSEDED')),
    CONSTRAINT sts_verification_ck CHECK (
      (verified_by_user_id IS NULL AND verified_at IS NULL AND status = 'UNVERIFIED')
      OR (status IN ('VERIFIED','SUPERSEDED') AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL AND verification_notes IS NOT NULL
          AND char_length(btrim(verification_notes)) >= 10 AND verified_by_user_id <> created_by_user_id)),
    CONSTRAINT sts_superseded_ck CHECK ((status = 'SUPERSEDED') = (superseded_by_id IS NOT NULL))
);
CREATE UNIQUE INDEX "sts_organisation_id_id_key" ON "size_threshold_set"("organisation_id", "id");
CREATE INDEX "sts_effective_idx" ON "size_threshold_set"("organisation_id", "effective_from");
ALTER TABLE "size_threshold_set" ADD CONSTRAINT "sts_organisation_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "size_threshold_set" ADD CONSTRAINT "sts_copied_from_fkey" FOREIGN KEY ("organisation_id", "copied_from_id") REFERENCES "size_threshold_set"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "size_threshold_set" ADD CONSTRAINT "sts_superseded_by_fkey" FOREIGN KEY ("organisation_id", "superseded_by_id") REFERENCES "size_threshold_set"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "size_threshold_set" ADD CONSTRAINT "sts_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "size_threshold_set" ADD CONSTRAINT "sts_verified_by_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Insert: a set starts UNVERIFIED. Update: while UNVERIFIED its fields may change; it is verified once (by another person); only a VERIFIED set
-- is superseded; a VERIFIED set never changes; a SUPERSEDED one is final. The current sets of an organisation never overlap.
CREATE OR REPLACE FUNCTION sts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'SUPERSEDED' AND EXISTS (SELECT 1 FROM size_threshold_set s WHERE s.organisation_id = NEW.organisation_id AND s.id <> NEW.id AND s.status <> 'SUPERSEDED'
       AND daterange(s.effective_from, s.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')) THEN
    RAISE EXCEPTION 'the threshold set overlaps another current threshold set; supersede it or end it first' USING ERRCODE = '23P01';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'a new threshold set starts UNVERIFIED' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at
     OR NEW.copied_from_id IS DISTINCT FROM OLD.copied_from_id THEN
    RAISE EXCEPTION 'a threshold set belongs to one organisation and one author' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'SUPERSEDED' THEN RAISE EXCEPTION 'a superseded threshold set is final' USING ERRCODE = '42501'; END IF;
  IF OLD.status = 'VERIFIED' AND (ROW(NEW.label, NEW.effective_from, NEW.effective_to, NEW.prior_year_on_first, NEW.micro_turnover, NEW.micro_balance_sheet_total, NEW.micro_employees,
       NEW.small_turnover, NEW.small_balance_sheet_total, NEW.small_employees, NEW.medium_turnover, NEW.medium_balance_sheet_total, NEW.medium_employees,
       NEW.source_url, NEW.source_reference, NEW.source_retrieved_on, NEW.notes, NEW.verified_by_user_id, NEW.verified_at, NEW.verification_notes)
     IS DISTINCT FROM ROW(OLD.label, OLD.effective_from, OLD.effective_to, OLD.prior_year_on_first, OLD.micro_turnover, OLD.micro_balance_sheet_total, OLD.micro_employees,
       OLD.small_turnover, OLD.small_balance_sheet_total, OLD.small_employees, OLD.medium_turnover, OLD.medium_balance_sheet_total, OLD.medium_employees,
       OLD.source_url, OLD.source_reference, OLD.source_retrieved_on, OLD.notes, OLD.verified_by_user_id, OLD.verified_at, OLD.verification_notes)) THEN
    RAISE EXCEPTION 'a verified threshold set is immutable; supersede it with a new set' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'UNVERIFIED' AND NEW.status = 'VERIFIED') OR (OLD.status = 'VERIFIED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'a threshold set is verified once and superseded once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sts_guard_trg BEFORE INSERT OR UPDATE ON size_threshold_set FOR EACH ROW EXECUTE FUNCTION sts_guard();
CREATE TRIGGER sts_no_delete BEFORE DELETE ON size_threshold_set FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sts_no_truncate BEFORE TRUNCATE ON size_threshold_set FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE "size_threshold_set" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "size_threshold_set" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "size_threshold_set" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE DELETE, TRUNCATE ON "size_threshold_set" FROM uk_app;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'size_threshold_set', 'ACCOUNTING_RECORDS');

-- ───────── Two facts about the year before the earliest framework year ─────────
ALTER TABLE "accounts_fact" DROP CONSTRAINT af_key_ck;
ALTER TABLE "accounts_fact" ADD CONSTRAINT af_key_ck CHECK (key IN ('employees.average','employees.averagePrior','approval.date','approval.director','size.priorMet','size.priorStatus')
  OR key ~ '^text\.[a-zA-Z][a-zA-Z0-9]{0,39}$');
CREATE OR REPLACE FUNCTION af_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM company_reporting_framework f WHERE f.id = NEW.framework_id AND f.organisation_id = NEW.organisation_id AND f.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'a fact belongs to a framework year of its company' USING ERRCODE = '23514';
  END IF;
  -- typed values (the service checks them first and names the problem)
  IF NEW.key IN ('employees.average','employees.averagePrior') AND NEW.value !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'an average number of employees is a whole number' USING ERRCODE = '23514'; END IF;
  IF NEW.key = 'approval.date' AND NEW.value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'an approval date is YYYY-MM-DD' USING ERRCODE = '23514'; END IF;
  IF NEW.key = 'approval.director' AND NOT EXISTS (SELECT 1 FROM company_officer o WHERE o.organisation_id = NEW.organisation_id AND o.company_id = NEW.company_id AND o.role = 'DIRECTOR' AND o.contact_id::text = NEW.value) THEN
    RAISE EXCEPTION 'the approving director is a director of the company' USING ERRCODE = '23514';
  END IF;
  IF NEW.key = 'size.priorMet' AND NEW.value NOT IN ('MICRO','SMALL','MEDIUM','LARGE') THEN RAISE EXCEPTION 'size.priorMet is MICRO, SMALL, MEDIUM or LARGE' USING ERRCODE = '23514'; END IF;
  IF NEW.key = 'size.priorStatus' AND NEW.value NOT IN ('MICRO','SMALL','MEDIUM','LARGE','FIRST_YEAR') THEN RAISE EXCEPTION 'size.priorStatus is MICRO, SMALL, MEDIUM, LARGE or FIRST_YEAR' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
