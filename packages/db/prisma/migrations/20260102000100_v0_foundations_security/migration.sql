-- Security layer for the V0 foundations tables. Additive only (no destructive statements).

ALTER TABLE outbox_event ADD CONSTRAINT outbox_retry_ck CHECK (retry_count >= 0);

-- ───────── Outbox: the event itself is immutable; only delivery bookkeeping may change ─────────
CREATE OR REPLACE FUNCTION outbox_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type <> OLD.event_type OR NEW.event_version <> OLD.event_version
     OR NEW.aggregate_type <> OLD.aggregate_type OR NEW.aggregate_id <> OLD.aggregate_id
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.payload <> OLD.payload OR NEW.occurred_at <> OLD.occurred_at
     OR NEW.correlation_id <> OLD.correlation_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id THEN
    RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_event_immutable_trg BEFORE UPDATE ON outbox_event
  FOR EACH ROW EXECUTE FUNCTION outbox_event_immutable();

-- Workflow history, AI run log: append-only
CREATE TRIGGER workflow_transition_append_only BEFORE UPDATE OR DELETE ON workflow_transition
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ai_run_append_only BEFORE UPDATE OR DELETE ON ai_run
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────── Grants ─────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uk_app;
REVOKE UPDATE, DELETE, TRUNCATE ON workflow_transition, ai_run FROM uk_app;
REVOKE DELETE, TRUNCATE ON outbox_event FROM uk_app;

-- ───────── Row-level security ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox_event','event_consumption','workflow_instance','workflow_transition','task','notification',
                           'integration_connection','ai_run','ai_proposal']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_instance','workflow_transition','task','integration_connection','ai_run','ai_proposal']
  LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org())', t);
  END LOOP;
END $$;

-- outbox / consumption: tenant context OR trusted system context (the relay); org-less events allowed
CREATE POLICY outbox_select ON outbox_event FOR SELECT USING (organisation_id = app_org() OR app_system());
CREATE POLICY outbox_insert ON outbox_event FOR INSERT WITH CHECK (organisation_id = app_org() OR organisation_id IS NULL OR app_system());
CREATE POLICY outbox_update ON outbox_event FOR UPDATE USING (app_system()) WITH CHECK (app_system());
CREATE POLICY consumption_all ON event_consumption
  USING (organisation_id = app_org() OR app_system()) WITH CHECK (organisation_id = app_org() OR organisation_id IS NULL OR app_system());

-- notifications: a tenant may create them for any member, but only the recipient can read / update them
CREATE POLICY notification_insert ON notification FOR INSERT WITH CHECK (organisation_id = app_org());
CREATE POLICY notification_select ON notification FOR SELECT USING (organisation_id = app_org() AND user_id = app_user());
CREATE POLICY notification_update ON notification FOR UPDATE USING (organisation_id = app_org() AND user_id = app_user())
  WITH CHECK (organisation_id = app_org() AND user_id = app_user());

-- ───────── New permissions for the system roles (additive; applied migrations are never edited) ─────────
-- NOTE: FORCE ROW LEVEL SECURITY applies to the table OWNER, so a non-superuser migrator (uk_migrator in production) would be
-- blocked from (or silently skip) the data statements below. RLS is lifted for this one table for the rest of the
-- migration transaction only and re-applied at the end. (Found in the V0 specification review; no persistent database had applied this file.)
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET permissions = permissions || ARRAY['task:read','task:manage','workflow:read','workflow:manage','integration:read','integration:manage','ai:use','ai:approve']
  WHERE organisation_id IS NULL AND key IN ('owner','admin');
UPDATE "role" SET permissions = permissions || ARRAY['task:read','task:manage','workflow:read','workflow:manage','ai:use','ai:approve']
  WHERE organisation_id IS NULL AND key = 'accountant';
UPDATE "role" SET permissions = permissions || ARRAY['task:read','task:manage','workflow:read','ai:use']
  WHERE organisation_id IS NULL AND key = 'bookkeeper';
UPDATE "role" SET permissions = permissions || ARRAY['task:read','workflow:read']
  WHERE organisation_id IS NULL AND key = 'reviewer';
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;
