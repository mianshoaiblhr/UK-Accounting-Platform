import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationSchema, reassignWorkflowSchema, setWorkflowDueDateSchema, startWorkflowSchema, transitionWorkflowSchema } from '@uk/contracts';
import { forbidden, notFound, unprocessable } from '@uk/core';
import type { Database } from '@uk/db';
import type { WorkflowEngine } from '@uk/platform';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import { DB, WORKFLOWS } from '../common/tokens';
import { loadAccess } from '../common/access';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const listQuery = paginationSchema.extend({
  type: z.string().max(60).optional(), state: z.string().max(60).optional(),
  /** true: only open instances past their deadline; false: everything else. */
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/**
 * Overdue = past its deadline and not finished (computed on read; the same rule the sweeper and the gauge use).
 * The sweeper's failure accounting (attempts, retry time, last error) is internal and never returned.
 */
const withOverdue = <T extends { dueAt: Date | null; completedAt: Date | null; overdueAttempts: number; overdueRetryAt: Date | null; overdueLastError: string | null }>(i: T) => {
  const { overdueAttempts: _a, overdueRetryAt: _r, overdueLastError: _e, ...rest } = i;
  return { ...rest, overdue: !!i.dueAt && i.dueAt.getTime() < Date.now() && !i.completedAt };
};

@Controller('organisations/:organisationId/workflows')
export class WorkflowsController {
  constructor(@Inject(DB) private readonly db: Database, @Inject(WORKFLOWS) private readonly engine: WorkflowEngine) {}

  private ctx(org: OrgAccess) { return { organisationId: org.organisationId, userId: org.userId }; }

  @Get('definitions') @RequirePermissions('workflow:read')
  definitions() {
    return { items: this.engine.registry.list().map((d) => ({ type: d.type, version: d.version, initialState: d.initialState, terminalStates: d.terminalStates, apiStartable: !!d.apiStartable, slaHours: d.slaHours ?? null, transitions: d.transitions })) };
  }

  @Post() @RequirePermissions('workflow:manage') @Idempotent()
  async start(@Org() org: OrgAccess, @Body(new ZodPipe(startWorkflowSchema)) b: z.output<typeof startWorkflowSchema>) {
    const def = this.engine.registry.get(b.type);
    if (!def.apiStartable) throw unprocessable('This workflow cannot be started through the API', 'workflow_not_startable');
    if (def.startPermission && !(await org.access.can(def.startPermission as never, { companyId: b.companyId ?? null }))) {
      if (b.companyId) await org.access.requireCompany(def.startPermission as never, b.companyId); // 404/403 with audit
      throw forbidden('You do not have permission to perform this action', 'permission_denied');
    }
    return withOverdue(await this.db.tenant(this.ctx(org), (tx) => this.engine.start(tx, { type: b.type, organisationId: org.organisationId, companyId: b.companyId, subjectType: b.subjectType, subjectId: b.subjectId, actorUserId: org.userId, context: b.context,
      dueAt: b.dueAt ? new Date(b.dueAt) : undefined })));
  }

  @Get() @RequirePermissions('workflow:read')
  async list(@Org() org: OrgAccess, @Query(new ZodPipe(listQuery)) q: z.output<typeof listQuery>) {
    const visible = await org.access.companyWhere('workflow:read');
    const rows = await this.db.tenant(this.ctx(org), (tx) => tx.workflowInstance.findMany({
      where: { ...visible, ...(q.type ? { type: q.type } : {}), ...(q.state ? { state: q.state } : {}),
        ...(q.overdue === true ? { dueAt: { lt: new Date() }, completedAt: null } : {}),
        // explicit OR: `NOT (due_at < now AND completed_at IS NULL)` would drop rows without a deadline (SQL three-valued logic)
        ...(q.overdue === false ? { OR: [{ dueAt: null }, { dueAt: { gte: new Date() } }, { completedAt: { not: null } }] } : {}) },
      orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit).map(withOverdue), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  @Get(':workflowId') @RequirePermissions('workflow:read')
  async get(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string) {
    const { inst, availableActions } = await this.db.tenant(this.ctx(org), async (tx) => {
      const found = await tx.workflowInstance.findUnique({ where: { id }, include: { transitions: { orderBy: { occurredAt: 'asc' } } } });
      if (!found) throw notFound('Workflow not found');
      await org.access.requireResource('workflow:read', found.companyId, 'Workflow not found');
      return { inst: found, availableActions: await this.engine.availableActions(tx, found, org.access.actor()) };
    });
    return { ...withOverdue(inst), availableActions };
  }

  @Post(':workflowId/transitions') @RequirePermissions('workflow:read')
  async transition(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string, @Body(new ZodPipe(transitionWorkflowSchema)) b: z.output<typeof transitionWorkflowSchema>) {
    await this.get(org, id); // existence + read access (404 when the caller has no access to the workflow's company)
    return withOverdue(await this.db.tenant(this.ctx(org), (tx) => this.engine.transition(tx, {
      organisationId: org.organisationId, instanceId: id, action: b.action, comment: b.comment, evidenceDocumentIds: b.evidenceDocumentIds,
      expectedVersion: b.expectedVersion, actor: org.access.actor(),
    })));
  }

  /** Reassignment is an explicit, recorded step; the new assignee must be able to work on the workflow's company. */
  @Post(':workflowId/reassign') @HttpCode(200) @RequirePermissions('workflow:manage')
  async reassign(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string, @Body(new ZodPipe(reassignWorkflowSchema)) b: z.output<typeof reassignWorkflowSchema>) {
    await this.get(org, id);
    return withOverdue(await this.db.tenant(this.ctx(org), (tx) => this.engine.reassign(tx, {
      organisationId: org.organisationId, instanceId: id, assigneeUserId: b.assigneeUserId, comment: b.comment, actor: org.access.actor(),
      canBeAssigned: async (userId, companyId) => {
        const target = await loadAccess(this.db, org.organisationId, userId);
        return !!target && (await target.access.can('workflow:read', { companyId }));
      },
    })));
  }

  /** Sets, moves or clears the deadline (re-arms the one-time overdue notification). Recorded in the history and the audit trail. */
  @Post(':workflowId/due-date') @HttpCode(200) @RequirePermissions('workflow:manage')
  async setDueDate(@Org() org: OrgAccess, @Param('workflowId', ParseUUIDPipe) id: string, @Body(new ZodPipe(setWorkflowDueDateSchema)) b: z.output<typeof setWorkflowDueDateSchema>) {
    await this.get(org, id);
    return withOverdue(await this.db.tenant(this.ctx(org), (tx) => this.engine.setDueDate(tx, {
      organisationId: org.organisationId, instanceId: id, dueAt: b.dueAt ? new Date(b.dueAt) : null, comment: b.comment, expectedVersion: b.expectedVersion, actor: org.access.actor(),
    })));
  }
}
