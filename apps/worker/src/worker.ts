import { createAntivirus, createEmail, createStorage } from '@uk/adapters';
import { FieldEncryption, createLogger, type AppConfig, type Logger } from '@uk/core';
import { Database } from '@uk/db';
import { JobProducer, JobRuntime } from '@uk/jobs';
import { AiGateway, AiProposalService, EventBus, IntegrationService, NotificationService, OutboxRelay, WorkflowEngine, WorkflowRegistry, createAiProviders, createIntegrationRegistry, dispatchViaJobs, type AiProvider } from '@uk/platform';
import { registerAi, registerConsumers, registerEventDispatch, registerIntegrations } from './handlers/platform';
import { registerDocument } from './handlers/document';
import { registerEcho } from './handlers/echo';
import { registerEmail } from './handlers/email';

export interface WorkerHandle { stop(): Promise<void>; runtime: JobRuntime; producer: JobProducer; db: Database; relay: OutboxRelay; bus: EventBus; aiProviders: AiProvider[] }

/** Builds and starts the worker; also used by integration tests. */
export function startWorker(config: AppConfig, logger: Logger = createLogger(config.LOG_LEVEL, 'worker')): WorkerHandle {
  const db = new Database(config.DATABASE_URL);
  const crypto = new FieldEncryption(config.FIELD_ENCRYPTION_KEY);
  const producer = new JobProducer(db, config.REDIS_URL, crypto, logger);
  const runtime = new JobRuntime(db, config.REDIS_URL, crypto, producer, logger, config.WORKER_CONCURRENCY);

  registerEmail(runtime, createEmail(config, logger));
  registerDocument(runtime, { db, storage: createStorage(config), av: createAntivirus(config) });
  registerEcho(runtime);

  // Platform foundations: outbox relay -> events queue -> idempotent consumers; AI proposals; integrations
  const bus = new EventBus(db, logger);
  const notifications = new NotificationService(producer);
  registerConsumers(bus, notifications);
  registerEventDispatch(runtime, bus);
  const aiProviders = createAiProviders(config);
  registerAi(runtime, { db, gateway: new AiGateway(aiProviders, logger, db), proposals: new AiProposalService(new WorkflowEngine(new WorkflowRegistry(), { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA })) });
  registerIntegrations(runtime, { db, service: new IntegrationService(createIntegrationRegistry(config), crypto) });
  runtime.start();

  const relay = new OutboxRelay(db, dispatchViaJobs(producer), logger);
  const relayLoop = setInterval(() => { relay.relayOnce().catch((err) => logger.error({ err }, 'outbox relay failed')); }, config.OUTBOX_POLL_MS);
  relayLoop.unref();
  // Retention of fully processed events (unprocessed events are protected by a database trigger).
  const cleanupLoop = setInterval(() => {
    relay.cleanup(config.OUTBOX_RETENTION_DAYS).then((n) => n && logger.info({ deleted: n }, 'outbox cleanup')).catch((err) => logger.error({ err }, 'outbox cleanup failed'));
  }, config.OUTBOX_CLEANUP_MS);
  cleanupLoop.unref();

  // Recover jobs persisted to Postgres but never delivered to Redis (e.g. Redis outage mid-request).
  const sweeper = setInterval(() => {
    producer.sweepStale().then((n) => n && logger.warn({ requeued: n }, 'swept stale queued jobs')).catch((err) => logger.error({ err }, 'sweep failed'));
  }, 15_000);
  sweeper.unref();

  return {
    runtime, producer, db, relay, bus, aiProviders,
    async stop() {
      clearInterval(sweeper);
      clearInterval(relayLoop);
      clearInterval(cleanupLoop);
      await runtime.stop();
      await producer.close();
      await db.close();
    },
  };
}
