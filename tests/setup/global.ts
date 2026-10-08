import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import Redis from 'ioredis';

const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/postgres';
const psql = (url: string, sql: string) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qc', sql], { stdio: 'pipe' });

/** Creates a fresh, fully migrated database; the runtime role (uk_app) is NOT a superuser and cannot bypass RLS. */
export default async function setup() {
  psql(ADMIN, 'DROP DATABASE IF EXISTS uk_test WITH (FORCE)');
  psql(ADMIN, 'CREATE DATABASE uk_test');
  execFileSync('pnpm', ['--filter', '@uk/db', 'exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, MIGRATION_DATABASE_URL: 'postgresql://postgres@localhost:5432/uk_test' },
    stdio: 'pipe',
  });
  psql(ADMIN, "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='uk_app') THEN CREATE ROLE uk_app NOLOGIN; END IF; END $$");
  psql(ADMIN, "ALTER ROLE uk_app LOGIN PASSWORD 'uk_app_test' NOBYPASSRLS NOSUPERUSER");
  const redis = new Redis('redis://localhost:6379/1');
  await redis.flushdb();
  redis.disconnect();
}
