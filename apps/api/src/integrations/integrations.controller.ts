import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { JobTypes, createConnectionSchema } from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Database } from '@uk/db';
import type { JobProducer } from '@uk/jobs';
import type { IntegrationService } from '@uk/platform';
import { AuditService } from '../audit/audit.service';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import { DB, INTEGRATIONS, JOBS } from '../common/tokens';
import { canAccessCompany, type OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const executeSchema = z.object({ operation: z.string().max(100), params: z.record(z.unknown()).default({}) }).strict();

@Controller('organisations/:organisationId/integrations')
export class IntegrationsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(INTEGRATIONS) private readonly svc: IntegrationService, @Inject(JOBS) private readonly jobs: JobProducer, private readonly audit: AuditService) {}
  private ctx(org: OrgAccess) { return { organisationId: org.organisationId, userId: org.userId }; }

  @Get('providers') @RequirePermissions('integration:read')
  providers() { return { items: this.svc.providers() }; }

  @Get('connections') @RequirePermissions('integration:read')
  async list(@Org() org: OrgAccess) { return { items: await this.db.tenant(this.ctx(org), (tx) => this.svc.list(tx)) }; }

  @Post('connections') @RequirePermissions('integration:manage') @Idempotent()
  async create(@Org() org: OrgAccess, @Body(new ZodPipe(createConnectionSchema)) b: z.output<typeof createConnectionSchema>) {
    if (b.companyId && !canAccessCompany(org, b.companyId)) throw notFound('Company not found');
    return this.db.tenant(this.ctx(org), async (tx) => {
      const c = await this.svc.create(tx, { organisationId: org.organisationId, userId: org.userId, provider: b.provider, displayName: b.displayName, companyId: b.companyId, credentials: b.credentials });
      await this.audit.record({ action: 'integration.connected', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'integration_connection', entityId: c.id, metadata: { provider: b.provider } }, tx);
      return c;
    });
  }

  @Delete('connections/:connectionId') @HttpCode(204) @RequirePermissions('integration:manage')
  async revoke(@Org() org: OrgAccess, @Param('connectionId', ParseUUIDPipe) id: string) {
    await this.db.tenant(this.ctx(org), async (tx) => {
      await this.svc.revoke(tx, id);
      await this.audit.record({ action: 'integration.revoked', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'integration_connection', entityId: id }, tx);
    });
  }

  @Post('connections/:connectionId/check') @HttpCode(200) @RequirePermissions('integration:manage')
  check(@Org() org: OrgAccess, @Param('connectionId', ParseUUIDPipe) id: string) {
    return this.db.tenant(this.ctx(org), (tx) => this.svc.check(tx, id, org.organisationId));
  }

  /** External calls never run in the request: they are queued and observable via the jobs API. */
  @Post('connections/:connectionId/execute') @HttpCode(202) @RequirePermissions('integration:manage') @Idempotent()
  async execute(@Org() org: OrgAccess, @Param('connectionId', ParseUUIDPipe) id: string, @Body(new ZodPipe(executeSchema)) b: z.output<typeof executeSchema>) {
    const exists = await this.db.tenant(this.ctx(org), (tx) => tx.integrationConnection.findFirst({ where: { id, status: 'ACTIVE' }, select: { id: true } }));
    if (!exists) throw notFound('Connection not found');
    const { record } = await this.jobs.enqueue(JobTypes.integrationExecute, { connectionId: id, operation: b.operation, params: b.params }, { organisationId: org.organisationId, userId: org.userId });
    return { jobId: record.id, status: record.status };
  }
}
