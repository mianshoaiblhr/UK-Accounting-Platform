# Deploy (AWS eu-west-2)
1. `terraform -chdir=infra/terraform apply -var domain_name=… -var acm_certificate_arn=… -var ses_from_domain=…` (region guard rejects non-UK regions).
2. First time only: run `infra/db/bootstrap.sql` as the RDS master with `-v app_password=<random_password.app_db>` (creates login for `uk_app`).
3. Build and push images (CI `images` job; tags immutable): api, worker, web, migrate.
4. Run the **migrate** image as a one-off task (`infra/db/migrate.sh`) — full procedure, locking, failure handling, rollback and pre-destructive backups in [`migrations.md`](migrations.md). Only when it exits 0, update services (`image_tag`).
5. Verify `/api/v1/readyz`; watch the circuit-breaker rollback on failure.
Migrations are forward-only; use expand/contract for breaking schema changes.
