import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import Redis from 'ioredis';

// NOTE: vitest project `env` is NOT visible to globalSetup, so derive everything from the TEST_* variables here
// (CI: TEST_PG_ADMIN=postgres:postgres; local trust-auth: defaults).
const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost:5432';
const PG_ADMIN = process.env.TEST_PG_ADMIN ?? 'postgres';
const ADMIN = `postgresql://${PG_ADMIN}@${PG_HOST}/postgres`;
const MIGRATION_URL = `postgresql://${PG_ADMIN}@${PG_HOST}/uk_test`;
const REDIS = `${process.env.TEST_REDIS ?? 'redis://localhost:6379'}/1`;
const psql = (url: string, sql: string) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qc', sql], { stdio: 'pipe' });

/** Creates a fresh, fully migrated database; the runtime role (uk_app) is NOT a superuser and cannot bypass RLS. */
export default async function setup() {
  psql(ADMIN, 'DROP DATABASE IF EXISTS uk_test WITH (FORCE)');
  psql(ADMIN, 'CREATE DATABASE uk_test');
  execFileSync('pnpm', ['--filter', '@uk/db', 'exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, MIGRATION_DATABASE_URL: MIGRATION_URL },
    stdio: 'pipe',
  });
  psql(ADMIN, "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='uk_app') THEN CREATE ROLE uk_app NOLOGIN; END IF; END $$");
  psql(ADMIN, "ALTER ROLE uk_app LOGIN PASSWORD 'uk_app_test' NOBYPASSRLS NOSUPERUSER");
  const redis = new Redis(REDIS);
  await redis.flushdb();
  redis.disconnect();
}
