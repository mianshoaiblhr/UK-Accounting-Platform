import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { MANDATORY_NOTIFICATION_CHANNELS, NOTIFICATION_CATEGORIES, paginationSchema, setNotificationPreferenceSchema } from '@uk/contracts';
import { notFound, unprocessable } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import type { NotificationChannelRegistry } from '@uk/platform';
import { AuditService } from '../audit/audit.service';
import { Org, RequirePermissions } from '../common/decorators';
import { DB, NOTIFICATION_CHANNELS } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

/** A user only ever sees their own notifications (RLS enforces user_id = caller). Any member may read theirs. */
@Controller('organisations/:organisationId/notifications')
export class NotificationsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(NOTIFICATION_CHANNELS) private readonly channels: NotificationChannelRegistry, private readonly audit: AuditService) {}
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

  /** The caller's channel preferences (ADR-38). Optional channels are opt-in; in_app is mandatory; unavailable channels are listed but cannot be enabled. */
  @Get('preferences') @RequirePermissions('org:read')
  preferences(@Org() org: OrgAccess) { return this.db.tenant(this.ctx(org), (tx) => this.preferenceView(tx, org)); }

  @Put('preferences') @HttpCode(200) @RequirePermissions('org:read')
  async setPreference(@Org() org: OrgAccess, @Body(new ZodPipe(setNotificationPreferenceSchema)) b: z.output<typeof setNotificationPreferenceSchema>) {
    if (MANDATORY_NOTIFICATION_CHANNELS.includes(b.channel)) {
      if (!b.enabled) throw unprocessable('The in-app channel cannot be switched off', 'channel_mandatory');
      return this.db.tenant(this.ctx(org), (tx) => this.preferenceView(tx, org)); // already on, nothing to store
    }
    if (b.enabled && !this.channels.list().find((c) => c.channel === b.channel)?.available) throw unprocessable(`The ${b.channel} channel is not available`, 'channel_unavailable');
    return this.db.tenant(this.ctx(org), async (tx) => {
      const where = { organisationId_userId_channel_category: { organisationId: org.organisationId, userId: org.userId, channel: b.channel, category: b.category } };
      const before = await tx.notificationPreference.findUnique({ where });
      await tx.notificationPreference.upsert({ where, create: { organisationId: org.organisationId, userId: org.userId, channel: b.channel, category: b.category, enabled: b.enabled }, update: { enabled: b.enabled } });
      if ((before?.enabled ?? false) !== b.enabled) {
        await this.audit.record({ action: 'notification.preference_changed', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'notification_preference', entityId: `${b.channel}:${b.category}`,
          before: { enabled: before?.enabled ?? false }, after: { enabled: b.enabled } }, tx);
      }
      return this.preferenceView(tx, org);
    });
  }

  private async preferenceView(tx: Tx, org: OrgAccess) {
    const rows = await tx.notificationPreference.findMany({ where: { organisationId: org.organisationId, userId: org.userId } }); // the caller's own rows only
    const on = new Set(rows.filter((r) => r.enabled).map((r) => `${r.channel}:${r.category}`));
    return {
      channels: this.channels.list().map(({ channel, available }) => {
        const mandatory = MANDATORY_NOTIFICATION_CHANNELS.includes(channel);
        return { channel, available, mandatory, categories: NOTIFICATION_CATEGORIES.map((category) => ({ category, enabled: available && (mandatory || on.has(`${channel}:${category}`)) })) };
      }),
    };
  }
}
