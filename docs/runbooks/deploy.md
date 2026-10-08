# Deploy (AWS eu-west-2)
1. `terraform -chdir=infra/terraform apply -var domain_name=… -var acm_certificate_arn=… -var ses_from_domain=…` (region guard rejects non-UK regions).
2. First time only: run `infra/db/bootstrap.sql` as the RDS master with `-v app_password=<random_password.app_db>` (creates login for `uk_app`).
3. Build and push images (CI `images` job; tags immutable): api, worker, web, migrate.
4. Run the **migrate** image as a one-off Fargate task with `MIGRATION_DATABASE_URL` (owner credentials from the RDS-managed secret) → `prisma migrate deploy`. Only then update services (`image_tag`).
5. Verify `/api/v1/readyz`; watch the circuit-breaker rollback on failure.
Migrations are forward-only; use expand/contract for breaking schema changes.
