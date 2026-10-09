import { Inject, Injectable } from '@nestjs/common';
import { Events } from '@uk/contracts';
import { notFound, unprocessable } from '@uk/core';
import type { Database, Task, Tx } from '@uk/db';
import { changeSet, publishEvent } from '@uk/platform';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import { loadAccess } from '../common/access';
import type { OrgAccess } from '../common/types';

interface CreateInput { title: string; description: string; companyId?: string; assigneeUserId?: string; priority: 'LOW' | 'NORMAL' | 'HIGH'; dueDate?: string }
interface UpdateInput { title?: string; description?: string; status?: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'; priority?: 'LOW' | 'NORMAL' | 'HIGH'; dueDate?: string | null; assigneeUserId?: string | null }

@Injectable()
export class TasksService {
  constructor(@Inject(DB) private readonly db: Database, private readonly audit: AuditService) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  /** The assignee must be an active member who can read the task's company (evaluated by the central rules). */
  private async assertAssignable(org: OrgAccess, userId: string, companyId: string | null) {
    const target = await loadAccess(this.db, org.organisationId, userId);
    if (!target) throw unprocessable('Assignee is not an active member of this organisation', 'invalid_assignee');
    if (!(await target.access.can('task:read', { companyId }))) {
      throw unprocessable('Assignee does not have access to this company', 'invalid_assignee');
    }
  }

  private async emitAssigned(tx: Tx, org: OrgAccess, task: Task) {
    if (!task.assigneeUserId) return;
    await publishEvent(tx, Events.taskAssigned, { aggregateId: task.id, organisationId: org.organisationId, actorUserId: org.userId,
      payload: { taskId: task.id, assigneeUserId: task.assigneeUserId, title: task.title, assignedByUserId: org.userId } });
  }

  async create(org: OrgAccess, input: CreateInput) {
    await org.access.requireResource('task:manage', input.companyId ?? null, 'Company not found');
    return this.t(org, async (tx) => {
      if (input.companyId && !(await tx.company.findUnique({ where: { id: input.companyId } }))) throw notFound('Company not found');
      if (input.assigneeUserId) await this.assertAssignable(org, input.assigneeUserId, input.companyId ?? null);
      const task = await tx.task.create({ data: {
        organisationId: org.organisationId, companyId: input.companyId, title: input.title, description: input.description, priority: input.priority,
        dueDate: input.dueDate ? new Date(input.dueDate) : undefined, assigneeUserId: input.assigneeUserId, createdByUserId: org.userId } });
      await this.audit.record({ action: 'task.created', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: task.id, after: { title: task.title, status: task.status, assigneeUserId: task.assigneeUserId, priority: task.priority } }, tx);
      await this.emitAssigned(tx, org, task);
      return task;
    });
  }

  async list(org: OrgAccess, q: { limit: number; cursor?: string; status?: string; assignee: 'me' | 'any' }) {
    const visible = await org.access.companyWhere('task:read');
    const rows = await this.t(org, (tx) => tx.task.findMany({
      where: { ...visible, ...(q.status ? { status: q.status as never } : {}), ...(q.assignee === 'me' ? { assigneeUserId: org.userId } : {}) },
      orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  async get(org: OrgAccess, id: string) {
    const task = await this.t(org, (tx) => tx.task.findUnique({ where: { id } }));
    if (task) await org.access.requireResource('task:read', task.companyId, 'Task not found');
    if (!task) throw notFound('Task not found');
    return task;
  }

  async update(org: OrgAccess, id: string, input: UpdateInput) {
    const existing = await this.get(org, id);
    await org.access.requireResource('task:manage', existing.companyId, 'Task not found');
    if (input.assigneeUserId) await this.assertAssignable(org, input.assigneeUserId, existing.companyId);
    return this.t(org, async (tx) => {
      const before = await tx.task.findUniqueOrThrow({ where: { id } });
      const task = await tx.task.update({ where: { id }, data: {
        title: input.title, description: input.description, priority: input.priority, status: input.status,
        dueDate: input.dueDate === undefined ? undefined : input.dueDate === null ? null : new Date(input.dueDate),
        assigneeUserId: input.assigneeUserId,
        completedAt: input.status === 'DONE' ? new Date() : input.status ? null : undefined } });
      await this.audit.record({ action: 'task.updated', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: id, ...changeSet(before, task, ['title', 'description', 'status', 'priority', 'dueDate', 'assigneeUserId']) }, tx);
      if (input.assigneeUserId && input.assigneeUserId !== before.assigneeUserId) await this.emitAssigned(tx, org, task);
      return task;
    });
  }
}
