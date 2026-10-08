import { JobTypes } from '@uk/contracts';
import type { Tx } from '@uk/db';
import type { JobProducer } from '@uk/jobs';

export interface NotifyInput {
  organisationId: string; userId: string; type: string; title: string; body?: string; entityType?: string; entityId?: string;
}

/** In-app notifications (+ optional e-mail via the notifications queue). Channels are additive, never inline. */
export class NotificationService {
  constructor(private readonly jobs?: JobProducer) {}

  /** Call inside the caller's transaction so the notification commits with the change that caused it. */
  async notify(tx: Tx, n: NotifyInput): Promise<void> {
    await tx.notification.createMany({ data: [{ organisationId: n.organisationId, userId: n.userId, type: n.type, title: n.title, body: n.body ?? '', entityType: n.entityType, entityId: n.entityId }] });
  }

  async email(n: { organisationId: string; to: string; subject: string; text: string; idempotencyKey: string }): Promise<void> {
    if (!this.jobs) throw new Error('NotificationService has no job producer');
    await this.jobs.enqueue(JobTypes.emailSend, { to: n.to, subject: n.subject, text: n.text }, { organisationId: n.organisationId, idempotencyKey: n.idempotencyKey });
  }
}
