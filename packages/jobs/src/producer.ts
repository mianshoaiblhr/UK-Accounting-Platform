import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import type { z, ZodTypeAny } from 'zod';
import { DEAD_LETTER_QUEUE, QUEUES, ALL_JOB_DEFINITIONS, type JobDefinition } from '@uk/contracts';
import { getContext, getCorrelationId, notFound, unprocessable, type FieldEncryption, type Logger } from '@uk/core';
import { Prisma, type Database, type JobRecord, type Tx } from '@uk/db';
import { encodePayload } from './payload';

export interface EnqueueOptions {
  organisationId?: string;
  userId?: string;
  /** Same key + queue => same job (no duplicate execution). Default: unique per call. */
  idempotencyKey?: string;
  correlationId?: string;
  delayMs?: number;
}
export interface EnqueueResult { record: JobRecord; deduplicated: boolean }

export interface JobMessage {
  recordId: string;
  organisationId: string | null;
  userId: string | null;
  correlationId: string;
  payload: unknown;
}

export const redisConnection = (url: string) => new IORedis(url, { maxRetriesPerRequest: null });

export class JobProducer {
  private readonly connection: IORedis;
  private readonly queues = new Map<string, Queue>();
  private readonly defs = new Map(ALL_JOB_DEFINITIONS.map((d) => [d.type, d]));

  constructor(
    private readonly db: Database,
    redisUrl: string,
    private readonly crypto: FieldEncryption,
    private readonly logger: Logger,
  ) {
    this.connection = redisConnection(redisUrl);
    for (const q of [...QUEUES, DEAD_LETTER_QUEUE]) this.queues.set(q, new Queue(q, { connection: this.connection }));
  }

  queue(name: string): Queue {
    const q = this.queues.get(name);
    if (!q) throw new Error(`Unknown queue ${name}`);
    return q;
  }

  private scoped<T>(orgId: string | null | undefined, userId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return orgId ? this.db.tenant({ organisationId: orgId, userId }, fn) : this.db.system(fn);
  }

  async enqueue<S extends ZodTypeAny>(def: JobDefinition<S>, payload: z.input<S>, opts: EnqueueOptions = {}): Promise<EnqueueResult> {
    const parsed = def.schema.safeParse(payload);
    if (!parsed.success) throw unprocessable(`Invalid payload for ${def.type}`, 'invalid_job_payload', parsed.error.flatten());
    const ctx = getContext();
    const organisationId = opts.organisationId ?? ctx?.organisationId;
    const userId = opts.userId ?? ctx?.userId;
    const correlationId = opts.correlationId ?? getCorrelationId();
    const key = `${organisationId ?? 'system'}:${opts.idempotencyKey ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const stored = encodePayload(def, parsed.data, this.crypto) as Prisma.InputJsonValue;

    let record: JobRecord;
    try {
      record = await this.scoped(organisationId, userId, (tx) =>
        tx.jobRecord.create({
          data: {
            organisationId: organisationId ?? null, createdByUserId: userId ?? null, queue: def.queue, type: def.type,
            idempotencyKey: key, correlationId, payload: stored, maxAttempts: def.retry.attempts,
          },
        }),
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.scoped(organisationId, userId, (tx) =>
          tx.jobRecord.findFirstOrThrow({ where: { queue: def.queue, idempotencyKey: key } }));
        return { record: existing, deduplicated: true };
      }
      throw e;
    }
    await this.dispatch(record, def, opts.delayMs);
    return { record, deduplicated: false };
  }

  private async dispatch(record: JobRecord, def: JobDefinition, delayMs?: number): Promise<void> {
    const message: JobMessage = {
      recordId: record.id, organisationId: record.organisationId, userId: record.createdByUserId,
      correlationId: record.correlationId, payload: record.payload,
    };
    const jobOpts: JobsOptions = {
      jobId: record.id,
      attempts: def.retry.attempts,
      backoff: { type: 'exponential', delay: def.retry.backoffMs },
      delay: delayMs,
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 14 * 24 * 3600 },
    };
    try {
      await this.queue(def.queue).add(def.type, message, jobOpts);
    } catch (e) {
      // Record stays QUEUED; sweepStale() re-dispatches it once Redis is back.
      this.logger.error({ err: e, jobRecordId: record.id }, 'failed to dispatch job to Redis; will be swept');
    }
  }

  /** Re-dispatch records that were persisted but never reached Redis (or were lost with it). Idempotent. */
  async sweepStale(olderThanMs = 30_000, limit = 200): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.db.system((tx) =>
      tx.jobRecord.findMany({ where: { status: 'QUEUED', createdAt: { lt: cutoff } }, take: limit, orderBy: { createdAt: 'asc' } }));
    for (const r of stale) {
      const def = this.defs.get(r.type);
      if (def) await this.dispatch(r, def);
    }
    return stale.length;
  }

  /** Manual retry of a FAILED/DEAD job (operator action). */
  async retry(organisationId: string, userId: string, recordId: string): Promise<JobRecord> {
    const rec = await this.db.tenant({ organisationId, userId }, (tx) => tx.jobRecord.findUnique({ where: { id: recordId } }));
    if (!rec) throw notFound('Job not found');
    if (rec.status !== 'DEAD' && rec.status !== 'FAILED') throw unprocessable('Only failed jobs can be retried', 'job_not_retryable');
    const def = this.defs.get(rec.type);
    if (!def) throw unprocessable('Unknown job type', 'unknown_job_type');
    const updated = await this.db.tenant({ organisationId, userId }, (tx) =>
      tx.jobRecord.update({ where: { id: recordId }, data: { status: 'QUEUED', attempts: 0, error: null, finishedAt: null, progress: 0 } }));
    await (await this.queue(def.queue).getJob(recordId))?.remove().catch(() => undefined);
    await this.dispatch(updated, def);
    return updated;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.connection.disconnect();
  }
}
