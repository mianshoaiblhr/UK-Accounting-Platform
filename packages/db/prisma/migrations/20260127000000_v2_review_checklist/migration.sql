-- V2 / milestone V2-M6a: review flags and the review checklist (DEC-068). Additive. Flags are computed; what is stored is the firm's review
-- settings (versioned, never legal values) and the responses to each flag, written once: explained by a preparer, signed off by a second
-- person holding the new accounts:review permission, or reopened.

CREATE TABLE "review_setting" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "unexplained_amount" DECIMAL(19,4),
    "material_amount" DECIMAL(19,4),
    "material_percent" DECIMAL(7,2),
    "old_item_days" INTEGER,
    "evidence_amount" DECIMAL(19,4),
    "reason" TEXT NOT NULL,
    "set_by_user_id" UUID NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_setting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT rs_amounts_ck CHECK ((unexplained_amount IS NULL OR unexplained_amount > 0) AND (material_amount IS NULL OR material_amount > 0)
      AND (evidence_amount IS NULL OR evidence_amount > 0) AND (material_percent IS NULL OR (material_percent >= 0 AND material_percent <= 10000))),
    CONSTRAINT rs_days_ck CHECK (old_item_days IS NULL OR old_item_days IN (30, 60, 90)),
    CONSTRAINT rs_reason_ck CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE INDEX "rs_company_idx" ON "review_setting"("organisation_id", "company_id", "set_at");
ALTER TABLE "review_setting" ADD CONSTRAINT "rs_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_setting" ADD CONSTRAINT "rs_set_by_fkey" FOREIGN KEY ("set_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "review_flag_response" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "flag_key" TEXT NOT NULL,
    "control" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "figures" JSONB NOT NULL,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "review_flag_response_pkey" PRIMARY KEY ("id"),
    CONSTRAINT rfr_control_ck CHECK (control IN ('RC-01','RC-02','RC-03','RC-04','RC-05','RC-06','RC-07','RC-08','RC-09')),
    CONSTRAINT rfr_key_ck CHECK (flag_key ~ '^RC-0[1-9]:[a-z_]+:[A-Za-z0-9_.:-]{1,200}$' AND left(flag_key, 5) = control),
    CONSTRAINT rfr_action_ck CHECK (action IN ('EXPLAIN','SIGN_OFF','REOPEN')),
    -- an explanation and a reopen say why; a sign-off may add a note
    CONSTRAINT rfr_note_ck CHECK ((note IS NULL AND action = 'SIGN_OFF') OR (note IS NOT NULL AND char_length(btrim(note)) BETWEEN 3 AND 2000)),
    CONSTRAINT rfr_figures_ck CHECK (jsonb_typeof(figures) = 'object')
);
CREATE INDEX "rfr_flag_idx" ON "review_flag_response"("organisation_id", "framework_id", "flag_key", "at");
ALTER TABLE "review_flag_response" ADD CONSTRAINT "rfr_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_flag_response" ADD CONSTRAINT "rfr_framework_fkey" FOREIGN KEY ("framework_id") REFERENCES "company_reporting_framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_flag_response" ADD CONSTRAINT "rfr_by_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A response belongs to a framework year of its company. A sign-off accepts the latest explanation of the same flag, with the same
-- figures, given by another person, and not yet signed off or reopened (the service checks the same and names the problem).
CREATE OR REPLACE FUNCTION rfr_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_explain review_flag_response%ROWTYPE; later INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM company_reporting_framework f WHERE f.id = NEW.framework_id AND f.organisation_id = NEW.organisation_id AND f.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'a review response belongs to a framework year of its company' USING ERRCODE = '23514';
  END IF;
  IF NEW.action = 'SIGN_OFF' THEN
    SELECT * INTO last_explain FROM review_flag_response r WHERE r.organisation_id = NEW.organisation_id AND r.framework_id = NEW.framework_id AND r.flag_key = NEW.flag_key AND r.action = 'EXPLAIN'
      ORDER BY r.at DESC, r.id DESC LIMIT 1;
    IF last_explain.id IS NULL THEN RAISE EXCEPTION 'a flag is signed off only after it is explained' USING ERRCODE = '23514'; END IF;
    SELECT count(*) INTO later FROM review_flag_response r WHERE r.organisation_id = NEW.organisation_id AND r.framework_id = NEW.framework_id AND r.flag_key = NEW.flag_key
      AND r.action IN ('SIGN_OFF','REOPEN') AND (r.at, r.id) > (last_explain.at, last_explain.id);
    IF later > 0 THEN RAISE EXCEPTION 'the explanation was already signed off or reopened; it needs a new explanation' USING ERRCODE = '23514'; END IF;
    IF last_explain.by_user_id = NEW.by_user_id THEN RAISE EXCEPTION 'a flag is signed off by someone other than the person who explained it' USING ERRCODE = '42501'; END IF;
    IF last_explain.figures <> NEW.figures THEN RAISE EXCEPTION 'the flag changed since it was explained; it needs a new explanation' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rfr_guard_trg BEFORE INSERT ON review_flag_response FOR EACH ROW EXECUTE FUNCTION rfr_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['review_setting','review_flag_response']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM uk_app', t);
  END LOOP;
END $$;

-- ───────── Permission (DEC-068): signing off review flags; owner, admin and partner ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['accounts:review']::text[] WHERE organisation_id IS NULL AND key IN ('owner','admin','partner');
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'review_setting', 'ACCOUNTING_RECORDS'), ('TABLE', 'review_flag_response', 'ACCOUNTING_RECORDS');
