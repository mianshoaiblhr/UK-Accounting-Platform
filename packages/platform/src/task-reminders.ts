import type { Logger } from '@uk/core';
import type { Database } from '@uk/db';
import { auditRow } from './audit';
import type { NotificationService } from './notifications';

export interface ReminderSweepResult { sent: number; cancelled: number; failed: number; abandoned: number }

/** A failing reminder is retried with exponential backoff (30 s, 60 s, 120 s ... capped at 1 h) and abandoned after this many attempts. */
export const MAX_REMINDER_ATTEMPTS = 8;
const backoffSeconds = (attempt: number) => Math.min(3600, 30 * 2 ** (attempt - 1));

/**
 * Delivers due task reminders. Safe to run on any number of workers at once and to re-run after a crash:
 *  1. the system context lists due reminders across tenants (read-only);
 *  2. each reminder is then handled in its OWN tenant transaction, claimed with `FOR UPDATE SKIP LOCKED` and re-validated,
 *     so a reminder is delivered exactly once and the notification commits atomically with the `sent_at` marker.
 * A crash (or lost connection) anywhere before COMMIT rolls back the notification and the marker together, so the reminder simply stays
 * pending and the lock disappears with the connection; the next sweep delivers it. Failures are counted and backed off so a poisoned
 * reminder can neither spin nor starve newer ones.
 * The notification deliberately carries no task content: access may have changed since the reminder was set, and opening the
 * task goes through the normal per-company authorisation.
 */
export class TaskReminderSweeper {
  constructor(private readonly db: Database, private readonly notifications: NotificationService, private readonly log?: Logger,
    private readonly opts: { batchSize?: number; captureDeviceMetadata?: boolean } = {}) {}

  async sweepOnce(): Promise<ReminderSweepResult> {
    const due = await this.db.system((tx) => tx.$queryRaw<{ id: string; organisation_id: string }[]>`
      SELECT id, organisation_id FROM task_reminder
       WHERE sent_at IS NULL AND cancelled_at IS NULL AND coalesce(retry_at, remind_at) <= now()
       ORDER BY coalesce(retry_at, remind_at) LIMIT ${this.opts.batchSize ?? 100}`);
    const result: ReminderSweepResult = { sent: 0, cancelled: 0, failed: 0, abandoned: 0 };
    for (const d of due) {
      try {
        const outcome = await this.handle(d.id, d.organisation_id);
        if (outcome) result[outcome]++;
      } catch (err) {
        this.log?.error({ err, reminderId: d.id }, 'task reminder failed; it will be retried with backoff');
        try { result[await this.recordFailure(d.id, d.organisation_id, err)]++; } catch (e2) { this.log?.error({ err: e2, reminderId: d.id }, 'could not record the reminder failure'); }
      }
    }
    return result;
  }

  /** Runs in its own transaction because the failed one rolled back. Abandons the reminder (cancelled, error kept) after too many attempts. */
  private recordFailure(reminderId: string, organisationId: string, err: unknown): Promise<'failed' | 'abandoned'> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    return this.db.tenant({ organisationId }, async (tx) => {
      const rows = await tx.$queryRaw<{ attempts: number }[]>`
        UPDATE task_reminder SET attempts = attempts + 1, last_error = ${message}
         WHERE id = ${reminderId}::uuid AND sent_at IS NULL AND cancelled_at IS NULL RETURNING attempts`;
      const attempts = rows[0]?.attempts;
      if (attempts === undefined) return 'failed'; // sent or cancelled in the meantime
      if (attempts >= MAX_REMINDER_ATTEMPTS) {
        const r = await tx.taskReminder.update({ where: { id: reminderId }, data: { cancelledAt: new Date() } });
        await tx.auditEvent.createMany({ data: [auditRow({ action: 'task.reminder_failed', outcome: 'FAILURE', organisationId, entityType: 'task', entityId: r.taskId,
          metadata: { reminderId, attempts, lastError: message } }, this.opts.captureDeviceMetadata)] });
        return 'abandoned';
      }
      await tx.$executeRaw`UPDATE task_reminder SET retry_at = now() + make_interval(secs => ${backoffSeconds(attempts)}::int) WHERE id = ${reminderId}::uuid`;
      return 'failed';
    });
  }

  private handle(reminderId: string, organisationId: string): Promise<'sent' | 'cancelled' | null> {
    return this.db.tenant({ organisationId }, async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM task_reminder WHERE id = ${reminderId}::uuid AND sent_at IS NULL AND cancelled_at IS NULL AND coalesce(retry_at, remind_at) <= now()
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
