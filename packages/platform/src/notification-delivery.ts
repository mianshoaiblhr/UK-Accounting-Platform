import type { NotificationChannelId } from '@uk/contracts';
import type { Logger } from '@uk/core';
import type { Database } from '@uk/db';
import { auditRow } from './audit';
import type { DeferredChannel, NotificationChannelRegistry } from './notification-channels';

export interface DeliverySweepResult { sent: number; skipped: number; failed: number; abandoned: number }

/** A failing delivery is retried with exponential backoff (30 s, 60 s, 120 s ... capped at 1 h) and abandoned (FAILED, audited) after this many attempts. */
export const MAX_DELIVERY_ATTEMPTS = 8;
const backoffSeconds = (attempt: number) => Math.min(3600, 30 * 2 ** (attempt - 1));

/**
 * Executes planned out-of-band notification deliveries (ADR-38), with the same safety model as the task-reminder sweeper (ADR-31):
 * the system context lists due deliveries (read-only), each one is then handled in its OWN tenant transaction, claimed with
 * `FOR UPDATE SKIP LOCKED` and re-validated - the recipient must still be an active member with a verified e-mail address and the
 * user's opt-in must still stand (a withdrawn consent wins over an earlier plan) - before the channel is called.
 * Delivery is at-least-once: a crash between the provider hand-off and the commit repeats the hand-off, which the channel makes idempotent
 * (the e-mail channel keys its job by the delivery id). Failures are counted, backed off and abandoned so one broken delivery cannot
 * spin or starve newer ones.
 */
export class NotificationDeliverySweeper {
  constructor(private readonly db: Database, private readonly channels: NotificationChannelRegistry, private readonly log?: Logger,
    private readonly opts: { batchSize?: number; captureDeviceMetadata?: boolean } = {}) {}

  async sweepOnce(): Promise<DeliverySweepResult> {
    const due = await this.db.system((tx) => tx.$queryRaw<{ id: string; organisation_id: string }[]>`
      SELECT id, organisation_id FROM notification_delivery
       WHERE status = 'PENDING' AND coalesce(retry_at, created_at) <= now()
       ORDER BY coalesce(retry_at, created_at) LIMIT ${this.opts.batchSize ?? 100}`);
    const result: DeliverySweepResult = { sent: 0, skipped: 0, failed: 0, abandoned: 0 };
    for (const d of due) {
      try {
        const outcome = await this.handle(d.id, d.organisation_id);
        if (outcome) result[outcome]++;
      } catch (err) {
        this.log?.error({ err, deliveryId: d.id }, 'notification delivery failed; it will be retried with backoff');
        try { result[await this.recordFailure(d.id, d.organisation_id, err)]++; } catch (e2) { this.log?.error({ err: e2, deliveryId: d.id }, 'could not record the delivery failure'); }
      }
    }
    return result;
  }

  private recordFailure(deliveryId: string, organisationId: string, err: unknown): Promise<'failed' | 'abandoned'> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    return this.db.tenant({ organisationId }, async (tx) => {
      const rows = await tx.$queryRaw<{ attempts: number; channel: string }[]>`
        UPDATE notification_delivery SET attempts = attempts + 1, last_error = ${message}
         WHERE id = ${deliveryId}::uuid AND status = 'PENDING' RETURNING attempts, channel`;
      const row = rows[0];
      if (!row) return 'failed'; // handled in the meantime
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await tx.$executeRaw`UPDATE notification_delivery SET status = 'FAILED' WHERE id = ${deliveryId}::uuid`;
        await tx.auditEvent.createMany({ data: [auditRow({ action: 'notification.delivery_failed', outcome: 'FAILURE', organisationId, entityType: 'notification_delivery', entityId: deliveryId,
          metadata: { channel: row.channel, attempts: row.attempts, lastError: message } }, this.opts.captureDeviceMetadata)] });
        return 'abandoned';
      }
      await tx.$executeRaw`UPDATE notification_delivery SET retry_at = now() + make_interval(secs => ${backoffSeconds(row.attempts)}::int) WHERE id = ${deliveryId}::uuid`;
      return 'failed';
    });
  }

  private handle(deliveryId: string, organisationId: string): Promise<'sent' | 'skipped' | null> {
    return this.db.tenant({ organisationId }, async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM notification_delivery WHERE id = ${deliveryId}::uuid AND status = 'PENDING' AND coalesce(retry_at, created_at) <= now() FOR UPDATE SKIP LOCKED`;
      if (!claimed.length) return null; // another worker has it
      const d = await tx.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      const skip = async (reason: string) => {
        await tx.$executeRaw`UPDATE notification_delivery SET status = 'SKIPPED', last_error = ${reason} WHERE id = ${deliveryId}::uuid`;
        return 'skipped' as const;
      };
      const channel = this.channels.get(d.channel as NotificationChannelId);
      if (!channel || channel.mode !== 'deferred' || !channel.available) return skip('channel_unavailable');
      const optedIn = await tx.notificationPreference.findFirst({ where: { organisationId, userId: d.userId, channel: d.channel, category: d.category, enabled: true } });
      if (!optedIn) return skip('preference_withdrawn');
      const member = await tx.organisationMembership.findFirst({ where: { organisationId, userId: d.userId, status: 'ACTIVE' }, select: { id: true } });
      const user = member ? await tx.user.findUnique({ where: { id: d.userId }, select: { email: true, displayName: true, status: true, emailVerifiedAt: true } }) : null;
      if (!member || !user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) return skip('recipient_unavailable');
      await (channel as DeferredChannel).send({ deliveryId, organisationId, userId: d.userId, type: d.type, title: d.title, recipient: { email: user.email, displayName: user.displayName } });
      await tx.$executeRaw`UPDATE notification_delivery SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = ${deliveryId}::uuid`;
      return 'sent';
    });
  }
}
