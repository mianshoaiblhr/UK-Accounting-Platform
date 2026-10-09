-- V0 Tranche A: transactional outbox hardening. Additive; adds ordering, processed bookkeeping and a guarded cleanup path.
--   seq          : insertion sequence. Events of one aggregate are produced one after another (the business change holds the
--                  aggregate's row lock/optimistic version until commit), so seq order == business order per aggregate.
--   processed_at : set when every consumer of the event has completed. The relay only publishes the HEAD event of an aggregate
--                  (no earlier unprocessed event), which gives end-to-end per-aggregate ordering.

ALTER TABLE outbox_event ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE outbox_event ADD COLUMN "processed_at" TIMESTAMPTZ(3);

-- Events published before this change were fully handled by the old flow: mark them processed so they never block an aggregate.
ALTER TABLE outbox_event NO FORCE ROW LEVEL SECURITY;
UPDATE outbox_event SET processed_at = coalesce(published_at, now()) WHERE status = 'PUBLISHED';
ALTER TABLE outbox_event FORCE ROW LEVEL SECURITY;

ALTER TABLE outbox_event ADD CONSTRAINT outbox_processed_ck CHECK (processed_at IS NULL OR status = 'PUBLISHED');
CREATE UNIQUE INDEX "outbox_event_seq_key" ON outbox_event("seq");
-- Head-of-aggregate lookup used by the relay and by the consumer-side ordering guard.
CREATE INDEX "outbox_event_unprocessed_aggregate_idx" ON outbox_event("aggregate_type", "aggregate_id", "seq") WHERE "processed_at" IS NULL;
CREATE INDEX "outbox_event_processed_at_idx" ON outbox_event("processed_at") WHERE "processed_at" IS NOT NULL;

-- seq joins the immutable event content.
CREATE OR REPLACE FUNCTION outbox_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type <> OLD.event_type OR NEW.event_version <> OLD.event_version
     OR NEW.aggregate_type <> OLD.aggregate_type OR NEW.aggregate_id <> OLD.aggregate_id
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.payload <> OLD.payload OR NEW.occurred_at <> OLD.occurred_at
     OR NEW.correlation_id <> OLD.correlation_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- Cleanup: only the trusted system context may delete, and only events that were fully processed.
-- An unprocessed event (PENDING, FAILED, or published but not yet consumed) can never be deleted.
CREATE OR REPLACE FUNCTION outbox_event_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.processed_at IS NULL THEN
    RAISE EXCEPTION 'an unprocessed outbox event cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER outbox_event_delete_guard_trg BEFORE DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION outbox_event_delete_guard();
GRANT DELETE ON outbox_event TO uk_app;
CREATE POLICY outbox_delete ON outbox_event FOR DELETE USING (app_system());
