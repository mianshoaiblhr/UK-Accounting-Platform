import type { DomainEvent } from '@uk/contracts';
import type { Logger } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import { OutOfOrderEventError } from './outbox';

export interface ConsumerContext { event: DomainEvent; tx: Tx; log: Logger }
export type ConsumerHandler = (ctx: ConsumerContext) => Promise<void>;

interface Subscription { consumer: string; types: string[] | '*'; handler: ConsumerHandler }

/**
 * Consumer side. Each consumer has a stable name; (event, consumer) is recorded in `event_consumption` in the
 * SAME transaction as the consumer's own database effects, so redelivery (at-least-once) is harmless:
 * a consumer's work commits exactly once, or rolls back with its marker and is retried.
 */
export class EventBus {
  private readonly subs: Subscription[] = [];
  constructor(private readonly db: Database, private readonly logger: Logger) {}

  subscribe(consumer: string, types: string[] | '*', handler: ConsumerHandler): this {
    if (this.subs.some((s) => s.consumer === consumer)) throw new Error(`Duplicate consumer name ${consumer}`);
    this.subs.push({ consumer, types, handler });
    return this;
  }

  async dispatch(eventId: string): Promise<{ ran: string[]; skipped: string[] }> {
    const row = await this.db.system((tx) => tx.outboxEvent.findUnique({ where: { id: eventId } }));
    if (!row) throw new Error(`event ${eventId} not found`);
    // Defence in depth for per-aggregate ordering (the relay already only publishes an aggregate's head): never run a consumer for an
    // event while an earlier event of the same aggregate is unprocessed. The job retries with backoff until the earlier one completes.
    const blocker = await this.db.system((tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM outbox_event WHERE aggregate_type = ${row.aggregateType} AND aggregate_id = ${row.aggregateId}
         AND seq < ${row.seq} AND processed_at IS NULL ORDER BY seq LIMIT 1`);
    if (blocker.length) throw new OutOfOrderEventError(eventId, blocker[0]!.id);
    const event: DomainEvent = {
      id: row.id, type: row.eventType, version: row.eventVersion, aggregateType: row.aggregateType, aggregateId: row.aggregateId,
      organisationId: row.organisationId, actorUserId: row.actorUserId, occurredAt: row.occurredAt,
      correlationId: row.correlationId, causationId: row.causationId, payload: row.payload,
    };
    const ran: string[] = [], skipped: string[] = [];
    let firstError: unknown;
    for (const s of this.subs.filter((x) => x.types === '*' || x.types.includes(event.type))) {
      try {
        const work = async (tx: Tx) => {
          const marker = await tx.eventConsumption.createMany({ skipDuplicates: true, data: [{ eventId, consumer: s.consumer, organisationId: event.organisationId }] });
          if (marker.count === 0) return false; // already processed
          await s.handler({ event, tx, log: this.logger.child({ consumer: s.consumer, eventId, eventType: event.type }) });
          return true;
        };
        const did = event.organisationId
          ? await this.db.tenant({ organisationId: event.organisationId, userId: event.actorUserId ?? undefined }, work)
          : await this.db.system(work);
        (did ? ran : skipped).push(s.consumer);
      } catch (err) {
        this.logger.error({ consumer: s.consumer, eventId, err: (err as Error).message }, 'event consumer failed');
        firstError ??= err;
      }
    }
    if (firstError) throw firstError; // job retries; consumers that already committed are skipped next time
    // Every consumer has committed: the event is processed and the next event of its aggregate may now be published.
    await this.db.system((tx) => tx.outboxEvent.updateMany({ where: { id: eventId, status: 'PUBLISHED', processedAt: null }, data: { processedAt: new Date() } }));
    return { ran, skipped };
  }
}
