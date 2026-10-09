import type { Logger } from '@uk/core';
import type { Database } from '@uk/db';
import { auditRow } from './audit';
import type { NotificationService } from './notifications';

export interface ReminderSweepResult { sent: number; cancelled: number }

/**
 * Delivers due task reminders. Safe to run on any number of workers at once and to re-run after a crash:
 *  1. the system context lists due reminders across tenants (read-only);
 *  2. each reminder is then handled in its OWN tenant transaction, claimed with `FOR UPDATE SKIP LOCKED` and re-validated,
 *     so a reminder is delivered exactly once and the notification commits atomically with the `sent_at` marker.
 * The notification deliberately carries no task content: access may have changed since the reminder was set, and opening the
 * task goes through the normal per-company authorisation.
 */
export class TaskReminderSweeper {
  constructor(private readonly db: Database, private readonly notifications: NotificationService, private readonly log?: Logger,
    private readonly opts: { batchSize?: number; captureDeviceMetadata?: boolean } = {}) {}

  async sweepOnce(): Promise<ReminderSweepResult> {
    const due = await this.db.system((tx) => tx.$queryRaw<{ id: string; organisation_id: string }[]>`
      SELECT id, organisation_id FROM task_reminder
       WHERE sent_at IS NULL AND cancelled_at IS NULL AND remind_at <= now()
       ORDER BY remind_at LIMIT ${this.opts.batchSize ?? 100}`);
    const result: ReminderSweepResult = { sent: 0, cancelled: 0 };
    for (const d of due) {
      try {
        const outcome = await this.handle(d.id, d.organisation_id);
        if (outcome) result[outcome]++;
      } catch (err) {
        this.log?.error({ err, reminderId: d.id }, 'task reminder failed; will be retried by the next sweep');
      }
    }
    return result;
  }

  private handle(reminderId: string, organisationId: string): Promise<'sent' | 'cancelled' | null> {
    return this.db.tenant({ organisationId }, async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM task_reminder WHERE id = ${reminderId}::uuid AND sent_at IS NULL AND cancelled_at IS NULL AND remind_at <= now()
         FOR UPDATE SKIP LOCKED`;
      if (!claimed.length) return null; // another worker has it, or it was cancelled meanwhile
      const reminder = await tx.taskReminder.findUniqueOrThrow({ where: { id: reminderId } });
      const task = await tx.task.findUnique({ where: { id: reminder.taskId } });
      if (!task || task.status === 'DONE' || task.status === 'CANCELLED') {
        await tx.taskReminder.update({ where: { id: reminderId }, data: { cancelledAt: new Date() } });
        return 'cancelled';
      }
      await this.notifications.notify(tx, { organisationId, userId: reminder.recipientUserId, type: 'task.reminder', title: 'Task reminder',
        body: 'A task you asked to be reminded about needs attention.', entityType: 'task', entityId: task.id });
      await tx.taskReminder.update({ where: { id: reminderId }, data: { sentAt: new Date() } });
      await tx.auditEvent.createMany({ data: [auditRow({ action: 'task.reminder_sent', organisationId, companyId: task.companyId, entityType: 'task', entityId: task.id,
        metadata: { reminderId, recipientUserId: reminder.recipientUserId } }, this.opts.captureDeviceMetadata)] });
      return 'sent';
    });
  }
}
