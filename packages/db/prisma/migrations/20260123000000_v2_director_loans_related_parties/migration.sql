-- V2 / milestone V2-M4: director and shareholder loan accounts, related parties (DEC-062). Additive. Registers over the ledger only: nothing here
-- writes a journal. Facts are immutable; status moves once; nothing is deleted.

-- ───────── Loan accounts of directors and shareholders ─────────
CREATE TABLE "director_loan_account" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "opened_on" DATE NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "closed_on" DATE,
    "closed_reason" TEXT,
    "closed_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "director_loan_account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT dla_kind_ck CHECK (kind IN ('DIRECTOR','SHAREHOLDER','DIRECTOR_AND_SHAREHOLDER')),
    CONSTRAINT dla_status_ck CHECK (status IN ('ACTIVE','CLOSED') AND (status = 'CLOSED') = (closed_on IS NOT NULL) AND (status = 'CLOSED') = (closed_reason IS NOT NULL)
      AND (status = 'CLOSED') = (closed_by_user_id IS NOT NULL) AND (closed_on IS NULL OR closed_on >= opened_on)),
    CONSTRAINT dla_notes_ck CHECK (notes IS NULL OR char_length(notes) <= 2000)
);
CREATE UNIQUE INDEX "dla_organisation_id_id_key" ON "director_loan_account"("organisation_id", "id");
CREATE UNIQUE INDEX "dla_live_account_key" ON "director_loan_account"("organisation_id", "account_id") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX "dla_live_person_key" ON "director_loan_account"("organisation_id", "company_id", "contact_id") WHERE status = 'ACTIVE';
ALTER TABLE "director_loan_account" ADD CONSTRAINT "dla_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "director_loan_account" ADD CONSTRAINT "dla_contact_fkey" FOREIGN KEY ("organisation_id", "contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "director_loan_account" ADD CONSTRAINT "dla_account_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "director_loan_account" ADD CONSTRAINT "dla_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "director_loan_account" ADD CONSTRAINT "dla_closed_by_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION dla_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'a new loan account is ACTIVE' USING ERRCODE = '23514'; END IF;
    SELECT type::text AS type, subtype, is_control INTO a FROM account WHERE id = NEW.account_id AND organisation_id = NEW.organisation_id AND company_id = NEW.company_id;
    IF NOT FOUND OR a.is_control OR a.type NOT IN ('ASSET','LIABILITY') OR a.subtype IN ('CURRENT_ASSET_BANK','CURRENT_ASSET_CASH') THEN
      RAISE EXCEPTION 'a loan account sits on a non-control asset or liability account of the company that is not bank or cash' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind IN ('DIRECTOR','DIRECTOR_AND_SHAREHOLDER') AND NOT EXISTS (
        SELECT 1 FROM company_officer o WHERE o.organisation_id = NEW.organisation_id AND o.company_id = NEW.company_id AND o.contact_id = NEW.contact_id AND o.role = 'DIRECTOR') THEN
      RAISE EXCEPTION 'a director''s loan account needs a DIRECTOR appointment of that person in the company' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'CLOSED' OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.contact_id <> OLD.contact_id
     OR NEW.kind <> OLD.kind OR NEW.account_id <> OLD.account_id OR NEW.opened_on <> OLD.opened_on OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a loan account is closed once, never edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dla_guard_trg BEFORE INSERT OR UPDATE ON director_loan_account FOR EACH ROW EXECUTE FUNCTION dla_guard();

-- ───────── The firm's review thresholds (versioned rows; the latest applies) ─────────
CREATE TABLE "director_loan_threshold" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "large_movement" DECIMAL(19,4),
    "overdrawn" DECIMAL(19,4),
    "reason" TEXT NOT NULL,
    "set_by_user_id" UUID NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "director_loan_threshold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT dlt_amounts_ck CHECK ((large_movement IS NULL OR large_movement > 0) AND (overdrawn IS NULL OR overdrawn > 0)),
    CONSTRAINT dlt_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE INDEX "dlt_company_idx" ON "director_loan_threshold"("organisation_id", "company_id", "set_at");
ALTER TABLE "director_loan_threshold" ADD CONSTRAINT "dlt_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "director_loan_threshold" ADD CONSTRAINT "dlt_set_by_fkey" FOREIGN KEY ("set_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Related parties ─────────
CREATE TABLE "related_party" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ended_reason" TEXT,
    "ended_by_user_id" UUID,
    "ended_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "related_party_pkey" PRIMARY KEY ("id"),
    CONSTRAINT rp_relationship_ck CHECK (relationship IN ('DIRECTOR','CLOSE_FAMILY_OF_DIRECTOR','SHAREHOLDER','ENTITY_CONTROLLED_BY_DIRECTOR','KEY_MANAGEMENT','PARENT','SUBSIDIARY',
      'FELLOW_SUBSIDIARY','ASSOCIATE','JOINT_VENTURE','OTHER')),
    CONSTRAINT rp_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
    CONSTRAINT rp_status_ck CHECK (status IN ('ACTIVE','ENDED') AND (status = 'ENDED') = (to_date IS NOT NULL) AND (status = 'ENDED') = (ended_reason IS NOT NULL)
      AND (status = 'ENDED') = (ended_by_user_id IS NOT NULL) AND (status = 'ENDED') = (ended_at IS NOT NULL) AND (to_date IS NULL OR to_date >= from_date))
);
CREATE UNIQUE INDEX "rp_organisation_id_id_key" ON "related_party"("organisation_id", "id");
CREATE UNIQUE INDEX "rp_live_key" ON "related_party"("organisation_id", "company_id", "contact_id", "relationship") WHERE status = 'ACTIVE';
ALTER TABLE "related_party" ADD CONSTRAINT "rp_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "related_party" ADD CONSTRAINT "rp_contact_fkey" FOREIGN KEY ("organisation_id", "contact_id") REFERENCES "contact"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "related_party" ADD CONSTRAINT "rp_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "related_party" ADD CONSTRAINT "rp_ended_by_fkey" FOREIGN KEY ("ended_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE OR REPLACE FUNCTION rp_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'a new related party is ACTIVE' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'ENDED' OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.contact_id <> OLD.contact_id
     OR NEW.relationship <> OLD.relationship OR NEW.description <> OLD.description OR NEW.from_date <> OLD.from_date
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a related party is ended once, never edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rp_guard_trg BEFORE INSERT OR UPDATE ON related_party FOR EACH ROW EXECUTE FUNCTION rp_guard();

-- ───────── Row-level security (forced) and least privilege ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['director_loan_account','director_loan_threshold','related_party']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;
REVOKE UPDATE ON "director_loan_threshold" FROM uk_app;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES
  ('TABLE', 'director_loan_account', 'ACCOUNTING_RECORDS'), ('TABLE', 'director_loan_threshold', 'ACCOUNTING_RECORDS'), ('TABLE', 'related_party', 'ACCOUNTING_RECORDS');
