-- Run ONCE per environment by a DBA / Terraform provisioner (as rds master or postgres superuser).
-- :app_password is supplied via `psql -v app_password=...` from Secrets Manager; never committed.
-- Migrations run as the owning/migrator role and create the NOLOGIN uk_app role if it is missing;
-- this script then enables login for it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'uk_app') THEN
    CREATE ROLE uk_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE uk_app LOGIN PASSWORD :'app_password';

-- Migration safety: a migration must never block production traffic indefinitely.
-- Applied to the owner/migrator role used by `prisma migrate deploy` (RDS master user `uk_migrator` in Terraform).
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uk_migrator') THEN
    ALTER ROLE uk_migrator SET lock_timeout = '10s';
    ALTER ROLE uk_migrator SET statement_timeout = '15min';
    ALTER ROLE uk_migrator SET idle_in_transaction_session_timeout = '5min';
  END IF;
END $$;
