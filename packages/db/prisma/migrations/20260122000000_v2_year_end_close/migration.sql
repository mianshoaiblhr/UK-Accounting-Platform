-- V2 / milestone V2-M3b: the year-end closing journal (DEC-060). Additive. One live close per financial year moves the year's income and expense
-- balances to retained earnings; while it is live no income or expense line is posted into the year (the PostingService refuses it first).

CREATE TABLE "year_end_close" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "year_start" DATE NOT NULL,
    "year_end" DATE NOT NULL,
    "retained_earnings_account_id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "profit" DECIMAL(19,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "reversal_journal_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_reason" TEXT,
    CONSTRAINT "year_end_close_pkey" PRIMARY KEY ("id"),
    -- a financial year is at most 18 months (Companies Act 2006 s.390-392)
    CONSTRAINT yec_year_ck CHECK (year_start <= year_end AND year_end < (year_start + interval '18 months')::date),
    CONSTRAINT yec_status_ck CHECK (status IN ('POSTED','REVERSED') AND (status = 'REVERSED') = (reversal_journal_id IS NOT NULL) AND (status = 'REVERSED') = (reversed_at IS NOT NULL)
      AND (status = 'REVERSED') = (reversed_reason IS NOT NULL) AND (status = 'REVERSED') = (reversed_by_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX "yec_organisation_id_id_key" ON "year_end_close"("organisation_id", "id");
CREATE INDEX "yec_company_idx" ON "year_end_close"("organisation_id", "company_id", "status", "year_start");
ALTER TABLE "year_end_close" ADD CONSTRAINT "yec_company_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "year_end_close" ADD CONSTRAINT "yec_account_fkey" FOREIGN KEY ("retained_earnings_account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_close" ADD CONSTRAINT "yec_journal_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_close" ADD CONSTRAINT "yec_reversal_fkey" FOREIGN KEY ("reversal_journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_close" ADD CONSTRAINT "yec_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "year_end_close" ADD CONSTRAINT "yec_reversed_by_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION yec_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'POSTED' THEN RAISE EXCEPTION 'a new year-end close is POSTED' USING ERRCODE = '23514'; END IF;
    -- the same lock the close service and every posting take: two closes of one company never pass this check together
    PERFORM pg_advisory_xact_lock(hashtextextended('yearclose:' || NEW.company_id::text, 0));
    IF EXISTS (SELECT 1 FROM year_end_close c WHERE c.company_id = NEW.company_id AND c.organisation_id = NEW.organisation_id AND c.status = 'POSTED'
                AND c.year_start <= NEW.year_end AND NEW.year_start <= c.year_end) THEN
      RAISE EXCEPTION 'the financial year % to % overlaps a live year-end close', NEW.year_start, NEW.year_end USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM account a WHERE a.id = NEW.retained_earnings_account_id AND a.organisation_id = NEW.organisation_id AND a.company_id = NEW.company_id
                    AND a.control_kind = 'RETAINED_EARNINGS') THEN
      RAISE EXCEPTION 'a year is closed to the company''s retained-earnings account' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'REVERSED' OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.company_id <> OLD.company_id OR NEW.year_start <> OLD.year_start
     OR NEW.year_end <> OLD.year_end OR NEW.retained_earnings_account_id <> OLD.retained_earnings_account_id OR NEW.journal_id <> OLD.journal_id OR NEW.profit <> OLD.profit
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a year-end close is reversed by its mirror, never edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yec_guard_trg BEFORE INSERT OR UPDATE ON year_end_close FOR EACH ROW EXECUTE FUNCTION yec_guard();

-- ───────── A closed year takes no income or expense (the second line of defence; the PostingService refuses first) ─────────
CREATE OR REPLACE FUNCTION closed_year_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t text; jd date; st text; c record;
BEGIN
  SELECT a.type::text INTO t FROM account a WHERE a.id = NEW.account_id AND a.organisation_id = NEW.organisation_id;
  IF t IS NULL OR t NOT IN ('INCOME','EXPENSE') THEN RETURN NEW; END IF;
  SELECT j.journal_date, j.source_type INTO jd, st FROM journal j WHERE j.id = NEW.journal_id AND j.organisation_id = NEW.organisation_id;
  IF st IN ('YEAR_END_CLOSE','YEAR_END_CLOSE_REVERSAL') THEN RETURN NEW; END IF;
  SELECT year_start, year_end INTO c FROM year_end_close y WHERE y.organisation_id = NEW.organisation_id AND y.company_id = NEW.company_id AND y.status = 'POSTED'
     AND jd BETWEEN y.year_start AND y.year_end LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'the financial year % to % is closed: income and expense are not posted into it until its closing journal is reversed', c.year_start, c.year_end USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER closed_year_guard_trg BEFORE INSERT ON journal_line FOR EACH ROW EXECUTE FUNCTION closed_year_guard();

-- ───────── Row-level security (forced) and least privilege ─────────
ALTER TABLE "year_end_close" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "year_end_close" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "year_end_close" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE DELETE, TRUNCATE ON "year_end_close" FROM uk_app;

-- ───────── Retention classification (ADR-39; classification only) ─────────
INSERT INTO "retention_rule"(subject_kind, subject, category_code) VALUES ('TABLE', 'year_end_close', 'ACCOUNTING_RECORDS');
