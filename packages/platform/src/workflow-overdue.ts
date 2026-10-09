import type { Logger } from '@uk/core';
import type { Database } from '@uk/db';
import { auditRow } from './audit';
import type { NotificationService } from './notifications';

export interface OverdueSweepResult { notified: number; failed: number; abandoned: number }

/** A failing notification is retried with exponential backoff (30 s, 60 s, 120 s ... capped at 1 h) and abandoned after this many attempts. */
export const MAX_OVERDUE_ATTEMPTS = 8;
const backoffSeconds = (attempt: number) => Math.min(3600, 30 * 2 ** (attempt - 1));

/**
 * Sends the one-time "this workflow is overdue" notification (ADR-37). Same safety model as the task-reminder sweeper (ADR-31):
 *  1. the system context lists candidates across tenants (read-only; ids only);
 *  2. each instance is handled in its OWN tenant transaction, claimed with `FOR UPDATE SKIP LOCKED` and re-validated (still open, still past
 *     due, not yet notified), so the notification is delivered exactly once on any number of workers, and commits atomically with
 *     the `overdue_notified_at` marker. A crash or lost connection before COMMIT rolls both back; the next sweep delivers.
 * Failures are counted, backed off and finally abandoned (audited), so one poisoned instance can neither spin nor starve the others.
 * The recipient is the assignee, else whoever started the workflow. The notification carries no workflow content.
 * Changing the due date (WorkflowEngine.setDueDate) re-arms the notification.
 */
export class WorkflowOverdueSweeper {
  constructor(private readonly db: Database, private readonly notifications: NotificationService, private readonly log?: Logger,
    private readonly opts: { batchSize?: number; captureDeviceMetadata?: boolean } = {}) {}

  async sweepOnce(): Promise<OverdueSweepResult> {
    const due = await this.db.system((tx) => tx.$queryRaw<{ id: string; organisation_id: string }[]>`
      SELECT id, organisation_id FROM workflow_instance
       WHERE due_at IS NOT NULL AND completed_at IS NULL AND overdue_notified_at IS NULL AND overdue_attempts < ${MAX_OVERDUE_ATTEMPTS}
         AND coalesce(overdue_retry_at, due_at) <= now() AND due_at <= now()
       ORDER BY coalesce(overdue_retry_at, due_at) LIMIT ${this.opts.batchSize ?? 100}`);
    const result: OverdueSweepResult = { notified: 0, failed: 0, abandoned: 0 };
    for (const d of due) {
      try {
        const outcome = await this.handle(d.id, d.organisation_id);
        if (outcome) result[outcome]++;
      } catch (err) {
        this.log?.error({ err, instanceId: d.id }, 'overdue notification failed; it will be retried with backoff');
        try { result[await this.recordFailure(d.id, d.organisation_id, err)]++; } catch (e2) { this.log?.error({ err: e2, instanceId: d.id }, 'could not record the overdue failure'); }
      }
    }
    return result;
  }

  private recordFailure(instanceId: string, organisationId: string, err: unknown): Promise<'failed' | 'abandoned'> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    return this.db.tenant({ organisationId }, async (tx) => {
      const rows = await tx.$queryRaw<{ attempts: number; company_id: string | null }[]>`
        UPDATE workflow_instance SET overdue_attempts = overdue_attempts + 1, overdue_last_error = ${message}
         WHERE id = ${instanceId}::uuid AND overdue_notified_at IS NULL AND completed_at IS NULL RETURNING overdue_attempts AS attempts, company_id`;
      const row = rows[0];
      if (!row) return 'failed'; // notified or finished in the meantime
      if (row.attempts >= MAX_OVERDUE_ATTEMPTS) {
        await tx.auditEvent.createMany({ data: [auditRow({ action: 'workflow.overdue_notification_failed', outcome: 'FAILURE', organisationId, companyId: row.company_id,
          entityType: 'workflow_instance', entityId: instanceId, sourceWorkflowId: instanceId, metadata: { attempts: row.attempts, lastError: message } }, this.opts.captureDeviceMetadata)] });
        return 'abandoned';
      }
      await tx.$executeRaw`UPDATE workflow_instance SET overdue_retry_at = now() + make_interval(secs => ${backoffSeconds(row.attempts)}::int) WHERE id = ${instanceId}::uuid`;
      return 'failed';
    });
  }

  private handle(instanceId: string, organisationId: string): Promise<'notified' | null> {
    return this.db.tenant({ organisationId }, async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM workflow_instance
         WHERE id = ${instanceId}::uuid AND due_at IS NOT NULL AND due_at <= now() AND completed_at IS NULL AND overdue_notified_at IS NULL
           AND overdue_attempts < ${MAX_OVERDUE_ATTEMPTS} AND coalesce(overdue_retry_at, due_at) <= now()
         FOR UPDATE SKIP LOCKED`;
      if (!claimed.length) return null; // another worker has it, it was finished, or its deadline moved
      const inst = await tx.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
      const recipient = inst.assigneeUserId ?? inst.startedByUserId;
      await this.notifications.notify(tx, { organisationId, userId: recipient, type: 'workflow.overdue', title: 'A workflow is overdue',
        body: 'A workflow you are responsible for is past its deadline.', entityType: 'workflow_instance', entityId: inst.id });
      await tx.$executeRaw`UPDATE workflow_instance SET overdue_notified_at = now(), overdue_last_error = NULL WHERE id = ${instanceId}::uuid`;
      await tx.auditEvent.createMany({ data: [auditRow({ action: 'workflow.overdue_notified', organisationId, companyId: inst.companyId, entityType: 'workflow_instance', entityId: inst.id,
        sourceWorkflowId: inst.id, metadata: { recipientUserId: recipient, dueAt: inst.dueAt?.toISOString() ?? null, workflowType: inst.type } }, this.opts.captureDeviceMetadata)] });
      return 'notified';
    });
  }
}
