import { JobTypes, NOTIFICATION_CHANNELS, parseNotificationChannels, type NotificationChannelId } from '@uk/contracts';
import { uuidv7, type AppConfig } from '@uk/core';
import type { Tx } from '@uk/db';
import type { JobProducer } from '@uk/jobs';

/**
 * Notification channel port (ADR-38). A channel is how a notification reaches a person. Two shapes, because one of them must never do
 * network I/O inside a business transaction:
 *  - `inline` channels store the notification in the caller's own transaction (in-app);
 *  - `deferred` channels are planned in that transaction (a `notification_delivery` row) and executed later by the worker
 *    (`NotificationDeliverySweeper`) through `send`.
 * Stub channels (sms, whatsapp) are registered but `available = false`: they cannot be selected, planned or delivered to.
 */
export interface ChannelMessage { notificationId: string; organisationId: string; userId: string; type: string; title: string; body: string; entityType?: string; entityId?: string }

export interface InlineChannel {
  readonly id: NotificationChannelId;
  readonly mode: 'inline';
  readonly available: true;
  /** Stores the message in the caller's transaction and returns the notification id. */
  store(tx: Tx, m: Omit<ChannelMessage, 'notificationId'>): Promise<string>;
}

export interface DeferredDelivery { deliveryId: string; organisationId: string; userId: string; type: string; title: string; recipient: { email: string; displayName: string } }

export interface DeferredChannel {
  readonly id: NotificationChannelId;
  readonly mode: 'deferred';
  readonly available: boolean;
  /** Hands the delivery to the provider. Must be safe to repeat for the same `deliveryId` (the sweeper is at-least-once). */
  send(d: DeferredDelivery): Promise<void>;
}

export type NotificationChannel = InlineChannel | DeferredChannel;

export class InAppChannel implements InlineChannel {
  readonly id = 'in_app' as const;
  readonly mode = 'inline' as const;
  readonly available = true as const;
  async store(tx: Tx, m: Omit<ChannelMessage, 'notificationId'>): Promise<string> {
    // The id is generated here and the row inserted without RETURNING: the recipient-private SELECT policy would (rightly) refuse to hand the
    // row back to a request running as somebody else, which is exactly who notifies people.
    const id = uuidv7();
    await tx.notification.createMany({ data: [{ id, organisationId: m.organisationId, userId: m.userId, type: m.type, title: m.title, body: m.body, entityType: m.entityType, entityId: m.entityId }] });
    return id;
  }
}

/**
 * E-mail: hands off to the existing `email.send` job, keyed by the delivery id so a repeated hand-off (crash between enqueue and commit) is
 * deduplicated by the job runtime, which also owns retries, backoff and dead-lettering. Content is deliberately minimal: the title and a
 * prompt to sign in. Notification bodies can contain task titles and are never e-mailed.
 */
export class EmailChannel implements DeferredChannel {
  readonly id = 'email' as const;
  readonly mode = 'deferred' as const;
  readonly available = true;
  constructor(private readonly jobs: Pick<JobProducer, 'enqueue'>) {}
  async send(d: DeferredDelivery): Promise<void> {
    await this.jobs.enqueue(JobTypes.emailSend, { to: d.recipient.email, subject: d.title, text: `${d.title}\n\nSign in to the platform to see the details.\n` },
      { organisationId: d.organisationId, idempotencyKey: `notification-delivery:${d.deliveryId}` });
  }
}

/** Documented stub for a channel that is not implemented (SMS, WhatsApp): visible in the registry, never available, fails loudly if reached. */
export class UnavailableChannel implements DeferredChannel {
  readonly mode = 'deferred' as const;
  readonly available = false;
  constructor(readonly id: NotificationChannelId) {}
  async send(): Promise<void> { throw new Error(`notification channel "${this.id}" is not implemented`); }
}

export class NotificationChannelRegistry {
  private readonly channels = new Map<NotificationChannelId, NotificationChannel>();
  register(c: NotificationChannel): this {
    if (this.channels.has(c.id)) throw new Error(`notification channel ${c.id} already registered`);
    this.channels.set(c.id, c);
    return this;
  }
  get(id: NotificationChannelId): NotificationChannel | undefined { return this.channels.get(id); }
  inline(): InlineChannel[] { return [...this.channels.values()].filter((c): c is InlineChannel => c.mode === 'inline'); }
  /** Deferred channels that can be delivered to (the ones a user can opt into). */
  availableDeferred(): DeferredChannel[] { return [...this.channels.values()].filter((c): c is DeferredChannel => c.mode === 'deferred' && c.available); }
  /** Every declared channel with its availability (what the preferences API shows). */
  list(): { channel: NotificationChannelId; available: boolean }[] {
    return NOTIFICATION_CHANNELS.map((channel) => ({ channel, available: this.channels.get(channel)?.available ?? false }));
  }
}

/** The registry for a configuration: `in_app` always; `email` unless left out of NOTIFICATION_CHANNELS; sms/whatsapp as unavailable stubs. */
export function createNotificationChannels(config: Pick<AppConfig, 'NOTIFICATION_CHANNELS'>, jobs?: Pick<JobProducer, 'enqueue'>): NotificationChannelRegistry {
  const enabled = parseNotificationChannels(config.NOTIFICATION_CHANNELS);
  const r = new NotificationChannelRegistry().register(new InAppChannel());
  if (enabled.includes('email')) {
    if (!jobs) throw new Error('the e-mail notification channel needs a job producer');
    r.register(new EmailChannel(jobs));
  } else r.register(new UnavailableChannel('email'));
  r.register(new UnavailableChannel('sms')).register(new UnavailableChannel('whatsapp'));
  return r;
}
