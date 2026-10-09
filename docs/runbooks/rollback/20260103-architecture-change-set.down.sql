-- ROLLBACK of migrations 20260103000000_v0_practice_and_company_roles and 20260103000100_v0_workflow_and_ai_states.
-- NOT a Prisma migration and never run automatically. Prisma has no down-migrations by design (docs/runbooks/migrations.md §4);
-- this script exists so the change set is reversible *in practice* if it must be backed out before data that depends on the new model exists.
--
-- Use only after: (1) the previous application release is stopped, (2) a snapshot was taken, (3) the pre-conditions below pass.
-- Run as the migrator/owner role in ONE transaction:   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f <this file>
-- Afterwards delete the two rows from _prisma_migrations (names above) so a later `migrate deploy` re-applies them.
--
-- DATA LOST by design (does not exist in the old model): practices and their memberships, per-company roles that differ from the
-- member's organisation role, platform roles, workflow assignee/attempt/evidence, AI provenance. AI proposal states are mapped back.

-- Pre-conditions: refuse to proceed if the new roles are in use (the operator must re-assign people first).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM organisation_membership m JOIN "role" r ON r.id = m.role_id WHERE r.key IN ('partner','manager'))
     OR EXISTS (SELECT 1 FROM company_membership cm JOIN "role" r ON r.id = cm.role_id WHERE r.key IN ('partner','manager'))
     OR EXISTS (SELECT 1 FROM practice_membership) THEN
    RAISE EXCEPTION 'rollback refused: partner/manager roles or practice memberships are in use - re-assign them first';
  END IF;
  IF EXISTS (SELECT 1 FROM "role" WHERE organisation_id IS NOT NULL AND permissions && ARRAY['practice:read','practice:manage','practice:member:manage','company:access:manage','workflow:review','workflow:approve']) THEN
    RAISE EXCEPTION 'rollback refused: custom roles use the new permissions - remove them first';
  END IF;
END $$;

-- Row-level security is FORCED for owners; lift it for the tables touched below (restored at the end of this transaction).
ALTER TABLE ai_proposal NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation NO FORCE ROW LEVEL SECURITY;
ALTER TABLE company NO FORCE ROW LEVEL SECURITY;

-- ───────── 20260103000100: workflow + AI ─────────
DROP TRIGGER workflow_state_guard_trg ON workflow_instance;
DROP FUNCTION workflow_state_requires_transition();
DROP INDEX "workflow_instance_organisation_id_assignee_user_id_idx";
ALTER TABLE workflow_instance DROP COLUMN "assignee_user_id", DROP COLUMN "attempt";
-- workflow_transition is append-only: ALTER TABLE ... DROP COLUMN is DDL and not blocked by the row triggers.
ALTER TABLE workflow_transition DROP COLUMN "attempt", DROP COLUMN "evidence_document_ids";

ALTER TABLE ai_proposal DROP CONSTRAINT ai_proposal_applied_ck, DROP CONSTRAINT ai_proposal_confidence_ck;
ALTER TABLE ai_proposal DROP COLUMN "provider", DROP COLUMN "model", DROP COLUMN "prompt_version", DROP COLUMN "confidence", DROP COLUMN "source_evidence",
  DROP COLUMN "review_started_by_user_id", DROP COLUMN "review_started_at", DROP COLUMN "applied_at", DROP COLUMN "applied_by_user_id", DROP COLUMN "applied_reference";
CREATE TYPE "AiProposalStatus_old" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');
ALTER TABLE ai_proposal ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE ai_proposal ALTER COLUMN "status" TYPE "AiProposalStatus_old" USING (
  CASE "status"::text WHEN 'SUGGESTED' THEN 'PENDING_REVIEW' WHEN 'UNDER_REVIEW' THEN 'PENDING_REVIEW' WHEN 'ACCEPTED' THEN 'APPROVED' ELSE 'REJECTED' END
)::"AiProposalStatus_old";
ALTER TABLE ai_proposal ALTER COLUMN "status" SET DEFAULT 'PENDING_REVIEW';
DROP TYPE "AiProposalStatus";
ALTER TYPE "AiProposalStatus_old" RENAME TO "AiProposalStatus";

-- ───────── 20260103000000: practice / company roles ─────────
DROP TRIGGER company_practice_rule_trg ON company;
DROP TRIGGER practice_org_rule_trg ON practice;
DROP TRIGGER organisation_type_immutable_trg ON organisation;
DROP TRIGGER practice_membership_role_scope_trg ON practice_membership;
DROP TRIGGER company_membership_role_scope_trg ON company_membership;
DROP FUNCTION company_practice_rule();
DROP FUNCTION practice_org_rule();
DROP FUNCTION organisation_type_immutable();

DROP TABLE practice_membership;
ALTER TABLE company DROP CONSTRAINT "company_organisation_id_practice_id_fkey";
DROP INDEX "company_organisation_id_practice_id_idx";
ALTER TABLE company DROP COLUMN "practice_id";
DROP TABLE practice;

ALTER TABLE company_membership DROP CONSTRAINT "company_membership_role_id_fkey";
DROP INDEX "company_membership_company_id_idx";
ALTER TABLE company_membership DROP COLUMN "role_id";

DELETE FROM "role" WHERE organisation_id IS NULL AND key IN ('partner', 'manager');
UPDATE "role" SET permissions = ARRAY(
  SELECT p FROM unnest(permissions) AS p
   WHERE p NOT IN ('practice:read','practice:manage','practice:member:manage','company:access:manage','workflow:review','workflow:approve'))
 WHERE organisation_id IS NULL;
UPDATE "role" SET description = 'Manage people, companies and documents' WHERE organisation_id IS NULL AND key = 'admin';
UPDATE "role" SET description = 'Work on assigned client companies' WHERE organisation_id IS NULL AND key = 'accountant';
UPDATE "role" SET description = 'Prepare records for assigned companies' WHERE organisation_id IS NULL AND key = 'bookkeeper';

ALTER FUNCTION enforce_role_scope() RENAME TO membership_role_scope;

ALTER TABLE company_membership RENAME TO company_assignment;
ALTER INDEX company_membership_pkey RENAME TO company_assignment_pkey;
ALTER INDEX company_membership_membership_id_company_id_key RENAME TO company_assignment_membership_id_company_id_key;
ALTER TABLE company_assignment RENAME CONSTRAINT company_membership_organisation_id_membership_id_fkey TO company_assignment_organisation_id_membership_id_fkey;
ALTER TABLE company_assignment RENAME CONSTRAINT company_membership_organisation_id_company_id_fkey TO company_assignment_organisation_id_company_id_fkey;

ALTER TABLE organisation_membership RENAME TO membership;
ALTER INDEX organisation_membership_pkey RENAME TO membership_pkey;
ALTER INDEX organisation_membership_user_id_idx RENAME TO membership_user_id_idx;
ALTER INDEX organisation_membership_organisation_id_user_id_key RENAME TO membership_organisation_id_user_id_key;
ALTER INDEX organisation_membership_organisation_id_id_key RENAME TO membership_organisation_id_id_key;
ALTER TABLE membership RENAME CONSTRAINT organisation_membership_organisation_id_fkey TO membership_organisation_id_fkey;
ALTER TABLE membership RENAME CONSTRAINT organisation_membership_user_id_fkey TO membership_user_id_fkey;
ALTER TABLE membership RENAME CONSTRAINT organisation_membership_role_id_fkey TO membership_role_id_fkey;
ALTER POLICY organisation_membership_select ON membership RENAME TO membership_select;
ALTER POLICY organisation_membership_insert ON membership RENAME TO membership_insert;
ALTER POLICY organisation_membership_update ON membership RENAME TO membership_update;
ALTER POLICY organisation_membership_delete ON membership RENAME TO membership_delete;
ALTER TRIGGER organisation_membership_role_scope_trg ON membership RENAME TO membership_role_scope_trg;

ALTER TABLE "user" DROP COLUMN "platform_role";
DROP TYPE "PlatformRole";
DROP TYPE "PracticeStatus";

ALTER TABLE ai_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation FORCE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;
