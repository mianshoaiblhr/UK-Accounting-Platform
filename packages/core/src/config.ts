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
  // Layered login throttling (see docs/architecture/security-architecture.md)
  LOGIN_DELAY_START: z.coerce.number().default(3), // failures (per IP+account) before progressive delay begins
  LOGIN_DELAY_BASE_SECONDS: z.coerce.number().default(2), // delay = base * 2^(failures - start); 0 disables delays
  LOGIN_PAIR_BLOCK_AT: z.coerce.number().default(10), // failures (per IP+account) => temporary block of that pair
  LOGIN_PAIR_BLOCK_MINUTES: z.coerce.number().default(15),
  LOGIN_IP_BLOCK_AT: z.coerce.number().default(100), // failures from one IP in 15 min => block that IP
  LOGIN_IP_DISTINCT_ACCOUNTS: z.coerce.number().default(20), // distinct accounts failed from one IP in 15 min (spraying)
  LOGIN_IP_BLOCK_MINUTES: z.coerce.number().default(15),
  LOGIN_ACCOUNT_PRESSURE_AT: z.coerce.number().default(30), // failures in 1h from >=3 distinct IPs => account under attack
  LOGIN_ACCOUNT_PRESSURE_MINUTES: z.coerce.number().default(30),
  // Audit: keep IP address and user agent on audit events (security/fraud-prevention basis). Set false where that basis does not hold.
  AUDIT_CAPTURE_DEVICE_METADATA: bool.default('true'),
  RATE_LIMIT_ENABLED: bool.default('true'),
  API_DOCS_ENABLED: z.enum(['true', 'false']).optional(), // default: on outside production
  MAX_UPLOAD_BYTES: z.coerce.number().default(25 * 1024 * 1024),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
  // Feature flags: "key=true,other=false" (keys validated against the registry at startup). Per-organisation overrides win.
  FEATURE_FLAG_DEFAULTS: z.string().default(''),
  // How long an instance may serve a cached flag value (0 = always read). A switch-off reaches every instance within this window.
  FEATURE_FLAG_CACHE_MS: z.coerce.number().int().min(0).default(5000),
  // Transactional outbox
  OUTBOX_POLL_MS: z.coerce.number().int().min(50).default(500),
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(1).default(14), // processed events older than this are deleted
  OUTBOX_CLEANUP_MS: z.coerce.number().int().min(1000).default(600_000),
  TASK_REMINDER_POLL_MS: z.coerce.number().int().min(200).default(30_000), // how often due task reminders are delivered
});

export type AppConfig = z.infer<typeof schema> & { allowedRegions: string[]; corsOrigins: string[]; isProduction: boolean; apiDocsEnabled: boolean };

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
  return { ...c, allowedRegions, corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()), isProduction, apiDocsEnabled: c.API_DOCS_ENABLED ? c.API_DOCS_ENABLED === 'true' : !isProduction };
}
