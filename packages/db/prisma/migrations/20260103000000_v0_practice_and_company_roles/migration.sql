-- V0 architecture change set (D1/D5/D6): Practice level, organisation/practice/company membership, per-company roles.
-- destructive-approved: ADR-22 backup-required   (renames membership + company_assignment; metadata-only, all rows preserved)
-- See docs/architecture/v0-hierarchy-and-authorisation-design.md. Applied as ONE transaction (all-or-nothing).

-- ───────── Enums / platform role ─────────
CREATE TYPE "PlatformRole" AS ENUM ('NONE', 'SUPPORT', 'ADMIN');
CREATE TYPE "PracticeStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
ALTER TABLE "user" ADD COLUMN "platform_role" "PlatformRole" NOT NULL DEFAULT 'NONE';

-- Backfills below must see every row. FORCE ROW LEVEL SECURITY applies to the table owner, so it is lifted for
-- the tables being backfilled for the duration of this transaction only and re-applied before COMMIT.
-- The runtime role (uk_app) is never affected.
ALTER TABLE organisation NO FORCE ROW LEVEL SECURITY;
ALTER TABLE company NO FORCE ROW LEVEL SECURITY;
ALTER TABLE membership NO FORCE ROW LEVEL SECURITY;
ALTER TABLE company_assignment NO FORCE ROW LEVEL SECURITY;

-- ───────── Naming convention: organisation / practice / company membership ─────────
ALTER TABLE membership RENAME TO organisation_membership;
ALTER TABLE company_assignment RENAME TO company_membership;

ALTER INDEX membership_pkey RENAME TO organisation_membership_pkey;
ALTER INDEX membership_user_id_idx RENAME TO organisation_membership_user_id_idx;
ALTER INDEX membership_organisation_id_user_id_key RENAME TO organisation_membership_organisation_id_user_id_key;
ALTER INDEX membership_organisation_id_id_key RENAME TO organisation_membership_organisation_id_id_key;
ALTER TABLE organisation_membership RENAME CONSTRAINT membership_organisation_id_fkey TO organisation_membership_organisation_id_fkey;
ALTER TABLE organisation_membership RENAME CONSTRAINT membership_user_id_fkey TO organisation_membership_user_id_fkey;
ALTER TABLE organisation_membership RENAME CONSTRAINT membership_role_id_fkey TO organisation_membership_role_id_fkey;
ALTER POLICY membership_select ON organisation_membership RENAME TO organisation_membership_select;
ALTER POLICY membership_insert ON organisation_membership RENAME TO organisation_membership_insert;
ALTER POLICY membership_update ON organisation_membership RENAME TO organisation_membership_update;
ALTER POLICY membership_delete ON organisation_membership RENAME TO organisation_membership_delete;
ALTER TRIGGER membership_role_scope_trg ON organisation_membership RENAME TO organisation_membership_role_scope_trg;
ALTER FUNCTION membership_role_scope() RENAME TO enforce_role_scope;

ALTER INDEX company_assignment_pkey RENAME TO company_membership_pkey;
ALTER INDEX company_assignment_membership_id_company_id_key RENAME TO company_membership_membership_id_company_id_key;
ALTER TABLE company_membership RENAME CONSTRAINT company_assignment_organisation_id_membership_id_fkey TO company_membership_organisation_id_membership_id_fkey;
ALTER TABLE company_membership RENAME CONSTRAINT company_assignment_organisation_id_company_id_fkey TO company_membership_organisation_id_company_id_fkey;

-- ───────── Practice ─────────
CREATE TABLE "practice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PracticeStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "practice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "practice_organisation_id_id_key" ON "practice"("organisation_id", "id");
CREATE UNIQUE INDEX "practice_organisation_id_name_key" ON "practice"("organisation_id", "name");
ALTER TABLE "practice" ADD CONSTRAINT "practice_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "practice_membership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "practice_membership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "practice_membership_practice_id_membership_id_key" ON "practice_membership"("practice_id", "membership_id");
CREATE INDEX "practice_membership_membership_id_idx" ON "practice_membership"("membership_id");
ALTER TABLE "practice_membership" ADD CONSTRAINT "practice_membership_organisation_id_practice_id_fkey" FOREIGN KEY ("organisation_id", "practice_id") REFERENCES "practice"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "practice_membership" ADD CONSTRAINT "practice_membership_organisation_id_membership_id_fkey" FOREIGN KEY ("organisation_id", "membership_id") REFERENCES "organisation_membership"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "practice_membership" ADD CONSTRAINT "practice_membership_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Company: managing practice + per-company role ─────────
ALTER TABLE company ADD COLUMN "practice_id" UUID;
ALTER TABLE company_membership ADD COLUMN "role_id" UUID;

-- Backfill (data-preserving): one default practice per existing PRACTICE organisation; assigned companies keep the member's role.
INSERT INTO practice (organisation_id, name) SELECT id, name FROM organisation WHERE type = 'PRACTICE';
UPDATE company c SET practice_id = p.id FROM practice p WHERE p.organisation_id = c.organisation_id;
UPDATE company_membership cm SET role_id = om.role_id FROM organisation_membership om WHERE om.id = cm.membership_id;

ALTER TABLE company_membership ALTER COLUMN "role_id" SET NOT NULL;
ALTER TABLE company_membership ADD CONSTRAINT "company_membership_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "company_membership_company_id_idx" ON company_membership("company_id");
-- MATCH SIMPLE: a NULL practice_id (direct business) skips the check; a non-NULL one must belong to the SAME organisation.
ALTER TABLE company ADD CONSTRAINT "company_organisation_id_practice_id_fkey" FOREIGN KEY ("organisation_id", "practice_id") REFERENCES "practice"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "company_organisation_id_practice_id_idx" ON company("organisation_id", "practice_id");

-- ───────── Integrity rules ─────────
-- Mode lives in organisation.type only: PRACTICE organisations own practices and every company has a managing practice;
-- BUSINESS organisations have neither. organisation.type never changes.
CREATE OR REPLACE FUNCTION company_practice_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t "OrganisationType";
BEGIN
  SELECT type INTO t FROM organisation WHERE id = NEW.organisation_id;
  IF t = 'PRACTICE' AND NEW.practice_id IS NULL THEN
    RAISE EXCEPTION 'a company of a practice organisation must have a managing practice' USING ERRCODE = '23514';
  ELSIF t = 'BUSINESS' AND NEW.practice_id IS NOT NULL THEN
    RAISE EXCEPTION 'a company of a business organisation cannot have a practice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_practice_rule_trg BEFORE INSERT OR UPDATE OF practice_id, organisation_id ON company
  FOR EACH ROW EXECUTE FUNCTION company_practice_rule();

CREATE OR REPLACE FUNCTION practice_org_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t "OrganisationType";
BEGIN
  SELECT type INTO t FROM organisation WHERE id = NEW.organisation_id;
  IF t IS DISTINCT FROM 'PRACTICE' THEN
    RAISE EXCEPTION 'only practice organisations can have practices' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER practice_org_rule_trg BEFORE INSERT ON practice FOR EACH ROW EXECUTE FUNCTION practice_org_rule();

CREATE OR REPLACE FUNCTION organisation_type_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'organisation.type is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_type_immutable_trg BEFORE UPDATE OF type ON organisation
  FOR EACH ROW EXECUTE FUNCTION organisation_type_immutable();

-- Roles granted at practice / company level must be system roles or roles of the same organisation.
CREATE TRIGGER practice_membership_role_scope_trg BEFORE INSERT OR UPDATE OF role_id ON practice_membership
  FOR EACH ROW EXECUTE FUNCTION enforce_role_scope();
CREATE TRIGGER company_membership_role_scope_trg BEFORE INSERT OR UPDATE OF role_id ON company_membership
  FOR EACH ROW EXECUTE FUNCTION enforce_role_scope();

-- ───────── Row-level security + grants for the new tables (fail closed) ─────────
ALTER TABLE practice ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice FORCE ROW LEVEL SECURITY;
ALTER TABLE practice_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON practice USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
CREATE POLICY tenant_isolation ON practice_membership USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON practice, practice_membership TO uk_app;

-- Re-apply FORCE on everything lifted above.
ALTER TABLE organisation FORCE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation_membership FORCE ROW LEVEL SECURITY;
ALTER TABLE company_membership FORCE ROW LEVEL SECURITY;

-- ───────── System roles (kept in sync with @uk/contracts SYSTEM_ROLES by tests/db/rls.test.ts) ─────────
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = ARRAY['org:read','org:manage','member:read','member:invite','member:manage','role:read','role:manage','company:read','company:create','company:update','period:read','period:manage','document:read','document:upload','document:archive','audit:read','job:read','job:manage','task:read','task:manage','workflow:read','workflow:manage','integration:read','integration:manage','ai:use','ai:approve','practice:read','practice:manage','practice:member:manage','company:access:manage','workflow:review','workflow:approve']::text[], description = 'Full control including organisation settings' WHERE organisation_id IS NULL AND key = 'owner';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','member:invite','member:manage','role:read','role:manage','company:read','company:create','company:update','period:read','period:manage','document:read','document:upload','document:archive','audit:read','job:read','job:manage','task:read','task:manage','workflow:read','workflow:manage','integration:read','integration:manage','ai:use','ai:approve','practice:read','practice:manage','practice:member:manage','company:access:manage','workflow:review','workflow:approve']::text[], description = 'Manage people, practices, companies and documents' WHERE organisation_id IS NULL AND key = 'admin';
INSERT INTO "role" (id, organisation_id, key, name, description, permissions, is_system) VALUES
('00000000-0000-4000-8000-0000000000a7', NULL, 'partner', 'Partner', 'Leads a practice or client company: full company control including review, approval and access management', ARRAY['org:read','member:read','role:read','audit:read','job:read','practice:read','practice:manage','practice:member:manage','company:create','company:read','company:update','period:read','period:manage','document:read','document:upload','document:archive','task:read','task:manage','workflow:read','workflow:manage','ai:use','ai:approve','company:access:manage','workflow:review','workflow:approve']::text[], true);
INSERT INTO "role" (id, organisation_id, key, name, description, permissions, is_system) VALUES
('00000000-0000-4000-8000-0000000000a8', NULL, 'manager', 'Manager', 'Manages day-to-day work on a company: can review but not approve or manage access', ARRAY['org:read','member:read','role:read','job:read','practice:read','company:read','company:update','period:read','period:manage','document:read','document:upload','document:archive','task:read','task:manage','workflow:read','workflow:manage','workflow:review','ai:use']::text[], true);
UPDATE "role" SET permissions = ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','practice:read','company:create','company:update','period:manage','document:upload','document:archive','job:read','audit:read','task:read','task:manage','workflow:read','workflow:manage','workflow:review','ai:use','ai:approve']::text[], description = 'Work on assigned client companies' WHERE organisation_id IS NULL AND key = 'accountant';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','practice:read','document:upload','job:read','task:read','task:manage','workflow:read','ai:use']::text[], description = 'Prepare records for assigned companies' WHERE organisation_id IS NULL AND key = 'bookkeeper';
UPDATE "role" SET permissions = ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','practice:read','audit:read','job:read','task:read','workflow:read','workflow:review']::text[], description = 'Read-only review and audit access' WHERE organisation_id IS NULL AND key = 'reviewer';
UPDATE "role" SET permissions = ARRAY['org:read','company:read','period:read','document:read']::text[], description = 'Client read-only access to own company' WHERE organisation_id IS NULL AND key = 'client_viewer';
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;
