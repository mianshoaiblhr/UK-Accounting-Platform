import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const alias = Object.fromEntries(
  ['core', 'contracts', 'db', 'jobs', 'adapters'].map((p) => [`@uk/${p}`, resolve(__dirname, `packages/${p}/src/index.ts`)]),
);

const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost:5432';
const PG_ADMIN = process.env.TEST_PG_ADMIN ?? 'postgres'; // user[:password]

// Deterministic test infrastructure (see tests/setup/global.ts, which creates and migrates this DB).
const testEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: `postgresql://uk_app:uk_app_test@${PG_HOST}/uk_test`,
  MIGRATION_DATABASE_URL: `postgresql://${PG_ADMIN}@${PG_HOST}/uk_test`,
  TEST_ADMIN_DATABASE_URL: `postgresql://${PG_ADMIN}@${PG_HOST}/postgres`,
  REDIS_URL: `${process.env.TEST_REDIS ?? 'redis://localhost:6379'}/1`,
  FIELD_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  APP_BASE_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  RATE_LIMIT_ENABLED: 'false',
  EMAIL_DRIVER: 'file',
  AV_DRIVER: 'noop',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: '.tmp/test-storage',
  WORKER_CONCURRENCY: '4',
};

const base = { plugins: [swc.vite({ module: { type: 'es6' } })], resolve: { alias } };

export default defineConfig({
  test: {
    fileParallelism: false, // integration/e2e share Postgres + Redis; unit suite is fast enough serially
    projects: [
      {
        ...base,
        test: { name: 'unit', include: ['packages/**/src/**/*.test.ts', 'tests/unit/**/*.test.ts'], env: testEnv },
      },
      {
        ...base,
        test: {
          name: 'integration',
          include: ['tests/db/**/*.test.ts', 'tests/jobs/**/*.test.ts', 'tests/api/**/*.test.ts'],
          env: testEnv,
          globalSetup: ['tests/setup/global.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        ...base,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          env: { ...testEnv, NODE_ENV: 'test' },
          globalSetup: ['tests/setup/global.ts'],
          testTimeout: 90_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
