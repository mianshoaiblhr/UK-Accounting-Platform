import { createAntivirus, createEmail, createStorage } from '@uk/adapters';
import { EMF_DIMENSION_KEYS, FieldEncryption, MetricsRegistry, createLogger, startEmfEmitter, startLagSampler, type AppConfig, type Logger } from '@uk/core';
import { Database } from '@uk/db';
import { JobProducer, JobRuntime } from '@uk/jobs';
import { parseFeatureDefaults } from '@uk/contracts';
import { AiGateway, AiProposalService, EventBus, FeatureFlagService, IntegrationService, NotificationDeliverySweeper, NotificationService, OutboxRelay, TaskReminderSweeper, WorkflowEngine, WorkflowOverdueSweeper, collectPlatformMetrics, WorkflowRegistry, createAiProviders, createIntegrationRegistry, createNotificationChannels, createOcrProvider, dispatchViaJobs, type AiProvider, type OcrProvider } from '@uk/platform';
import { registerAi, registerConsumers, registerEventDispatch, registerIntegrations } from './handlers/platform';
import { registerDocument } from './handlers/document';
import { registerEcho } from './handlers/echo';
import { registerEmail } from './handlers/email';

export interface WorkerHandle { stop(): Promise<void>; runtime: JobRuntime; producer: JobProducer; db: Database; relay: OutboxRelay; reminders: TaskReminderSweeper; overdue: WorkflowOverdueSweeper; deliveries: NotificationDeliverySweeper; ocr?: OcrProvider; metrics: MetricsRegistry; bus: EventBus; aiProviders: AiProvider[] }

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
  const channels = createNotificationChannels(config, producer);
  const notifications = new NotificationService(channels);
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

  // Workflow deadlines (ADR-37): overdue open instances get a one-time notification, exactly once, in their own tenant transaction.
  const overdue = new WorkflowOverdueSweeper(db, notifications, logger, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA });
  const overdueLoop = setInterval(() => { overdue.sweepOnce().catch((err) => logger.error({ err }, 'workflow overdue sweep failed')); }, config.WORKFLOW_OVERDUE_POLL_MS);
  overdueLoop.unref();

  // Notification channels (ADR-38): planned out-of-band deliveries (e-mail) are handed to their channel here, never inside a business transaction.
  const deliveries = new NotificationDeliverySweeper(db, channels, logger, { captureDeviceMetadata: config.AUDIT_CAPTURE_DEVICE_METADATA });
  const deliveryLoop = setInterval(() => { deliveries.sweepOnce().catch((err) => logger.error({ err }, 'notification delivery sweep failed')); }, config.NOTIFICATION_DELIVERY_POLL_MS);
  deliveryLoop.unref();

  // Metrics (ADR-35): process + platform gauges. The worker is the single writer of the global gauges (outbox, jobs, reminders) so
  // N API tasks do not double count; `worker_heartbeat` lets CloudWatch alarm on a silent worker (missing data = breaching).
  const metrics = new MetricsRegistry();
  const stopLag = startLagSampler(metrics);
  const stopEmf = config.METRICS_EMF ? startEmfEmitter(metrics, {
    namespace: config.METRICS_NAMESPACE, service: 'worker', intervalMs: config.METRICS_EMF_INTERVAL_MS, dimensionKeys: EMF_DIMENSION_KEYS,
    before: async () => { metrics.set('worker_heartbeat', 'Set to 1 on every metrics interval while the worker is alive', 1); await collectPlatformMetrics(db, metrics); },
  }) : () => undefined;

  // Recover jobs persisted to Postgres but never delivered to Redis (e.g. Redis outage mid-request).
  const sweeper = setInterval(() => {
    producer.sweepStale().then((n) => n && logger.warn({ requeued: n }, 'swept stale queued jobs')).catch((err) => logger.error({ err }, 'sweep failed'));
  }, 15_000);
  sweeper.unref();

  return {
    runtime, producer, db, relay, reminders, overdue, deliveries, ocr, metrics, bus, aiProviders,
    async stop() {
      clearInterval(sweeper);
      clearInterval(relayLoop);
      clearInterval(cleanupLoop);
      clearInterval(reminderLoop);
      clearInterval(overdueLoop);
      clearInterval(deliveryLoop);
      stopEmf();
      stopLag();
      await runtime.stop();
      await producer.close();
      await db.close();
    },
  };
}
