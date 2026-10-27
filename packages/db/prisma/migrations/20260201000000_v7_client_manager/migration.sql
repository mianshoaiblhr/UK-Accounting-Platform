-- V7 / milestone V7-M2 (DEC-089): the client manager on a client's compliance profile. Additive. The service checks the person is an active
-- member of the organisation; the column records who it is.
ALTER TABLE "company_compliance_profile" ADD COLUMN "client_manager_user_id" UUID;
ALTER TABLE "company_compliance_profile" ADD CONSTRAINT "ccp_client_manager_fkey" FOREIGN KEY ("client_manager_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ccp_client_manager_idx" ON "company_compliance_profile"("organisation_id", "client_manager_user_id") WHERE client_manager_user_id IS NOT NULL;
