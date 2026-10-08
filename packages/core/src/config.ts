import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  API_PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY_HOPS: z.coerce.number().default(0),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  AWS_REGION: z.string().default('eu-west-2'),
  DATA_RESIDENCY_REGIONS: z.string().default('eu-west-2'),
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.tmp/storage'),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  EMAIL_DRIVER: z.enum(['ses', 'console', 'file', 'memory']).default('console'),
  EMAIL_FILE_DIR: z.string().default('.tmp/mail'),
  EMAIL_FROM: z.string().default('no-reply@example.test'),
  AV_DRIVER: z.enum(['clamav', 'noop']).default('noop'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().default(3310),
  FIELD_ENCRYPTION_KEY: z.string().min(1),
  SESSION_IDLE_MINUTES: z.coerce.number().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().default(12),
  LOGIN_MAX_FAILURES: z.coerce.number().default(5),
  RATE_LIMIT_ENABLED: bool.default('true'),
  MAX_UPLOAD_BYTES: z.coerce.number().default(25 * 1024 * 1024),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
});

export type AppConfig = z.infer<typeof schema> & { allowedRegions: string[]; corsOrigins: string[]; isProduction: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  const allowedRegions = c.DATA_RESIDENCY_REGIONS.split(',').map((s) => s.trim()).filter(Boolean);
  const isProduction = c.NODE_ENV === 'production';
  // Data-residency guard: production must run in an approved (UK) region and use hardened drivers.
  if (isProduction) {
    if (!allowedRegions.includes(c.AWS_REGION)) {
      throw new Error(`Invalid configuration: AWS_REGION ${c.AWS_REGION} is not in DATA_RESIDENCY_REGIONS (${allowedRegions.join(',')})`);
    }
    if (c.STORAGE_DRIVER !== 's3' || !c.S3_BUCKET) throw new Error('Invalid configuration: production requires STORAGE_DRIVER=s3 and S3_BUCKET');
    if (c.EMAIL_DRIVER === 'file' || c.EMAIL_DRIVER === 'memory') throw new Error('Invalid configuration: EMAIL_DRIVER not allowed in production');
    if (c.AV_DRIVER === 'noop') throw new Error('Invalid configuration: production requires AV_DRIVER=clamav');
    if (!c.RATE_LIMIT_ENABLED) throw new Error('Invalid configuration: rate limiting cannot be disabled in production');
  }
  return { ...c, allowedRegions, corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()), isProduction };
}
