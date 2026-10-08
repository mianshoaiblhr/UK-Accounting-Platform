-- V0 security layer: roles, grants, row-level security, immutability triggers, constraints, seed.
-- Hand-written; applied by `prisma migrate deploy` as the owner role (uk_migrator / postgres).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Runtime role. Login + password are set by infra/db/bootstrap.sql (never in migrations).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'uk_app') THEN
    CREATE ROLE uk_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ───────── Context helpers (transaction-local settings set by @uk/db withTenant) ─────────
CREATE OR REPLACE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.organisation_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_system() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;

-- ───────── Constraints Prisma cannot express ─────────
ALTER TABLE "user" ADD CONSTRAINT user_email_lowercase CHECK (email = lower(email));
CREATE UNIQUE INDEX role_system_key_uq ON "role" (key) WHERE organisation_id IS NULL;
CREATE UNIQUE INDEX company_number_uq ON company (organisation_id, company_number) WHERE company_number IS NOT NULL;
ALTER TABLE accounting_period ADD CONSTRAINT period_dates_ck CHECK (start_date < end_date);
ALTER TABLE accounting_period ADD CONSTRAINT period_no_overlap
  EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&);
ALTER TABLE document ADD CONSTRAINT document_company_fk
  FOREIGN KEY (organisation_id, company_id) REFERENCES company (organisation_id, id);
ALTER TABLE job_record ADD CONSTRAINT job_progress_ck CHECK (progress BETWEEN 0 AND 100);
ALTER TABLE invitation ADD CONSTRAINT invitation_role_fk FOREIGN KEY (role_id) REFERENCES "role" (id);

-- A membership may only use a system role or a role owned by the same organisation.
CREATE OR REPLACE FUNCTION membership_role_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r_org uuid; r_found boolean;
BEGIN
  SELECT organisation_id, true INTO r_org, r_found FROM "role" WHERE id = NEW.role_id;
  IF NOT coalesce(r_found, false) THEN RAISE EXCEPTION 'role not found'; END IF;
  IF r_org IS NOT NULL AND r_org <> NEW.organisation_id THEN
    RAISE EXCEPTION 'role belongs to a different organisation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_role_scope_trg BEFORE INSERT OR UPDATE OF role_id ON membership
  FOR EACH ROW EXECUTE FUNCTION membership_role_scope();

-- ───────── Immutability ─────────
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on % is not permitted (append-only)', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501'; END $$;

CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION document_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_key <> OLD.storage_key OR NEW.document_id <> OLD.document_id OR NEW.version_no <> OLD.version_no
     OR NEW.content_type <> OLD.content_type OR NEW.size_bytes <> OLD.size_bytes
     OR NEW.organisation_id <> OLD.organisation_id THEN
    RAISE EXCEPTION 'document version content metadata is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'document version hash is immutable once set' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_version_immutable_trg BEFORE UPDATE ON document_version
  FOR EACH ROW EXECUTE FUNCTION document_version_immutable();
CREATE TRIGGER document_version_no_delete BEFORE DELETE ON document_version
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────── Grants (least privilege) ─────────
GRANT USAGE ON SCHEMA public TO uk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uk_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM uk_app;
REVOKE DELETE, TRUNCATE ON document_version, document FROM uk_app;
REVOKE ALL ON _prisma_migrations FROM uk_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO uk_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uk_app;

-- ───────── Row-level security (fail closed: no context => no rows) ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisation','role','membership','company_assignment','invitation','company',
                           'accounting_period','document','document_version','audit_event','job_record','idempotency_record']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Plain tenant tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_assignment','company','accounting_period','document','document_version','idempotency_record']
  LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
  END LOOP;
END $$;

-- invitation / job_record: tenant OR trusted system context (token lookup, sweeper)
CREATE POLICY tenant_isolation ON invitation
  USING (organisation_id = app_org() OR app_system()) WITH CHECK (organisation_id = app_org() OR app_system());
CREATE POLICY tenant_isolation ON job_record
  USING (organisation_id = app_org() OR app_system()) WITH CHECK (organisation_id = app_org() OR app_system());

-- organisation: visible to active members; writable only inside own context
CREATE POLICY org_select ON organisation FOR SELECT USING (
  id = app_org() OR EXISTS (SELECT 1 FROM membership m WHERE m.organisation_id = organisation.id
                            AND m.user_id = app_user() AND m.status = 'ACTIVE'));
CREATE POLICY org_insert ON organisation FOR INSERT WITH CHECK (id = app_org());
CREATE POLICY org_update ON organisation FOR UPDATE USING (id = app_org()) WITH CHECK (id = app_org());

-- membership: a user can see their own memberships everywhere; only the org context can change them
CREATE POLICY membership_select ON membership FOR SELECT USING (organisation_id = app_org() OR user_id = app_user());
CREATE POLICY membership_insert ON membership FOR INSERT WITH CHECK (organisation_id = app_org());
CREATE POLICY membership_update ON membership FOR UPDATE USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
CREATE POLICY membership_delete ON membership FOR DELETE USING (organisation_id = app_org());

-- role: system roles readable by all, custom roles by their org
CREATE POLICY role_select ON "role" FOR SELECT USING (organisation_id IS NULL OR organisation_id = app_org());
CREATE POLICY role_insert ON "role" FOR INSERT WITH CHECK (organisation_id = app_org() AND NOT is_system);
CREATE POLICY role_update ON "role" FOR UPDATE USING (organisation_id = app_org() AND NOT is_system) WITH CHECK (organisation_id = app_org() AND NOT is_system);
CREATE POLICY role_delete ON "role" FOR DELETE USING (organisation_id = app_org() AND NOT is_system);

-- audit: org events by org context; pre-tenant events visible only to their actor
CREATE POLICY audit_select ON audit_event FOR SELECT USING (
  organisation_id = app_org() OR (organisation_id IS NULL AND actor_user_id = app_user()));
CREATE POLICY audit_insert ON audit_event FOR INSERT WITH CHECK (organisation_id IS NULL OR organisation_id = app_org());

-- ───────── Seed: system roles (kept in sync with @uk/contracts SYSTEM_ROLES by a test) ─────────
INSERT INTO "role" (id, organisation_id, key, name, description, permissions, is_system) VALUES
('00000000-0000-4000-8000-0000000000a1', NULL, 'owner', 'Owner', 'Full control including organisation settings', ARRAY['org:read','org:manage','member:read','member:invite','member:manage','role:read','role:manage','company:read','company:create','company:update','period:read','period:manage','document:read','document:upload','document:archive','audit:read','job:read','job:manage']::text[], true),
('00000000-0000-4000-8000-0000000000a2', NULL, 'admin', 'Administrator', 'Manage people, companies and documents', ARRAY['org:read','member:read','member:invite','member:manage','role:read','role:manage','company:read','company:create','company:update','period:read','period:manage','document:read','document:upload','document:archive','audit:read','job:read','job:manage']::text[], true),
('00000000-0000-4000-8000-0000000000a3', NULL, 'accountant', 'Accountant', 'Work on assigned client companies', ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','company:create','company:update','period:manage','document:upload','document:archive','job:read','audit:read']::text[], true),
('00000000-0000-4000-8000-0000000000a4', NULL, 'bookkeeper', 'Bookkeeper', 'Prepare records for assigned companies', ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','document:upload','job:read']::text[], true),
('00000000-0000-4000-8000-0000000000a5', NULL, 'reviewer', 'Reviewer', 'Read-only review and audit access', ARRAY['org:read','member:read','role:read','company:read','period:read','document:read','audit:read','job:read']::text[], true),
('00000000-0000-4000-8000-0000000000a6', NULL, 'client_viewer', 'Client Viewer', 'Client read-only access to own company', ARRAY['org:read','company:read','period:read','document:read']::text[], true);
