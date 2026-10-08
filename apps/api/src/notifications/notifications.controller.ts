import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { paginationSchema } from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Database } from '@uk/db';
import { Org, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

/** A user only ever sees their own notifications (RLS enforces user_id = caller). Any member may read theirs. */
@Controller('organisations/:organisationId/notifications')
export class NotificationsController {
  constructor(@Inject(DB) private readonly db: Database) {}
  private ctx(org: OrgAccess) { return { organisationId: org.organisationId, userId: org.userId }; }

  @Get() @RequirePermissions('org:read')
  async list(@Org() org: OrgAccess, @Query(new ZodPipe(paginationSchema)) q: z.output<typeof paginationSchema>) {
    const rows = await this.db.tenant(this.ctx(org), (tx) => tx.notification.findMany({
      orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  @Get('unread-count') @RequirePermissions('org:read')
  async unread(@Org() org: OrgAccess) { return { count: await this.db.tenant(this.ctx(org), (tx) => tx.notification.count({ where: { readAt: null } })) }; }

  @Post('read-all') @HttpCode(200) @RequirePermissions('org:read')
  async readAll(@Org() org: OrgAccess) {
    return { updated: (await this.db.tenant(this.ctx(org), (tx) => tx.notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } }))).count };
  }

  @Post(':notificationId/read') @HttpCode(200) @RequirePermissions('org:read')
  async read(@Org() org: OrgAccess, @Param('notificationId', ParseUUIDPipe) id: string) {
    const r = await this.db.tenant(this.ctx(org), (tx) => tx.notification.updateMany({ where: { id }, data: { readAt: new Date() } }));
    if (r.count !== 1) throw notFound('Notification not found');
    return { read: true };
  }
}
