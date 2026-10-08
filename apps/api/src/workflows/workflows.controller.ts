import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationSchema, startWorkflowSchema, transitionWorkflowSchema } from '@uk/contracts';
import { notFound, unprocessable } from '@uk/core';
import type { Database } from '@uk/db';
import type { WorkflowEngine } from '@uk/platform';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import { DB, WORKFLOWS } from '../common/tokens';
import { canAccessCompany, type OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const listQuery = paginationSchema.extend({ type: z.string().max(60).optional(), state: z.string().max(60).optional() });

@Controller('organisations/:organisationId/workflows')
export class WorkflowsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(WORKFLOWS) private readonly engine: WorkflowEngine) {}

  private ctx(org: OrgAccess) { return { organisationId: org.organisationId, userId: org.userId }; }
  private visible(org: OrgAccess) { return org.companyScope === 'ALL' ? {} : { OR: [{ companyId: null }, { companyId: { in: [...org.assignedCompanyIds] } }] }; }

  @Get('definitions') @RequirePermissions('workflow:read')
  definitions() {
    return { items: this.engine.registry.list().map((d) => ({ type: d.type, version: d.version, initialState: d.initialState, terminalStates: d.terminalStates, apiStartable: !!d.apiStartable, transitions: d.transitions })) };
  }

  @Post() @RequirePermissions('workflow:manage') @Idempotent()
  async start(@Org() org: OrgAccess, @Body(new ZodPipe(startWorkflowSchema)) b: z.output<typeof startWorkflowSchema>) {
    const def = this.engine.registry.get(b.type);
    if (!def.apiStartable) throw unprocessable('This workflow cannot be started through the API', 'workflow_not_startable');
    if (def.startPermission && !org.permissions.has(def.startPermission as never)) throw unprocessable('Missing permission', 'permission_denied');
    if (b.companyId && !canAccessCompany(org, b.companyId)) throw notFound('Company not found');
    return this.db.tenant(this.ctx(org), (tx) => this.engine.start(tx, { type: b.type, organisationId: org.organisationId, companyId: b.companyId, subjectType: b.subjectType, subjectId: b.subjectId, actorUserId: org.userId, context: b.context }));
  }

  @Get() @RequirePermissions('workflow:read')
  async list(@Org() org: OrgAccess, @Query(new ZodPipe(listQuery)) q: z.output<typeof listQuery>) {
    const rows = await this.db.tenant(this.ctx(org), (tx) => tx.workflowInstance.findMany({
      where: { ...this.visible(org), ...(q.type ? { type: q.type } : {}), ...(q.state ? { state: q.state } : {}) },
      orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  @Get(':workflowId') @RequirePermissions('workflow:read')
  async get(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string) {
    const inst = await this.db.tenant(this.ctx(org), (tx) => tx.workflowInstance.findFirst({ where: { id, ...this.visible(org) }, include: { transitions: { orderBy: { occurredAt: 'asc' } } } }));
    if (!inst) throw notFound('Workflow not found');
    const def = this.engine.registry.get(inst.type);
    return { ...inst, availableActions: this.engine.availableActions(def, inst.state, inst.startedByUserId, { userId: org.userId, permissions: org.permissions }) };
  }

  @Post(':workflowId/transitions') @RequirePermissions('workflow:read')
  async transition(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string, @Body(new ZodPipe(transitionWorkflowSchema)) b: z.output<typeof transitionWorkflowSchema>) {
    await this.get(org, id); // company-scope visibility
    return this.db.tenant(this.ctx(org), (tx) => this.engine.transition(tx, { organisationId: org.organisationId, instanceId: id, action: b.action, comment: b.comment, expectedVersion: b.expectedVersion, actor: { userId: org.userId, permissions: org.permissions } }));
  }
}
