import { createAntivirus, createEmail, createStorage } from '@uk/adapters';
import { FieldEncryption, createLogger, type AppConfig, type Logger } from '@uk/core';
import { Database } from '@uk/db';
import { JobProducer, JobRuntime } from '@uk/jobs';
import { parseFeatureDefaults } from '@uk/contracts';
import { AiGateway, AiProposalService, EventBus, FeatureFlagService, IntegrationService, NotificationService, OutboxRelay, TaskReminderSweeper, WorkflowEngine, WorkflowRegistry, createAiProviders, createIntegrationRegistry, createOcrProvider, dispatchViaJobs, type AiProvider, type OcrProvider } from '@uk/platform';
import { registerAi, registerConsumers, registerEventDispatch, registerIntegrations } from './handlers/platform';
import { registerDocument } from './handlers/document';
import { registerEcho } from './handlers/echo';
import { registerEmail } from './handlers/email';

export interface WorkerHandle { stop(): Promise<void>; runtime: JobRuntime; producer: JobProducer; db: Database; relay: OutboxRelay; reminders: TaskReminderSweeper; ocr?: OcrProvider; bus: EventBus; aiProviders: AiProvider[] }

/** Builds and starts the worker; also used by integration tests. */
export function startWorker(config: AppConfig, logger: Logger = createLogger(config.LOG_LEVEL, 'worker')): WorkerHandle {
  const db = new Database(config.DATABASE_URL);
  const crypto = new FieldEncryption(config.FIELD_ENCRYPTION_KEY);
  const producer = new JobProducer(db, config.REDIS_URL, crypto, logger);
  const runtime = new JobRuntime(db, config.REDIS_URL, crypto, producer, logger, config.WORKER_CONCURRENCY);

  registerEmail(runtime, createEmail(config, logger));
  registerEcho(runtime);

  // Platform foundations: outbox relay -> events queue -> idempotent consumers; AI proposals; integrations
  const bus = new EventBus(db, logger);
  const notifications = new NotificationService(producer);
  registerConsumers(bus, notifications);
  registerEventDispatch(runtime, bus);
  const aiProviders = createAiProviders(config);
  const features = new FeatureFlagService(db, parseFeatureDefaults(config.FEATURE_FLAG_DEFAULTS), { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA, ttlMs: config.FEATURE_FLAG_CACHE_MS });
  const ocr = createOcrProvider(config);
  registerDocument(runtime, { db, storage: createStorage(config), av: createAntivirus(config), features, jobs: producer, ocr });
  registerAi(runtime, { features, db, gateway: new AiGateway(aiProviders, logger, db), proposals: new AiProposalService(new WorkflowEngine(new WorkflowRegistry(), { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA })) });
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

  // Task reminders: due reminders become in-app notifications (each handled in its tenant, exactly once).
  const reminders = new TaskReminderSweeper(db, notifications, logger, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA });
  const reminderLoop = setInterval(() => { reminders.sweepOnce().catch((err) => logger.error({ err }, 'task reminder sweep failed')); }, config.TASK_REMINDER_POLL_MS);
  reminderLoop.unref();

  // Recover jobs persisted to Postgres but never delivered to Redis (e.g. Redis outage mid-request).
  const sweeper = setInterval(() => {
    producer.sweepStale().then((n) => n && logger.warn({ requeued: n }, 'swept stale queued jobs')).catch((err) => logger.error({ err }, 'sweep failed'));
  }, 15_000);
  sweeper.unref();

  return {
    runtime, producer, db, relay, reminders, ocr, bus, aiProviders,
    async stop() {
      clearInterval(sweeper);
      clearInterval(relayLoop);
      clearInterval(cleanupLoop);
      clearInterval(reminderLoop);
      await runtime.stop();
      await producer.close();
      await db.close();
    },
  };
}
