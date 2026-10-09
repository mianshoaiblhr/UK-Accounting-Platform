import type { z, ZodTypeAny } from 'zod';
import { JobTypes, type EventDefinition } from '@uk/contracts';
import { getContext, getCorrelationId, unprocessable, uuidv7, type Logger } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import type { JobProducer } from '@uk/jobs';

export interface PublishInput<S extends ZodTypeAny> {
  aggregateId: string;
  organisationId?: string | null;
  payload: z.input<S>;
  actorUserId?: string | null;
  /** Business idempotency: publishing the same key twice stores a single event. */
  idempotencyKey?: string;
  causationId?: string;
}

/**
 * Transactional outbox, producer side. Call this INSIDE the same transaction that changes business data:
 * the event row commits (or rolls back) atomically with the change, so an event can never be lost or
 * emitted for a change that did not happen. A relay later delivers it (see OutboxRelay).
 */
export async function publishEvent<S extends ZodTypeAny>(tx: Tx, def: EventDefinition<S>, input: PublishInput<S>): Promise<string> {
  const parsed = def.schema.safeParse(input.payload);
  if (!parsed.success) throw unprocessable(`Invalid payload for event ${def.type}`, 'invalid_event_payload', parsed.error.flatten());
  const id = uuidv7();
  const ctx = getContext();
  // createMany => INSERT ... ON CONFLICT DO NOTHING without RETURNING (idempotency key, RLS-safe).
  await tx.outboxEvent.createMany({
    skipDuplicates: true,
    data: [{
      id, eventType: def.type, eventVersion: def.version, aggregateType: def.aggregateType, aggregateId: input.aggregateId,
      organisationId: input.organisationId ?? ctx?.organisationId ?? null, actorUserId: input.actorUserId ?? ctx?.userId ?? null,
      payload: parsed.data as never, correlationId: getCorrelationId(), causationId: input.causationId,
      idempotencyKey: input.idempotencyKey,
    }],
  });
  return id;
}

export interface OutboxRow { id: string; eventType: string; organisationId: string | null; correlationId: string; retryCount: number }
export type Dispatcher = (row: OutboxRow) => Promise<void>;

/** Default dispatcher: durable, idempotent hand-off to the BullMQ `events` queue (job id derived from event id). */
export const dispatchViaJobs = (jobs: JobProducer): Dispatcher => async (row) => {
  await jobs.enqueue(JobTypes.eventDispatch, { eventId: row.id }, {
    organisationId: row.organisationId ?? undefined, idempotencyKey: `event:${row.id}`, correlationId: row.correlationId,
  });
};

export interface RelayOptions { batchSize?: number; maxRetries?: number }

export interface OutboxStats {
  pending: number; failed: number;
  /** Handed to the queue but not yet fully consumed. */
  inFlight: number;
  /** Age (seconds) of the oldest event that is not yet processed - the "outbox lag". 0 when nothing is waiting. */
  oldestUnprocessedAgeSeconds: number;
  oldestPendingAgeSeconds: number;
  processedTotal: number;
}

/** Thrown by the consumer side when an earlier event of the same aggregate has not been processed yet (retryable). */
export class OutOfOrderEventError extends Error {
  readonly code = 'outbox_out_of_order';
  constructor(readonly eventId: string, readonly blockedBy: string) { super(`event ${eventId} must wait for earlier event ${blockedBy} of the same aggregate`); }
}

/**
 * Outbox relay (publisher). Claims due PENDING rows with FOR UPDATE SKIP LOCKED (safe with many workers),
 * hands each to the dispatcher, then marks it PUBLISHED.

 * ORDERING: only the HEAD event of an aggregate is eligible - an event is skipped while any earlier event (lower seq) of the
 * same aggregate is not processed (PENDING backing off, FAILED awaiting replay, or published but still being consumed).
 * Aggregates are independent, so one stuck aggregate never blocks the others. A failed hand-off keeps the row PENDING with an
 * incremented retry_count, the error, and exponential backoff; after maxRetries it becomes FAILED (alerts +
 * operator replay). Delivery is at-least-once; consumers are idempotent (see EventBus).
 */
export class OutboxRelay {
  constructor(private readonly db: Database, private readonly dispatch: Dispatcher, private readonly logger: Logger, private readonly opts: RelayOptions = {}) {}

  async relayOnce(): Promise<{ published: number; failed: number; deadLettered: number }> {
    const batch = this.opts.batchSize ?? 50, maxRetries = this.opts.maxRetries ?? 10;
    return this.db.system(async (tx) => {
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT e.id FROM outbox_event e
         WHERE e.status = 'PENDING' AND e.next_attempt_at <= now()
           AND NOT EXISTS (SELECT 1 FROM outbox_event p
                            WHERE p.aggregate_type = e.aggregate_type AND p.aggregate_id = e.aggregate_id
                              AND p.seq < e.seq AND p.processed_at IS NULL)
         ORDER BY e.seq LIMIT ${batch} FOR UPDATE OF e SKIP LOCKED`;
      let published = 0, failed = 0, deadLettered = 0;
      for (const { id } of ids) {
        const row = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
        try {
          await this.dispatch({ id, eventType: row.eventType, organisationId: row.organisationId, correlationId: row.correlationId, retryCount: row.retryCount });
          await tx.outboxEvent.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date(), lastError: null } });
          published++;
        } catch (err) {
          const retryCount = row.retryCount + 1;
          const dead = retryCount >= maxRetries;
          const backoffMs = Math.min(1000 * 2 ** retryCount, 5 * 60_000);
          await tx.outboxEvent.update({
            where: { id },
            data: { retryCount, lastError: String((err as Error).message ?? err).slice(0, 2000), nextAttemptAt: new Date(Date.now() + backoffMs), status: dead ? 'FAILED' : 'PENDING' },
          });
          failed++; if (dead) deadLettered++;
          this.logger.error({ eventId: id, eventType: row.eventType, retryCount, dead, err: (err as Error).message }, 'outbox publish failed');
        }
      }
      return { published, failed, deadLettered };
    });
  }

  /** Backlog and lag figures for metrics, alarms and readiness. Cheap (indexed) and tenant-agnostic. */
  async stats(): Promise<OutboxStats> {
    const [r] = await this.db.system((tx) => tx.$queryRaw<{ pending: bigint; failed: bigint; in_flight: bigint; oldest_unprocessed: number | null; oldest_pending: number | null; processed: bigint }[]>`
      SELECT count(*) FILTER (WHERE status = 'PENDING') AS pending,
             count(*) FILTER (WHERE status = 'FAILED') AS failed,
             count(*) FILTER (WHERE status = 'PUBLISHED' AND processed_at IS NULL) AS in_flight,
             extract(epoch FROM now() - min(created_at) FILTER (WHERE processed_at IS NULL))::float8 AS oldest_unprocessed,
             extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'PENDING'))::float8 AS oldest_pending,
             count(*) FILTER (WHERE processed_at IS NOT NULL) AS processed
        FROM outbox_event`);
    return {
      pending: Number(r!.pending), failed: Number(r!.failed), inFlight: Number(r!.in_flight),
      oldestUnprocessedAgeSeconds: Math.max(0, r!.oldest_unprocessed ?? 0), oldestPendingAgeSeconds: Math.max(0, r!.oldest_pending ?? 0),
      processedTotal: Number(r!.processed),
    };
  }

  /**
   * Retention: deletes events processed more than `retentionDays` ago (and their consumer markers), in bounded batches.
   * A database trigger guarantees an unprocessed event can never be deleted, whatever its age.
   */
  async cleanup(retentionDays: number, batchSize = 1000): Promise<number> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retentionDays must be an integer >= 1');
    let total = 0;
    for (;;) {
      const n = await this.db.system(async (tx) => {
        const ids = await tx.$queryRaw<{ id: string }[]>`
          DELETE FROM outbox_event WHERE id IN (
            SELECT id FROM outbox_event WHERE processed_at IS NOT NULL AND processed_at < now() - make_interval(days => ${retentionDays}::int)
            ORDER BY processed_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED)
          RETURNING id`;
        if (ids.length) await tx.eventConsumption.deleteMany({ where: { eventId: { in: ids.map((r) => r.id) } } });
        return ids.length;
      });
      total += n;
      if (n < batchSize) return total;
    }
  }

  /** Operator action: put FAILED events back in the queue. */
  async replayFailed(): Promise<number> {
    return this.db.system(async (tx) => (await tx.outboxEvent.updateMany({ where: { status: 'FAILED' }, data: { status: 'PENDING', retryCount: 0, nextAttemptAt: new Date() } })).count);
  }
}
