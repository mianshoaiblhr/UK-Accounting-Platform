-- V2 / milestone V2-M5a: the accounts document (DEC-063). Additive. Disclosure rules (V2-M1 version content, verified with the version) gain a
-- section, an order, a body template and an omit-when-empty flag; the preparer's facts for a framework year are versioned rows.

ALTER TABLE "disclosure_rule" ADD COLUMN "section" TEXT NOT NULL DEFAULT 'NOTES';
ALTER TABLE "disclosure_rule" ADD COLUMN "sort" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "disclosure_rule" ADD COLUMN "body" TEXT;
ALTER TABLE "disclosure_rule" ADD COLUMN "omit_when_empty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "disclosure_rule" ADD CONSTRAINT disclosure_rule_section_ck CHECK (section IN ('POLICIES','NOTES','DIRECTORS_REPORT','BALANCE_SHEET_STATEMENTS'));
ALTER TABLE "disclosure_rule" ADD CONSTRAINT disclosure_rule_body_ck CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 20000);

-- ───────── The preparer's facts for a framework year ─────────
CREATE TABLE "accounts_fact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "set_by_user_id" UUID NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "accounts_fact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT af_key_ck CHECK (key IN ('employees.average','employees.averagePrior','approval.date','approval.director') OR key ~ '^text\.[a-zA-Z][a-zA-Z0-9]{0,39}$'),
    CONSTRAINT af_value_ck CHECK (char_length(value) BETWEEN 1 AND 5000),
    CONSTRAINT af_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE INDEX "af_framework_idx" ON "accounts_fact"("organisation_id", "framework_id", "key", "set_at");
ALTER TABLE "accounts_fact" ADD CONSTRAINT "af_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounts_fact" ADD CONSTRAINT "af_framework_fkey" FOREIGN KEY ("framework_id") REFERENCES "company_reporting_framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounts_fact" ADD CONSTRAINT "af_set_by_fkey" FOREIGN KEY ("set_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
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
  RETURN NEW;
END $$;
CREATE TRIGGER af_guard_trg BEFORE INSERT ON accounts_fact FOR EACH ROW EXECUTE FUNCTION af_guard();

-- ───────── Row-level security (forced) and least privilege: facts are written once ─────────
ALTER TABLE "accounts_fact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts_fact" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "accounts_fact" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE UPDATE, DELETE, TRUNCATE ON "accounts_fact" FROM uk_app;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'accounts_fact', 'ACCOUNTING_RECORDS');
