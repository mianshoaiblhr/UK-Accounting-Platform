import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import { auditRow, type AuditEntry } from '@uk/platform';
import { CONFIG, DB } from '../common/tokens';

export type { AuditEntry };

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig) {}

  /**
   * Pass `tx` to write atomically with the business change (preferred). Otherwise a context-appropriate
   * transaction is opened. Audit failures propagate: no unaudited security-relevant action.
   */
  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const data = auditRow(entry, this.config.AUDIT_CAPTURE_DEVICE_METADATA);
    // createMany => INSERT without RETURNING (the SELECT policy hides pre-tenant rows from system contexts).
    if (tx) { await tx.auditEvent.createMany({ data: [data] }); return; }
    const run = (t: Tx) => t.auditEvent.createMany({ data: [data] });
    if (data.organisationId) await this.db.tenant({ organisationId: data.organisationId, userId: data.actorUserId ?? undefined }, run);
    else if (data.actorUserId) await this.db.asUser(data.actorUserId, run);
    else await this.db.system(run);
  }
}
