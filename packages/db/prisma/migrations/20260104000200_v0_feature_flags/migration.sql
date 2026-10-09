-- V0 Tranche A: feature flags (Manifest cross-version rule, cross-platform requirement 9). Additive.
-- The flag registry lives in code (@uk/contracts); this table only stores per-organisation overrides.
CREATE TABLE "feature_flag_override" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" TEXT,
    "set_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feature_flag_override_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "feature_flag_override_organisation_id_key_key" ON "feature_flag_override"("organisation_id", "key");
ALTER TABLE "feature_flag_override" ADD CONSTRAINT "feature_flag_override_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feature_flag_override" ADD CONSTRAINT feature_flag_key_ck CHECK (key ~ '^[a-z][a-z0-9_.]{1,60}$');
ALTER TABLE "feature_flag_override" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_override" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "feature_flag_override" USING (organisation_id = app_org()) WITH CHECK (organisation_id = app_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON "feature_flag_override" TO uk_app;
