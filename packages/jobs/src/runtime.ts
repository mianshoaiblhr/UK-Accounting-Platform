import { Worker, UnrecoverableError, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import type { z, ZodTypeAny } from 'zod';
import { DEAD_LETTER_QUEUE, type JobDefinition, type QueueName } from '@uk/contracts';
import { runWithContext, type FieldEncryption, type Logger } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import { decodePayload } from './payload';
import { redisConnection, type JobMessage, type JobProducer } from './producer';

export interface JobContext<P> {
  recordId: string;
  payload: P;
  organisationId: string | null;
  userId: string | null;
  correlationId: string;
  /** 1-based attempt number. */
  attempt: number;
  progress(percent: number, message?: string): Promise<void>;
  log: Logger;
}

type Handler = (ctx: JobContext<any>) => Promise<unknown>;

/** Throw to fail a job permanently with no retries. */
export { UnrecoverableError };

export class JobRuntime {
  private readonly handlers = new Map<string, { def: JobDefinition; fn: Handler }>();
  private readonly workers: Worker[] = [];
  private readonly connection: IORedis;

  constructor(
    private readonly db: Database,
    redisUrl: string,
    private readonly crypto: FieldEncryption,
    private readonly producer: JobProducer,
    private readonly logger: Logger,
    private readonly concurrency = 5,
  ) {
    this.connection = redisConnection(redisUrl);
  }

  register<S extends ZodTypeAny>(def: JobDefinition<S>, fn: (ctx: JobContext<z.output<S>>) => Promise<unknown>): this {
    this.handlers.set(def.type, { def, fn });
    return this;
  }

  start(): void {
    const queues = new Set<QueueName>([...this.handlers.values()].map((h) => h.def.queue));
    for (const q of queues) {
      const w = new Worker(q, (job) => this.process(job), { connection: this.connection, concurrency: this.concurrency });
      w.on('error', (err) => this.logger.error({ err, queue: q }, 'worker error'));
      this.workers.push(w);
    }
    this.logger.info({ queues: [...queues] }, 'job runtime started');
  }

  private run<T>(msg: JobMessage, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return msg.organisationId
      ? this.db.tenant({ organisationId: msg.organisationId, userId: msg.userId ?? undefined }, fn)
      : this.db.system(fn);
  }

  private async process(job: Job<JobMessage>): Promise<unknown> {
    const msg = job.data;
    const entry = this.handlers.get(job.name);
    const attempt = job.attemptsMade + 1;
    return runWithContext(
      { correlationId: msg.correlationId, traceId: msg.traceId ?? undefined, userId: msg.userId ?? undefined, organisationId: msg.organisationId ?? undefined },
      async () => {
        const log = this.logger.child({ jobRecordId: msg.recordId, jobType: job.name, attempt });
        if (!entry) {
          await this.finish(msg, job, new UnrecoverableError(`No handler for ${job.name}`), attempt, log);
          throw new UnrecoverableError(`No handler for ${job.name}`);
        }
        await this.run(msg, (tx) => tx.jobRecord.update({
          where: { id: msg.recordId },
          data: { status: 'RUNNING', attempts: attempt, startedAt: new Date(), error: null },
        }));
        try {
          const raw = decodePayload(entry.def, msg.payload, this.crypto);
          const parsed = entry.def.schema.safeParse(raw);
          if (!parsed.success) throw new UnrecoverableError(`Invalid payload: ${parsed.error.message}`);
          log.info('job started');
          const result = await entry.fn({
            recordId: msg.recordId, payload: parsed.data, organisationId: msg.organisationId, userId: msg.userId,
            correlationId: msg.correlationId, attempt, log,
            progress: async (percent, message) => {
              const p = Math.max(0, Math.min(100, Math.round(percent)));
              await job.updateProgress(p);
              await this.run(msg, (tx) => tx.jobRecord.update({ where: { id: msg.recordId }, data: { progress: p, progressMessage: message ?? null } }));
            },
          });
          await this.run(msg, (tx) => tx.jobRecord.update({
            where: { id: msg.recordId },
            data: { status: 'COMPLETED', progress: 100, finishedAt: new Date(), result: (result ?? null) as never },
          }));
          log.info('job completed');
          return result;
        } catch (err) {
          await this.finish(msg, job, err, attempt, log);
          throw err;
        }
      },
    );
  }

  private async finish(msg: JobMessage, job: Job<JobMessage>, err: unknown, attempt: number, log: Logger): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    const permanent = err instanceof UnrecoverableError;
    const exhausted = attempt >= (job.opts.attempts ?? 1);
    if (!permanent && !exhausted) {
      await this.run(msg, (tx) => tx.jobRecord.update({ where: { id: msg.recordId }, data: { status: 'RETRYING', error: message } }));
      log.warn({ err: message }, 'job failed; will retry with exponential backoff');
      return;
    }
    await this.run(msg, (tx) => tx.jobRecord.update({
      where: { id: msg.recordId },
      data: { status: permanent ? 'FAILED' : 'DEAD', error: message, finishedAt: new Date() },
    }));
    // Dead-letter entry carries identifiers only (payload stays in job_record, encrypted when sensitive).
    await this.producer.queue(DEAD_LETTER_QUEUE).add('dead', {
      recordId: msg.recordId, organisationId: msg.organisationId, type: job.name, error: message, attempts: attempt, permanent,
    }, { jobId: `dead:${msg.recordId}:${Date.now()}`, removeOnComplete: false, removeOnFail: false }).catch(() => undefined);
    log.error({ err: message, permanent }, 'job failed permanently (dead-lettered)');
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    this.connection.disconnect();
  }
}
