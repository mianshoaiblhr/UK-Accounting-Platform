-- V0 Tranche A / increment 8: observability support on the job record.
--  * company_id: queue state can be read per company and is filtered by the caller's company access (composite FK, same tenant).
--  * trace_id:   W3C trace id of the request that enqueued the job, restored in the worker so a request can be followed API -> job -> worker.
-- Additive and nullable: existing jobs simply have neither.
ALTER TABLE "job_record" ADD COLUMN "company_id" UUID, ADD COLUMN "trace_id" TEXT;
ALTER TABLE "job_record" ADD CONSTRAINT job_record_trace_id_ck CHECK (trace_id IS NULL OR trace_id ~ '^[0-9a-f]{32}$');
-- RESTRICT (not SET NULL): SET NULL on a composite key would also clear organisation_id.
ALTER TABLE "job_record" ADD CONSTRAINT "job_record_organisation_id_company_id_fkey" FOREIGN KEY ("organisation_id", "company_id") REFERENCES "company"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "job_record_organisation_id_company_id_created_at_idx" ON "job_record"("organisation_id", "company_id", "created_at" DESC);
