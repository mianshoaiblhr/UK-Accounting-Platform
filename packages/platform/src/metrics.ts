import { createLogger, type MetricsRegistry } from '@uk/core';
import type { Database } from '@uk/db';
import { OutboxRelay } from './outbox';

export interface PlatformSnapshot {
  outbox: { pending: number; failed: number; inFlight: number; oldestUnprocessedAgeSeconds: number };
  jobs: Record<string, number>;
  remindersDue: number;
  databaseMs: number;
}

/**
 * Aggregate platform state for metrics and readiness (ADR-35): outbox backlog and lag, job counts by status, due task reminders.
 * Counts only - no tenant data, no ids. Runs in the trusted system context (cross-tenant aggregates), read-only, indexed queries.
 */
export async function collectPlatformSnapshot(db: Database): Promise<PlatformSnapshot> {
  const t0 = process.hrtime.bigint();
  const outbox = await new OutboxRelay(db, async () => undefined, createLogger('silent')).stats();
  const { jobs, remindersDue } = await db.system(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string; n: bigint }[]>`SELECT status::text AS status, count(*) AS n FROM job_record WHERE status IN ('QUEUED','RUNNING','RETRYING','FAILED','DEAD') GROUP BY status`;
    const due = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM task_reminder WHERE sent_at IS NULL AND cancelled_at IS NULL AND coalesce(retry_at, remind_at) <= now()`;
    return { jobs: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])), remindersDue: Number(due[0]?.n ?? 0) };
  });
  return {
    outbox: { pending: outbox.pending, failed: outbox.failed, inFlight: outbox.inFlight, oldestUnprocessedAgeSeconds: outbox.oldestUnprocessedAgeSeconds },
    jobs, remindersDue, databaseMs: Number(process.hrtime.bigint() - t0) / 1e6,
  };
}

/** Writes a snapshot into the registry as gauges. Statuses with no jobs are exported as 0 so alarms see a value, not missing data. */
export function applySnapshot(reg: MetricsRegistry, s: PlatformSnapshot): void {
  reg.set('outbox_pending', 'Outbox events waiting to be published', s.outbox.pending);
  reg.set('outbox_failed', 'Outbox events that gave up (FAILED) and need an operator', s.outbox.failed);
  reg.set('outbox_in_flight', 'Outbox events published but not yet processed by every consumer', s.outbox.inFlight);
  reg.set('outbox_oldest_unprocessed_seconds', 'Age of the oldest unprocessed outbox event (outbox lag)', s.outbox.oldestUnprocessedAgeSeconds, {}, 'Seconds');
  for (const status of ['QUEUED', 'RUNNING', 'RETRYING', 'FAILED', 'DEAD']) reg.set('jobs', 'Background jobs by status', s.jobs[status] ?? 0, { status });
  reg.set('task_reminders_due', 'Task reminders due and not yet delivered', s.remindersDue);
  reg.set('platform_snapshot_duration_ms', 'Time to collect the platform snapshot', s.databaseMs, {}, 'Milliseconds');
}

export async function collectPlatformMetrics(db: Database, reg: MetricsRegistry): Promise<PlatformSnapshot> {
  const snap = await collectPlatformSnapshot(db);
  applySnapshot(reg, snap);
  return snap;
}
