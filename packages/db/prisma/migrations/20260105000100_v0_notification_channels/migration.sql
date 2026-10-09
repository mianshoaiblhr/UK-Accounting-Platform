-- V0 pre-V1 bundle / S2 (V0-7.3, ADR-38): notification channel port - per-user preferences and planned out-of-band deliveries.
-- Two NEW tables only; `notification` (the in-app channel's store) is unchanged. No data statements, nothing to backfill.

-- A user's opt-in per channel and category. Absence of a row means "not opted in" for optional channels (e-mail is off by default, so
-- introducing the port changes no behaviour and sends no new personal data). `in_app` is mandatory and never stored here.
CREATE TABLE "notification_preference" (
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("organisation_id", "user_id", "channel", "category"),
    CONSTRAINT notification_preference_channel_ck CHECK (channel IN ('email','sms','whatsapp')),
    CONSTRAINT notification_preference_category_ck CHECK (category IN ('task','workflow','system')),
    -- sms / whatsapp are documented stubs: nobody can opt in until they are implemented
    CONSTRAINT notification_preference_stub_ck CHECK (channel = 'email' OR enabled = false)
);
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A planned delivery of one notification through one out-of-band channel. Written in the SAME transaction as the notification (so a
-- rolled-back cause plans nothing), executed by the worker sweeper (no network I/O inside a business transaction). Title and type are
-- copied so the sweeper never needs to read the recipient-private `notification` row; the body is deliberately not copied.
CREATE TABLE "notification_delivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retry_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT notification_delivery_channel_ck CHECK (channel IN ('email','sms','whatsapp')),
    CONSTRAINT notification_delivery_status_ck CHECK (status IN ('PENDING','SENT','SKIPPED','FAILED')),
    CONSTRAINT notification_delivery_attempts_ck CHECK (attempts >= 0),
    CONSTRAINT notification_delivery_sent_ck CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE UNIQUE INDEX "notification_delivery_notification_id_channel_key" ON "notification_delivery"("notification_id", "channel");
CREATE INDEX "notification_delivery_due_idx" ON "notification_delivery"((coalesce(retry_at, created_at))) WHERE status = 'PENDING';
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: tenant isolation by organisation. (Colleagues' preference rows are not exposed by the API - it filters by the
-- caller - but event consumers run with the event's ACTOR as the user and must read the RECIPIENT's preference, so the boundary here is the tenant.)
ALTER TABLE "notification_preference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preference" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_preference" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
ALTER TABLE "notification_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_delivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_delivery" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
-- The sweeper lists due deliveries across tenants through the trusted system context (read-only); every write runs in the owning tenant.
CREATE POLICY system_select ON "notification_delivery" FOR SELECT USING (app_system());

-- Least privilege (default privileges grant full DML to the runtime role): preferences are toggled, never deleted; deliveries are an outbox, never deleted by the app.
REVOKE DELETE, TRUNCATE ON "notification_preference" FROM uk_app;
REVOKE DELETE, TRUNCATE ON "notification_delivery" FROM uk_app;
