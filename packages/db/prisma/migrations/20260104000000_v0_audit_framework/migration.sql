-- V0 Tranche A: audit framework completion (specification section 8): before/after, reason, source workflow, plus a company
-- dimension so the audit trail can be filtered by the reader's per-company access. Additive only.
-- audit_event is append-only (triggers + revoked UPDATE/DELETE): historical rows keep NULL for the new columns.

ALTER TABLE audit_event ADD COLUMN "company_id" UUID;
ALTER TABLE audit_event ADD COLUMN "before" JSONB;
ALTER TABLE audit_event ADD COLUMN "after" JSONB;
ALTER TABLE audit_event ADD COLUMN "reason" TEXT;
ALTER TABLE audit_event ADD COLUMN "source_workflow_id" UUID;

ALTER TABLE audit_event ADD CONSTRAINT audit_event_snapshot_size_ck
  CHECK ((before IS NULL OR pg_column_size(before) <= 32768) AND (after IS NULL OR pg_column_size(after) <= 32768));
ALTER TABLE audit_event ADD CONSTRAINT audit_event_reason_len_ck CHECK (reason IS NULL OR char_length(reason) <= 1000);

CREATE INDEX "audit_event_organisation_id_company_id_occurred_at_idx" ON audit_event("organisation_id", "company_id", "occurred_at" DESC);
CREATE INDEX "audit_event_organisation_id_entity_type_entity_id_idx" ON audit_event("organisation_id", "entity_type", "entity_id");

-- An event may only name a company of its own organisation (no foreign key on purpose: the audit trail must outlive its subjects).
CREATE OR REPLACE FUNCTION audit_company_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id IS NOT NULL AND (NEW.organisation_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM company c WHERE c.id = NEW.company_id AND c.organisation_id = NEW.organisation_id)) THEN
    RAISE EXCEPTION 'audit event company does not belong to the event organisation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_company_same_org_trg BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION audit_company_same_org();
