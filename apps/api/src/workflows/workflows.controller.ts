import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationSchema, reassignWorkflowSchema, startWorkflowSchema, transitionWorkflowSchema } from '@uk/contracts';
import { forbidden, notFound, unprocessable } from '@uk/core';
import type { Database } from '@uk/db';
import type { WorkflowEngine } from '@uk/platform';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import { DB, WORKFLOWS } from '../common/tokens';
import { loadAccess } from '../common/access';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const listQuery = paginationSchema.extend({ type: z.string().max(60).optional(), state: z.string().max(60).optional() });

@Controller('organisations/:organisationId/workflows')
export class WorkflowsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(WORKFLOWS) private readonly engine: WorkflowEngine) {}

  private ctx(org: OrgAccess) { return { organisationId: org.organisationId, userId: org.userId }; }

  @Get('definitions') @RequirePermissions('workflow:read')
  definitions() {
    return { items: this.engine.registry.list().map((d) => ({ type: d.type, version: d.version, initialState: d.initialState, terminalStates: d.terminalStates, apiStartable: !!d.apiStartable, transitions: d.transitions })) };
  }

  @Post() @RequirePermissions('workflow:manage') @Idempotent()
  async start(@Org() org: OrgAccess, @Body(new ZodPipe(startWorkflowSchema)) b: z.output<typeof startWorkflowSchema>) {
    const def = this.engine.registry.get(b.type);
    if (!def.apiStartable) throw unprocessable('This workflow cannot be started through the API', 'workflow_not_startable');
    if (def.startPermission && !(await org.access.can(def.startPermission as never, { companyId: b.companyId ?? null }))) {
      if (b.companyId) await org.access.requireCompany(def.startPermission as never, b.companyId); // 404/403 with audit
      throw forbidden('You do not have permission to perform this action', 'permission_denied');
    }
    return this.db.tenant(this.ctx(org), (tx) => this.engine.start(tx, { type: b.type, organisationId: org.organisationId, companyId: b.companyId, subjectType: b.subjectType, subjectId: b.subjectId, actorUserId: org.userId, context: b.context }));
  }

  @Get() @RequirePermissions('workflow:read')
  async list(@Org() org: OrgAccess, @Query(new ZodPipe(listQuery)) q: z.output<typeof listQuery>) {
    const visible = await org.access.companyWhere('workflow:read');
    const rows = await this.db.tenant(this.ctx(org), (tx) => tx.workflowInstance.findMany({
      where: { ...visible, ...(q.type ? { type: q.type } : {}), ...(q.state ? { state: q.state } : {}) },
      orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  @Get(':workflowId') @RequirePermissions('workflow:read')
  async get(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string) {
    const { inst, availableActions } = await this.db.tenant(this.ctx(org), async (tx) => {
      const found = await tx.workflowInstance.findUnique({ where: { id }, include: { transitions: { orderBy: { occurredAt: 'asc' } } } });
      if (!found) throw notFound('Workflow not found');
      await org.access.requireResource('workflow:read', found.companyId, 'Workflow not found');
      return { inst: found, availableActions: await this.engine.availableActions(tx, found, org.access.actor()) };
    });
    return { ...inst, availableActions };
  }

  @Post(':workflowId/transitions') @RequirePermissions('workflow:read')
  async transition(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string, @Body(new ZodPipe(transitionWorkflowSchema)) b: z.output<typeof transitionWorkflowSchema>) {
    await this.get(org, id); // existence + read access (404 when the caller has no access to the workflow's company)
    return this.db.tenant(this.ctx(org), (tx) => this.engine.transition(tx, {
      organisationId: org.organisationId, instanceId: id, action: b.action, comment: b.comment, evidenceDocumentIds: b.evidenceDocumentIds,
      expectedVersion: b.expectedVersion, actor: org.access.actor(),
    }));
  }

  /** Reassignment is an explicit, recorded step; the new assignee must be able to work on the workflow's company. */
  @Post(':workflowId/reassign') @HttpCode(200) @RequirePermissions('workflow:manage')
  async reassign(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string, @Body(new ZodPipe(reassignWorkflowSchema)) b: z.output<typeof reassignWorkflowSchema>) {
    await this.get(org, id);
    return this.db.tenant(this.ctx(org), (tx) => this.engine.reassign(tx, {
      organisationId: org.organisationId, instanceId: id, assigneeUserId: b.assigneeUserId, comment: b.comment, actor: org.access.actor(),
      canBeAssigned: async (userId, companyId) => {
        const target = await loadAccess(this.db, org.organisationId, userId);
        return !!target && (await target.access.can('workflow:read', { companyId }));
      },
    }));
  }
}
