import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { auditQuerySchema } from '@uk/contracts';
import type { Database } from '@uk/db';
import { Auth, Org, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import { ZodPipe } from '../common/zod.pipe';
import type { AuthInfo, OrgAccess } from '../common/types';

const querySchema = auditQuerySchema;

@Controller()
export class AuditController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('organisations/:organisationId/audit-events')
  @RequirePermissions('audit:read')
  async list(@Org() org: OrgAccess, @Query(new ZodPipe(querySchema)) q: z.output<typeof querySchema>) {
    // The audit trail follows per-company access: a company-level auditor sees that company's events only; organisation-level
    // events (no company) need audit:read on the organisation role.
    const visible = await org.access.companyWhere('audit:read');
    const rows = await this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) =>
      tx.auditEvent.findMany({
        where: {
          organisationId: org.organisationId, AND: [visible, q.companyId ? { companyId: q.companyId } : {}],
          ...(q.action ? { action: q.action } : {}), ...(q.entityType ? { entityType: q.entityType } : {}), ...(q.entityId ? { entityId: q.entityId } : {}),
          ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}), ...(q.outcome ? { outcome: q.outcome } : {}), ...(q.sourceWorkflowId ? { sourceWorkflowId: q.sourceWorkflowId } : {}),
          ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  /** The caller's own login/security history (pre-tenant events). */
  @Get('auth/login-history')
  async loginHistory(@Auth() auth: AuthInfo) {
    const rows = await this.db.asUser(auth.userId, (tx) =>
      tx.auditEvent.findMany({
        where: { organisationId: null, actorUserId: auth.userId }, orderBy: { occurredAt: 'desc' }, take: 50,
        select: { id: true, occurredAt: true, action: true, outcome: true, ip: true, userAgent: true },
      }));
    return { items: rows };
  }
}
