import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const alias = Object.fromEntries(
  ['core', 'contracts', 'db', 'jobs', 'adapters', 'platform', 'accounting'].map((p) => [`@uk/${p}`, resolve(__dirname, `packages/${p}/src/index.ts`)]),
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
  FEATURE_FLAG_CACHE_MS: '0', TASK_REMINDER_POLL_MS: '300', WORKFLOW_OVERDUE_POLL_MS: '300', NOTIFICATION_DELIVERY_POLL_MS: '300', OCR_PROVIDER: 'fake', METRICS_SNAPSHOT_TTL_MS: '0', // deterministic tests; the TTL cache itself is covered in tests/platform/feature-flag-service.test.ts
  FEATURE_FLAG_DEFAULTS: 'ai.beta=true,bookkeeping.core=true', // existing AI tests exercise the feature; flag behaviour is covered in tests/api/feature-flags.test.ts
  LOGIN_DELAY_BASE_SECONDS: '0', // progressive delay is exercised explicitly in login-throttle.test.ts
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
          include: ['tests/db/**/*.test.ts', 'tests/jobs/**/*.test.ts', 'tests/platform/**/*.test.ts', 'tests/api/**/*.test.ts'],
          env: testEnv,
          globalSetup: ['tests/setup/global.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        ...base,
        test: {
          name: 'infra',
          include: ['tests/infra/**/*.test.ts'],
          env: { ...testEnv, AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test', AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
          globalSetup: ['tests/setup/global.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
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
