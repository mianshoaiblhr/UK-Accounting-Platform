import { Inject, Injectable } from '@nestjs/common';
import { getContext, redact } from '@uk/core';
import type { AuditOutcome, Database, Prisma, Tx } from '@uk/db';
import { DB } from '../common/tokens';

export interface AuditEntry {
  action: string;
  outcome?: AuditOutcome;
  organisationId?: string | null;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  private data(e: AuditEntry): Prisma.AuditEventUncheckedCreateInput {
    const c = getContext();
    return {
      action: e.action, outcome: e.outcome ?? 'SUCCESS',
      organisationId: e.organisationId ?? null, actorUserId: e.actorUserId ?? c?.userId ?? null,
      entityType: e.entityType, entityId: e.entityId,
      ip: c?.ip, userAgent: c?.userAgent, correlationId: c?.correlationId,
      metadata: redact(e.metadata ?? {}) as Prisma.InputJsonValue,
    };
  }

  /**
   * Pass `tx` to write atomically with the business change (preferred). Otherwise a context-appropriate
   * transaction is opened. Audit failures propagate: no unaudited security-relevant action.
   */
  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const data = this.data(entry);
    // createMany => INSERT without RETURNING (the SELECT policy hides pre-tenant rows from system contexts).
    if (tx) { await tx.auditEvent.createMany({ data: [data] }); return; }
    const run = (t: Tx) => t.auditEvent.createMany({ data: [data] });
    if (data.organisationId) await this.db.tenant({ organisationId: data.organisationId, userId: data.actorUserId ?? undefined }, run);
    else if (data.actorUserId) await this.db.asUser(data.actorUserId, run);
    else await this.db.system(run);
  }
}
