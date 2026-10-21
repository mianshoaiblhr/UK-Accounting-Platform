-- V2 / milestone V2-M6b: the 14-step year-end workflow (DEC-069). Additive. Each step's status is read from existing controls; what is stored
-- is each sign-off and reopen of a step, written once with the control's status and summary at the time.

CREATE TABLE "year_end_step_signoff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "control" JSONB NOT NULL,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "year_end_step_signoff_pkey" PRIMARY KEY ("id"),
    CONSTRAINT yess_step_ck CHECK (step BETWEEN 1 AND 14),
    CONSTRAINT yess_action_ck CHECK (action IN ('SIGN_OFF','REOPEN')),
    -- a reopen says why; a sign-off may add a note
    CONSTRAINT yess_note_ck CHECK ((note IS NULL AND action = 'SIGN_OFF') OR (note IS NOT NULL AND char_length(btrim(note)) BETWEEN 3 AND 2000)),
    CONSTRAINT yess_control_ck CHECK (jsonb_typeof(control) = 'object')
);
CREATE INDEX "yess_step_idx" ON "year_end_step_signoff"("organisation_id", "framework_id", "step", "at");
ALTER TABLE "year_end_step_signoff" ADD CONSTRAINT "yess_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "year_end_step_signoff" ADD CONSTRAINT "yess_framework_fkey" FOREIGN KEY ("framework_id") REFERENCES "company_reporting_framework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_step_signoff" ADD CONSTRAINT "yess_by_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A sign-off belongs to a framework year of its company; a reopen needs a live sign-off of the same step to reopen.
CREATE OR REPLACE FUNCTION yess_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_action TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM company_reporting_framework f WHERE f.id = NEW.framework_id AND f.organisation_id = NEW.organisation_id AND f.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'a year-end step sign-off belongs to a framework year of its company' USING ERRCODE = '23514';
  END IF;
  SELECT s.action INTO last_action FROM year_end_step_signoff s WHERE s.organisation_id = NEW.organisation_id AND s.framework_id = NEW.framework_id AND s.step = NEW.step
    ORDER BY s.at DESC, s.id DESC LIMIT 1;
  IF NEW.action = 'REOPEN' AND last_action IS DISTINCT FROM 'SIGN_OFF' THEN RAISE EXCEPTION 'only a signed-off step is reopened' USING ERRCODE = '23514'; END IF;
  IF NEW.action = 'SIGN_OFF' AND last_action = 'SIGN_OFF' THEN RAISE EXCEPTION 'the step is already signed off; reopen it first' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yess_guard_trg BEFORE INSERT ON year_end_step_signoff FOR EACH ROW EXECUTE FUNCTION yess_guard();

ALTER TABLE "year_end_step_signoff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "year_end_step_signoff" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "year_end_step_signoff" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE UPDATE, DELETE, TRUNCATE ON "year_end_step_signoff" FROM uk_app;

INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'year_end_step_signoff', 'ACCOUNTING_RECORDS');
