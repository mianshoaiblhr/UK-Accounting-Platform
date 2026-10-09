import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { reasonQuerySchema, setFeatureFlagSchema } from '@uk/contracts';
import type { Database } from '@uk/db';
import type { FeatureFlagService } from '@uk/platform';
import { Org, RequirePermissions } from '../common/decorators';
import { DB, FEATURES } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

@Controller('organisations/:organisationId/feature-flags')
export class FeatureFlagsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(FEATURES) private readonly flags: FeatureFlagService) {}
  private ctx(org: OrgAccess) { return { organisationId: org.organisationId, userId: org.userId }; }

  @Get() @RequirePermissions('org:read')
  async list(@Org() org: OrgAccess) { return { items: await this.flags.list(org.organisationId) }; }

  /** Turn a feature on or off for this organisation (owner-level: org:manage). Audited with before/after and reason. */
  @Put(':key') @RequirePermissions('org:manage')
  set(@Org() org: OrgAccess, @Param('key') key: string, @Body(new ZodPipe(setFeatureFlagSchema)) b: z.output<typeof setFeatureFlagSchema>) {
    return this.db.tenant(this.ctx(org), (tx) => this.flags.set(tx, { organisationId: org.organisationId, key, enabled: b.enabled, reason: b.reason, userId: org.userId }));
  }

  /** Remove the override; the flag returns to the environment / registry default. */
  @Delete(':key') @HttpCode(204) @RequirePermissions('org:manage')
  async clear(@Org() org: OrgAccess, @Param('key') key: string, @Query(new ZodPipe(reasonQuerySchema)) q: z.output<typeof reasonQuerySchema>) {
    await this.db.tenant(this.ctx(org), (tx) => this.flags.clear(tx, { organisationId: org.organisationId, key, userId: org.userId, reason: q.reason }));
  }
}
