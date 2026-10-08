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
