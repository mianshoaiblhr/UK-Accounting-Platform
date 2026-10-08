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
  registerAi(runtime, { db, gateway: new AiGateway(aiProviders, logger, db), proposals: new AiProposalService(new WorkflowEngine(new WorkflowRegistry())) });
  registerIntegrations(runtime, { db, service: new IntegrationService(createIntegrationRegistry(config), crypto) });
  runtime.start();

  const relay = new OutboxRelay(db, dispatchViaJobs(producer), logger);
  const relayLoop = setInterval(() => { relay.relayOnce().catch((err) => logger.error({ err }, 'outbox relay failed')); }, Number(process.env.OUTBOX_POLL_MS ?? 500));
  relayLoop.unref();

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
      await runtime.stop();
      await producer.close();
      await db.close();
    },
  };
}
