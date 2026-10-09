-- V0 Tranche A / increment 7c: the evidence graph foundation (cross-platform §6: transaction <-> document <-> journal <-> report <-> tax return <-> filing).
-- One typed, same-company, immutable link table. Existing task attachments and workflow evidence are back-filled and, from now on, written
-- here in the same transaction as their own rows.
CREATE TABLE "evidence_link" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_user_id" UUID,
    "revoked_reason" TEXT,
    CONSTRAINT "evidence_link_pkey" PRIMARY KEY ("id"),
    -- Entity types are appended here and in @uk/contracts by later versions (journal, bank_transaction, report, tax_return, filing ...).
    CONSTRAINT evidence_link_source_type_ck CHECK (source_type IN ('document','document_version','task','workflow_instance','ai_proposal','contact','company','accounting_period')),
    CONSTRAINT evidence_link_target_type_ck CHECK (target_type IN ('document','document_version','task','workflow_instance','ai_proposal','contact','company','accounting_period')),
    CONSTRAINT evidence_link_kind_ck CHECK (kind IN ('SUPPORTS','DERIVED_FROM','ATTACHED_TO','REFERENCES','FILED_AS')),
    CONSTRAINT evidence_link_not_self_ck CHECK (NOT (source_type = target_type AND source_id = target_id)),
    CONSTRAINT evidence_link_note_ck CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    CONSTRAINT evidence_link_revocation_ck CHECK ((revoked_at IS NULL AND revoked_reason IS NULL AND revoked_by_user_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL))
);
CREATE UNIQUE INDEX "evidence_link_active_uq" ON "evidence_link"("organisation_id", "source_type", "source_id", "target_type", "target_id", "kind") WHERE revoked_at IS NULL;
CREATE INDEX "evidence_link_source_idx" ON "evidence_link"("organisation_id", "source_type", "source_id");
CREATE INDEX "evidence_link_target_idx" ON "evidence_link"("organisation_id", "target_type", "target_id");
CREATE INDEX "evidence_link_company_idx" ON "evidence_link"("organisation_id", "company_id");
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Links are never edited or deleted: the only permitted change is revocation (who, when, why), once.
CREATE OR REPLACE FUNCTION evidence_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at' - 'revoked_by_user_id' - 'revoked_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revoked_by_user_id' - 'revoked_reason') THEN
    RAISE EXCEPTION 'an evidence link is immutable; revoke it instead' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'a revoked evidence link is final' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_link_guard_trg BEFORE UPDATE ON "evidence_link" FOR EACH ROW EXECUTE FUNCTION evidence_link_guard();
CREATE TRIGGER evidence_link_no_delete BEFORE DELETE ON "evidence_link" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────── Back-fill from the existing evidence-like tables (FORCE RLS applies to the migration owner: lift it per table, ADR-27) ─────────
ALTER TABLE "task_attachment" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "task" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_transition" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_instance" NO FORCE ROW LEVEL SECURITY;
INSERT INTO "evidence_link"(organisation_id, company_id, source_type, source_id, target_type, target_id, kind, created_by_user_id, created_at)
  SELECT a.organisation_id, t.company_id, 'task', a.task_id, 'document', a.document_id, 'ATTACHED_TO', a.added_by_user_id, a.created_at
    FROM "task_attachment" a JOIN "task" t ON t.organisation_id = a.organisation_id AND t.id = a.task_id
  ON CONFLICT DO NOTHING;
INSERT INTO "evidence_link"(organisation_id, company_id, source_type, source_id, target_type, target_id, kind, created_by_user_id, created_at)
  SELECT DISTINCT ON (x.organisation_id, x.instance_id, x.doc_id) x.organisation_id, i.company_id, 'workflow_instance', x.instance_id, 'document', x.doc_id, 'SUPPORTS', x.actor_user_id, x.occurred_at
    FROM (SELECT wt.organisation_id, wt.instance_id, wt.actor_user_id, wt.occurred_at, unnest(wt.evidence_document_ids) AS doc_id FROM "workflow_transition" wt) x
    JOIN "workflow_instance" i ON i.organisation_id = x.organisation_id AND i.id = x.instance_id
   ORDER BY x.organisation_id, x.instance_id, x.doc_id, x.occurred_at
  ON CONFLICT DO NOTHING;
ALTER TABLE "task_attachment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_transition" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_instance" FORCE ROW LEVEL SECURITY;

-- ───────── Row-level security (enabled after the back-fill) and least privilege ─────────
ALTER TABLE "evidence_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "evidence_link" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
REVOKE DELETE, TRUNCATE ON "evidence_link" FROM uk_app;
