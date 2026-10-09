import { getContext, redact } from '@uk/core';
import type { AuditOutcome, Prisma } from '@uk/db';

/**
 * One audit record. `before`/`after` carry ONLY the fields that changed (see {@link changeSet}); both are redacted and
 * size-bounded here, so no caller can leak a secret or write an unbounded blob through the audit trail.
 */
export interface AuditEntry {
  action: string;
  outcome?: AuditOutcome;
  organisationId?: string | null;
  /** Company the event concerns (drives per-company visibility of the audit trail). */
  companyId?: string | null;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Why the action was taken (free text from the actor, e.g. the reason for removing access). */
  reason?: string | null;
  /** The workflow instance this action was performed as part of, if any. */
  sourceWorkflowId?: string | null;
}

const MAX_SNAPSHOT_BYTES = 16 * 1024;
const MAX_REASON = 1000;

function snapshot(v: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  if (v === null || v === undefined) return undefined;
  const clean = redact(JSON.parse(JSON.stringify(v)) as Record<string, unknown>); // drops Dates/undefined into JSON-safe values
  const size = Buffer.byteLength(JSON.stringify(clean));
  if (size > MAX_SNAPSHOT_BYTES) return { _truncated: true, bytes: size, fields: Object.keys(clean) };
  return clean as Prisma.InputJsonValue;
}

/**
 * Builds the row. `captureDeviceMetadata=false` drops IP address and user agent (data-minimisation where the lawful basis
 * for keeping them does not hold); actor, action, entity, time and correlation id are always kept.
 */
export function auditRow(e: AuditEntry, captureDeviceMetadata = true): Prisma.AuditEventUncheckedCreateInput {
  const c = getContext();
  return {
    action: e.action, outcome: e.outcome ?? 'SUCCESS',
    organisationId: e.organisationId ?? null, companyId: e.companyId ?? null, actorUserId: e.actorUserId ?? c?.userId ?? null,
    entityType: e.entityType, entityId: e.entityId,
    ip: captureDeviceMetadata ? c?.ip : undefined, userAgent: captureDeviceMetadata ? c?.userAgent : undefined, correlationId: c?.correlationId,
    metadata: redact(e.metadata ?? {}) as Prisma.InputJsonValue,
    before: snapshot(e.before), after: snapshot(e.after),
    reason: e.reason ? e.reason.slice(0, MAX_REASON) : undefined,
    sourceWorkflowId: e.sourceWorkflowId ?? undefined,
  };
}

/** The changed subset of `keys` between two states: `{ before: {k: old}, after: {k: new} }`. Equal values are omitted. */
export function changeSet<T extends Record<string, unknown>>(before: T, after: T, keys: readonly (keyof T & string)[]): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {}, a: Record<string, unknown> = {};
  const same = (x: unknown, y: unknown) => JSON.stringify(x instanceof Date ? x.toISOString() : x) === JSON.stringify(y instanceof Date ? y.toISOString() : y);
  for (const k of keys) if (!same(before[k], after[k])) { b[k] = before[k]; a[k] = after[k]; }
  return { before: b, after: a };
}
