import { Global, Module, type DynamicModule } from '@nestjs/common';
import IORedis from 'ioredis';
import { createStorage } from '@uk/adapters';
import { FieldEncryption, RateLimiter, createLogger, type AppConfig, type Logger, tooManyRequests } from '@uk/core';
import { Database } from '@uk/db';
import { JobProducer } from '@uk/jobs';
import { AiGateway, AiProposalService, IntegrationService, NotificationService, WorkflowEngine, WorkflowRegistry, createAiProviders, createIntegrationRegistry } from '@uk/platform';
import { AI_GATEWAY, AI_PROPOSALS, AI_PROVIDERS, CONFIG, CRYPTO, DB, INTEGRATIONS, JOBS, LOGGER, NOTIFICATIONS, RATE_LIMITER, REDIS, STORAGE, WORKFLOWS } from './tokens';

/** Limiter that can be disabled for tests/dev (never in production — enforced by config validation). */
export class Limits {
  constructor(private readonly inner: RateLimiter | null) {}
  async enforce(key: string, limit: number, windowSeconds: number): Promise<void> {
    if (this.inner) await this.inner.enforce(key, limit, windowSeconds);
  }
  async peek(key: string, limit: number, windowSeconds: number) {
    if (!this.inner) return { allowed: true };
    const r = await this.inner.hit(key, limit, windowSeconds);
    return r;
  }
}
export { tooManyRequests };

@Global()
@Module({})
export class InfraModule {
  static forRoot(config: AppConfig): DynamicModule {
    const providers = [
      { provide: CONFIG, useValue: config },
      { provide: LOGGER, useFactory: (): Logger => createLogger(config.LOG_LEVEL, 'api') },
      { provide: DB, useFactory: () => new Database(config.DATABASE_URL) },
      { provide: REDIS, useFactory: () => new IORedis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }) },
      { provide: CRYPTO, useFactory: () => new FieldEncryption(config.FIELD_ENCRYPTION_KEY) },
      { provide: STORAGE, useFactory: () => createStorage(config) },
      {
        provide: RATE_LIMITER,
        inject: [REDIS],
        useFactory: (redis: IORedis) => new Limits(config.RATE_LIMIT_ENABLED ? new RateLimiter(redis) : null),
      },
      { provide: WORKFLOWS, useFactory: () => new WorkflowEngine(new WorkflowRegistry(), { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA }) },
      { provide: NOTIFICATIONS, inject: [JOBS], useFactory: (jobs: JobProducer) => new NotificationService(jobs) },
      { provide: INTEGRATIONS, inject: [CRYPTO], useFactory: (crypto: FieldEncryption) => new IntegrationService(createIntegrationRegistry(config), crypto) },
      { provide: AI_PROVIDERS, useFactory: () => createAiProviders(config) },
      { provide: AI_GATEWAY, inject: [AI_PROVIDERS, LOGGER], useFactory: (p: ReturnType<typeof createAiProviders>, l: Logger) => new AiGateway(p, l) },
      { provide: AI_PROPOSALS, inject: [WORKFLOWS], useFactory: (w: WorkflowEngine) => new AiProposalService(w) },
      {
        provide: JOBS,
        inject: [DB, CRYPTO, LOGGER],
        useFactory: (db: Database, crypto: FieldEncryption, logger: Logger) => new JobProducer(db, config.REDIS_URL, crypto, logger),
      },
    ];
    return {
      module: InfraModule,
      providers,
      exports: providers.map((p) => p.provide),
    };
  }
}
