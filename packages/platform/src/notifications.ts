import { notificationCategoryOf, type NotificationChannelId } from '@uk/contracts';
import type { Tx } from '@uk/db';
import { InAppChannel, NotificationChannelRegistry } from './notification-channels';

export interface NotifyInput {
  organisationId: string; userId: string; type: string; title: string; body?: string; entityType?: string; entityId?: string;
}

/**
 * The one way to notify a person (ADR-38). Call inside the caller's transaction so the notification commits with the change that caused it.
 *  1. every `inline` channel (in-app) stores the notification right there;
 *  2. for every available `deferred` channel (e-mail) the user has opted into for this notification's category, a delivery is PLANNED in the
 *     same transaction. Nothing is sent here: the worker's NotificationDeliverySweeper executes it (no network I/O inside a business transaction).
 * Default is opt-out of every optional channel, so a user who never touched their preferences gets exactly the in-app notification.
 */
export class NotificationService {
  /** Without a registry only the in-app channel exists (unit tests, sweepers that only need in-app notifications). */
  constructor(readonly channels: NotificationChannelRegistry = new NotificationChannelRegistry().register(new InAppChannel())) {}

  async notify(tx: Tx, n: NotifyInput): Promise<void> {
    const msg = { organisationId: n.organisationId, userId: n.userId, type: n.type, title: n.title, body: n.body ?? '', entityType: n.entityType, entityId: n.entityId };
    let notificationId: string | undefined;
    for (const c of this.channels.inline()) notificationId = await c.store(tx, msg);
    if (!notificationId) throw new Error('no inline notification channel is registered');
    const deferred = this.channels.availableDeferred();
    if (!deferred.length) return;
    const category = notificationCategoryOf(n.type);
    const optedIn = await tx.notificationPreference.findMany({
      where: { organisationId: n.organisationId, userId: n.userId, category, enabled: true, channel: { in: deferred.map((c) => c.id) } }, select: { channel: true },
    });
    const chosen = new Set<NotificationChannelId>(optedIn.map((p) => p.channel as NotificationChannelId));
    const rows = deferred.filter((c) => chosen.has(c.id)).map((c) => ({ organisationId: n.organisationId, notificationId: notificationId!, userId: n.userId, channel: c.id, category, type: n.type, title: n.title }));
    if (rows.length) await tx.notificationDelivery.createMany({ data: rows });
  }
}
