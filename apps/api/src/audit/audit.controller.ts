import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationSchema } from '@uk/contracts';
import type { Database } from '@uk/db';
import { Auth, Org, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import { ZodPipe } from '../common/zod.pipe';
import type { AuthInfo, OrgAccess } from '../common/types';

const querySchema = paginationSchema.extend({ action: z.string().max(100).optional(), entityType: z.string().max(60).optional() });

@Controller()
export class AuditController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('organisations/:organisationId/audit-events')
  @RequirePermissions('audit:read')
  async list(@Org() org: OrgAccess, @Query(new ZodPipe(querySchema)) q: z.output<typeof querySchema>) {
    const rows = await this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) =>
      tx.auditEvent.findMany({
        where: { organisationId: org.organisationId, ...(q.action ? { action: q.action } : {}), ...(q.entityType ? { entityType: q.entityType } : {}) },
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
