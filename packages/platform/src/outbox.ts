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

/**
 * Outbox relay (publisher). Claims due PENDING rows with FOR UPDATE SKIP LOCKED (safe with many workers),
 * hands each to the dispatcher, then marks it PUBLISHED. A failed hand-off keeps the row PENDING with an
 * incremented retry_count, the error, and exponential backoff; after maxRetries it becomes FAILED (alerts +
 * operator replay). Delivery is at-least-once; consumers are idempotent (see EventBus).
 */
export class OutboxRelay {
  constructor(private readonly db: Database, private readonly dispatch: Dispatcher, private readonly logger: Logger, private readonly opts: RelayOptions = {}) {}

  async relayOnce(): Promise<{ published: number; failed: number; deadLettered: number }> {
    const batch = this.opts.batchSize ?? 50, maxRetries = this.opts.maxRetries ?? 10;
    return this.db.system(async (tx) => {
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM outbox_event WHERE status = 'PENDING' AND next_attempt_at <= now()
        ORDER BY created_at LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
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

  /** Operator action: put FAILED events back in the queue. */
  async replayFailed(): Promise<number> {
    return this.db.system(async (tx) => (await tx.outboxEvent.updateMany({ where: { status: 'FAILED' }, data: { status: 'PENDING', retryCount: 0, nextAttemptAt: new Date() } })).count);
  }
}
