-- V0 architecture change set (D2/D3): reusable workflow foundation fields and the AI proposal state model.
-- destructive-approved: ADR-24 backup-required   (AiProposalStatus enum swap with explicit value mapping, one transaction)

-- ───────── Workflow: assignee / reassignment, retry attempts, evidence ─────────
ALTER TABLE workflow_instance ADD COLUMN "assignee_user_id" UUID;
ALTER TABLE workflow_instance ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflow_transition ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflow_transition ADD COLUMN "evidence_document_ids" UUID[] NOT NULL DEFAULT ARRAY[]::uuid[];
CREATE INDEX "workflow_instance_organisation_id_assignee_user_id_idx" ON workflow_instance("organisation_id", "assignee_user_id");

-- No silent transitions: a workflow instance's state can only change in the same transaction that records the transition
-- (actor, timestamp, comment, evidence) in the append-only history - even if application code is wrong or bypassed.
CREATE OR REPLACE FUNCTION workflow_state_requires_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT EXISTS (
    SELECT 1 FROM workflow_transition t
     WHERE t.instance_id = NEW.id AND t.to_state = NEW.state AND t.from_state IS NOT DISTINCT FROM OLD.state
       AND t.xmin::text = (txid_current() % 4294967296)::text
  ) THEN
    RAISE EXCEPTION 'workflow state change requires a recorded transition in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_state_guard_trg BEFORE UPDATE OF state ON workflow_instance
  FOR EACH ROW EXECUTE FUNCTION workflow_state_requires_transition();

-- ───────── AI proposals: SUGGESTED → UNDER_REVIEW → ACCEPTED | REJECTED, plus provenance ─────────
CREATE TYPE "AiProposalStatus_new" AS ENUM ('SUGGESTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED');
ALTER TABLE ai_proposal ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE ai_proposal ALTER COLUMN "status" TYPE "AiProposalStatus_new" USING (
  CASE "status"::text WHEN 'PENDING_REVIEW' THEN 'SUGGESTED' WHEN 'APPROVED' THEN 'ACCEPTED' ELSE 'REJECTED' END
)::"AiProposalStatus_new";
ALTER TABLE ai_proposal ALTER COLUMN "status" SET DEFAULT 'SUGGESTED';
DROP TYPE "AiProposalStatus";
ALTER TYPE "AiProposalStatus_new" RENAME TO "AiProposalStatus";

ALTER TABLE ai_proposal ADD COLUMN "provider" TEXT;
ALTER TABLE ai_proposal ADD COLUMN "model" TEXT;
ALTER TABLE ai_proposal ADD COLUMN "prompt_version" TEXT;
ALTER TABLE ai_proposal ADD COLUMN "confidence" DECIMAL(5,4);
ALTER TABLE ai_proposal ADD COLUMN "source_evidence" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE ai_proposal ADD COLUMN "review_started_by_user_id" UUID;
ALTER TABLE ai_proposal ADD COLUMN "review_started_at" TIMESTAMPTZ(3);
ALTER TABLE ai_proposal ADD COLUMN "applied_at" TIMESTAMPTZ(3);
ALTER TABLE ai_proposal ADD COLUMN "applied_by_user_id" UUID;
ALTER TABLE ai_proposal ADD COLUMN "applied_reference" TEXT;
ALTER TABLE ai_proposal ADD CONSTRAINT ai_proposal_confidence_ck CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
-- "Applied" is only meaningful for an ACCEPTED proposal, and only a human actor can apply it.
ALTER TABLE ai_proposal ADD CONSTRAINT ai_proposal_applied_ck CHECK (
  applied_at IS NULL OR ("status" = 'ACCEPTED' AND applied_by_user_id IS NOT NULL));

-- Backfill provenance for proposals created before this change from their AI run.
ALTER TABLE ai_proposal NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_run NO FORCE ROW LEVEL SECURITY;
UPDATE ai_proposal p SET provider = r.provider, model = r.model FROM ai_run r WHERE r.id = p.ai_run_id;
ALTER TABLE ai_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_run FORCE ROW LEVEL SECURITY;
