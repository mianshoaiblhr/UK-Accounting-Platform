import { Inject, Injectable } from '@nestjs/common';
import { Events } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { Prisma, type Database, type Task, type Tx } from '@uk/db';
import { changeSet, publishEvent, recordEvidenceLink, revokeEvidenceLinks } from '@uk/platform';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import { loadAccess } from '../common/access';
import type { OrgAccess } from '../common/types';

type Status = 'OPEN' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELLED';
interface CreateInput {
  title: string; description: string; companyId?: string; assigneeUserId?: string; reviewerUserId?: string; priority: 'LOW' | 'NORMAL' | 'HIGH'; dueDate?: string;
  source: 'MANUAL' | 'WORKFLOW' | 'AI_PROPOSAL' | 'DOCUMENT'; sourceId?: string;
}
interface UpdateInput { title?: string; description?: string; status?: Status; priority?: 'LOW' | 'NORMAL' | 'HIGH'; dueDate?: string | null; assigneeUserId?: string | null; reviewerUserId?: string | null }
interface ListQuery {
  limit: number; cursor?: string; status?: string; assignee: 'me' | 'any'; reviewer: 'me' | 'any'; companyId?: string; priority?: string; source?: string; dueBefore?: string; overdue?: boolean;
}

const AUDITED = ['title', 'description', 'status', 'priority', 'dueDate', 'assigneeUserId', 'reviewerUserId'] as const;
const OPEN_STATES: Status[] = ['OPEN', 'IN_PROGRESS', 'IN_REVIEW'];
const MAX_PENDING_REMINDERS = 20;
const MAX_REMINDER_HORIZON_MS = 2 * 365 * 24 * 3600 * 1000;

@Injectable()
export class TasksService {
  constructor(@Inject(DB) private readonly db: Database, private readonly audit: AuditService) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  /** The assignee/reviewer/recipient must be an active member who can read the task's company (evaluated by the central rules). */
  private async assertParticipant(userId: string, org: OrgAccess, companyId: string | null, code = 'invalid_assignee', what = 'Assignee') {
    const target = await loadAccess(this.db, org.organisationId, userId);
    if (!target) throw unprocessable(`${what} is not an active member of this organisation`, code);
    if (!(await target.access.can('task:read', { companyId }))) throw unprocessable(`${what} does not have access to this company`, code);
  }

  /** A reviewer is a participant who is also trusted to review (`workflow:review` on the task's company): task managers cannot nominate arbitrary colleagues. */
  private async assertReviewer(userId: string, org: OrgAccess, companyId: string | null) {
    await this.assertParticipant(userId, org, companyId, 'invalid_reviewer', 'Reviewer');
    const target = (await loadAccess(this.db, org.organisationId, userId))!;
    if (!(await target.access.can('workflow:review', { companyId }))) throw unprocessable('Reviewer is not permitted to review work for this company', 'invalid_reviewer');
  }

  /** A declared source must exist in this tenant and concern the same company as the task. */
  private async assertSource(org: OrgAccess, tx: Tx, source: string, sourceId: string | undefined, companyId: string | null) {
    if (source === 'MANUAL') return;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!sourceId || !uuid.test(sourceId)) throw unprocessable('sourceId must be the id of the source record', 'invalid_source');
    const found = source === 'WORKFLOW' ? await tx.workflowInstance.findUnique({ where: { id: sourceId }, select: { companyId: true } })
      : source === 'AI_PROPOSAL' ? await tx.aiProposal.findUnique({ where: { id: sourceId }, select: { companyId: true } })
      : await this.readableDocument(org, tx, sourceId);
    if (!found) throw unprocessable('The source record was not found', 'invalid_source');
    if (found.companyId !== companyId) throw unprocessable('The source record belongs to a different company', 'invalid_source');
  }

  /** A document the caller may see (restricted documents are invisible to others - ADR-32); null otherwise. */
  private async readableDocument(org: OrgAccess, tx: Tx, id: string) {
    const d = await tx.document.findUnique({ where: { id }, select: { id: true, companyId: true, visibility: true, createdByUserId: true, name: true, status: true } });
    return d && (await org.access.canReadDocument(d)) ? d : null;
  }

  private async notifyAssigned(tx: Tx, org: OrgAccess, task: Task) {
    if (!task.assigneeUserId) return;
    await publishEvent(tx, Events.taskAssigned, { aggregateId: task.id, organisationId: org.organisationId, actorUserId: org.userId,
      payload: { taskId: task.id, assigneeUserId: task.assigneeUserId, title: task.title, assignedByUserId: org.userId } });
  }

  async create(org: OrgAccess, input: CreateInput) {
    await org.access.requireResource('task:manage', input.companyId ?? null, 'Company not found');
    return this.t(org, async (tx) => {
      if (input.companyId && !(await tx.company.findUnique({ where: { id: input.companyId } }))) throw notFound('Company not found');
      if (input.assigneeUserId) await this.assertParticipant(input.assigneeUserId, org, input.companyId ?? null);
      if (input.reviewerUserId) await this.assertReviewer(input.reviewerUserId, org, input.companyId ?? null);
      await this.assertSource(org, tx, input.source, input.sourceId, input.companyId ?? null);
      const task = await tx.task.create({ data: {
        organisationId: org.organisationId, companyId: input.companyId, title: input.title, description: input.description, priority: input.priority,
        dueDate: input.dueDate ? new Date(input.dueDate) : undefined, assigneeUserId: input.assigneeUserId, reviewerUserId: input.reviewerUserId,
        source: input.source, sourceId: input.sourceId, createdByUserId: org.userId } });
      await this.audit.record({ action: 'task.created', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: task.id,
        after: { title: task.title, status: task.status, assigneeUserId: task.assigneeUserId, reviewerUserId: task.reviewerUserId, priority: task.priority, source: task.source, sourceId: task.sourceId } }, tx);
      await this.notifyAssigned(tx, org, task);
      return task;
    });
  }

  async list(org: OrgAccess, q: ListQuery) {
    const visible = await org.access.companyWhere('task:read');
    const today = new Date(new Date().toISOString().slice(0, 10));
    const where: Prisma.TaskWhereInput = {
      AND: [
        visible,
        q.status ? { status: q.status as Status } : {},
        q.assignee === 'me' ? { assigneeUserId: org.userId } : {},
        q.reviewer === 'me' ? { reviewerUserId: org.userId } : {},
        q.companyId ? { companyId: q.companyId } : {},
        q.priority ? { priority: q.priority as never } : {},
        q.source ? { source: q.source } : {},
        q.dueBefore ? { dueDate: { lt: new Date(q.dueBefore) } } : {},
        q.overdue ? { dueDate: { lt: today }, status: { in: OPEN_STATES } } : {},
      ],
    };
    const rows = await this.t(org, (tx) => tx.task.findMany({ where, orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) }));
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
    if (input.assigneeUserId) await this.assertParticipant(input.assigneeUserId, org, existing.companyId);
    if (input.reviewerUserId) await this.assertReviewer(input.reviewerUserId, org, existing.companyId);
    return this.t(org, async (tx) => {
      const before = await tx.task.findUniqueOrThrow({ where: { id } });
      const reviewerAfter = input.reviewerUserId === undefined ? before.reviewerUserId : input.reviewerUserId;
      const assigneeAfter = input.assigneeUserId === undefined ? before.assigneeUserId : input.assigneeUserId;
      if (reviewerAfter && reviewerAfter === assigneeAfter) throw unprocessable('The reviewer cannot be the assignee', 'reviewer_is_assignee');
      if (input.reviewerUserId !== undefined && input.reviewerUserId !== before.reviewerUserId) {
        if (before.status === 'IN_REVIEW' || before.status === 'DONE') throw conflict('The reviewer cannot be changed while the task is in review or done', 'reviewer_locked');
        if (before.reviewerUserId && before.assigneeUserId === org.userId) throw forbidden('The assignee cannot change or remove the reviewer of their own task', 'assignee_cannot_change_reviewer');
      }
      if (input.status && input.status !== before.status) {
        if (input.status === 'DONE' && reviewerAfter) throw conflict('This task has a reviewer: submit it for review and let the reviewer complete it', 'review_required');
        if (input.status === 'IN_REVIEW') {
          if (!reviewerAfter) throw unprocessable('Assign a reviewer before submitting the task for review', 'reviewer_required');
          if (before.status === 'DONE' || before.status === 'CANCELLED') throw conflict('A finished task cannot be submitted for review', 'invalid_transition');
        }
      }
      let task: Task;
      try {
        task = await tx.task.update({ where: { id }, data: {
          title: input.title, description: input.description, priority: input.priority, status: input.status,
          dueDate: input.dueDate === undefined ? undefined : input.dueDate === null ? null : new Date(input.dueDate),
          assigneeUserId: input.assigneeUserId, reviewerUserId: input.reviewerUserId,
          completedAt: input.status === 'DONE' ? new Date() : input.status ? null : undefined } });
      } catch (e) { throw mapTaskDbError(e); }
      await this.audit.record({ action: 'task.updated', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: id, ...changeSet(before, task, AUDITED) }, tx);
      if (input.assigneeUserId && input.assigneeUserId !== before.assigneeUserId) await this.notifyAssigned(tx, org, task);
      if (task.status === 'IN_REVIEW' && before.status !== 'IN_REVIEW') {
        await publishEvent(tx, Events.taskReviewRequested, { aggregateId: task.id, organisationId: org.organisationId, actorUserId: org.userId,
          payload: { taskId: task.id, reviewerUserId: task.reviewerUserId!, title: task.title, requestedByUserId: org.userId } });
      }
      return task;
    });
  }

  /** The designated reviewer's decision. APPROVE completes the task; RETURN sends it back to IN_PROGRESS with a mandatory comment. */
  async review(org: OrgAccess, id: string, input: { decision: 'APPROVE' | 'RETURN'; comment?: string }) {
    const existing = await this.get(org, id);
    if (existing.reviewerUserId !== org.userId) throw forbidden('Only the designated reviewer can review this task', 'not_reviewer');
    // Being named is not enough: the reviewer must still hold the review permission for this company (it may have been withdrawn since).
    if (!(await org.access.can('workflow:review', { companyId: existing.companyId }))) throw forbidden('You no longer have permission to review work for this company', 'not_reviewer');
    return this.t(org, async (tx) => {
      const before = await tx.task.findUniqueOrThrow({ where: { id } });
      if (before.status !== 'IN_REVIEW') throw conflict('The task is not waiting for review', 'not_in_review');
      const approve = input.decision === 'APPROVE';
      // Conditional write: two simultaneous decisions cannot both win (the loser matches no row and gets 409).
      let changed: number;
      try {
        changed = (await tx.task.updateMany({ where: { id, status: 'IN_REVIEW', reviewerUserId: org.userId },
          data: { status: approve ? 'DONE' : 'IN_PROGRESS', completedAt: approve ? new Date() : null } })).count;
      } catch (e) { throw mapTaskDbError(e); }
      if (changed !== 1) throw conflict('The task is not waiting for your review', 'not_in_review');
      const task = await tx.task.findUniqueOrThrow({ where: { id } });
      await tx.taskComment.create({ data: { organisationId: org.organisationId, taskId: id, authorUserId: org.userId, kind: approve ? 'REVIEW_APPROVED' : 'REVIEW_RETURNED', body: input.comment ?? 'Approved' } });
      await this.audit.record({ action: approve ? 'task.review_approved' : 'task.review_returned', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: id,
        ...changeSet(before, task, ['status']), reason: input.comment }, tx);
      await publishEvent(tx, Events.taskReviewed, { aggregateId: id, organisationId: org.organisationId, actorUserId: org.userId,
        payload: { taskId: id, decision: input.decision, reviewerUserId: org.userId, assigneeUserId: task.assigneeUserId, title: task.title } });
      return task;
    });
  }

  // ───────── comments (append-only) ─────────
  async listComments(org: OrgAccess, taskId: string) {
    await this.get(org, taskId);
    return { items: await this.t(org, (tx) => tx.taskComment.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) };
  }

  /** Managers of the company's tasks, and the task's own assignee and reviewer, may comment. */
  async addComment(org: OrgAccess, taskId: string, body: string) {
    const task = await this.get(org, taskId);
    if (task.assigneeUserId !== org.userId && task.reviewerUserId !== org.userId) await org.access.requireResource('task:manage', task.companyId, 'Task not found');
    return this.t(org, async (tx) => {
      const c = await tx.taskComment.create({ data: { organisationId: org.organisationId, taskId, authorUserId: org.userId, body } });
      await this.audit.record({ action: 'task.commented', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: taskId, metadata: { commentId: c.id } }, tx);
      const recipientUserIds = [...new Set([task.assigneeUserId, task.reviewerUserId].filter((u): u is string => !!u && u !== org.userId))];
      await publishEvent(tx, Events.taskCommented, { aggregateId: taskId, organisationId: org.organisationId, actorUserId: org.userId,
        payload: { taskId, commentId: c.id, authorUserId: org.userId, title: task.title, recipientUserIds } });
      return c;
    });
  }

  // ───────── attachments (links to documents of the task's company) ─────────
  async listAttachments(org: OrgAccess, taskId: string) {
    await this.get(org, taskId);
    const rows = await this.t(org, (tx) => tx.taskAttachment.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }));
    const docs = await this.t(org, async (tx) => {
      const found = await tx.document.findMany({ where: { id: { in: rows.map((r) => r.documentId) } }, select: { id: true, companyId: true, visibility: true, createdByUserId: true, name: true, status: true } });
      const readable = [];
      for (const d of found) if (await org.access.canReadDocument(d)) readable.push(d); // names only for documents the caller may see
      return readable;
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return { items: rows.map((r) => ({ ...r, documentName: byId.get(r.documentId)?.name ?? null, documentStatus: byId.get(r.documentId)?.status ?? null })) };
  }

  async attach(org: OrgAccess, taskId: string, documentId: string) {
    const task = await this.get(org, taskId);
    await org.access.requireResource('task:manage', task.companyId, 'Task not found');
    return this.t(org, async (tx) => {
      const doc = await this.readableDocument(org, tx, documentId);
      if (!doc) throw notFound('Document not found');
      if (doc.status !== 'ACTIVE') throw unprocessable('Archived documents cannot be attached', 'document_archived');
      if (doc.companyId !== task.companyId) throw unprocessable('A task can only link documents of its own company', 'attachment_company_mismatch');
      try {
        const a = await tx.taskAttachment.create({ data: { organisationId: org.organisationId, taskId, documentId, addedByUserId: org.userId } });
        await recordEvidenceLink(tx, { organisationId: org.organisationId, companyId: task.companyId, source: { type: 'task', id: taskId }, target: { type: 'document', id: documentId }, kind: 'ATTACHED_TO', createdByUserId: org.userId });
        await this.audit.record({ action: 'task.attachment_added', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: taskId, metadata: { documentId } }, tx);
        return a;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('The document is already attached to this task', 'attachment_exists');
        throw e;
      }
    });
  }

  async detach(org: OrgAccess, taskId: string, documentId: string) {
    const task = await this.get(org, taskId);
    await org.access.requireResource('task:manage', task.companyId, 'Task not found');
    await this.t(org, async (tx) => {
      const r = await tx.taskAttachment.deleteMany({ where: { taskId, documentId } });
      if (!r.count) throw notFound('Attachment not found');
      await revokeEvidenceLinks(tx, { source: { type: 'task', id: taskId }, target: { type: 'document', id: documentId }, kind: 'ATTACHED_TO', revokedByUserId: org.userId, reason: 'attachment removed' });
      await this.audit.record({ action: 'task.attachment_removed', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: taskId, metadata: { documentId } }, tx);
    });
  }

  // ───────── reminders (delivered by the worker's TaskReminderSweeper) ─────────
  async listReminders(org: OrgAccess, taskId: string) {
    await this.get(org, taskId);
    return { items: await this.t(org, (tx) => tx.taskReminder.findMany({ where: { taskId }, orderBy: { remindAt: 'asc' } })) };
  }

  async addReminder(org: OrgAccess, taskId: string, input: { remindAt: string; recipientUserId?: string }) {
    const task = await this.get(org, taskId);
    await org.access.requireResource('task:manage', task.companyId, 'Task not found');
    if (!OPEN_STATES.includes(task.status as Status)) throw conflict('Reminders can only be set on open tasks', 'task_closed');
    const at = new Date(input.remindAt), now = Date.now();
    if (at.getTime() <= now) throw unprocessable('remindAt must be in the future', 'reminder_in_past');
    if (at.getTime() > now + MAX_REMINDER_HORIZON_MS) throw unprocessable('remindAt is too far in the future (maximum two years)', 'reminder_too_far');
    const recipient = input.recipientUserId ?? org.userId;
    if (recipient !== org.userId) await this.assertParticipant(recipient, org, task.companyId, 'invalid_recipient', 'Recipient');
    return this.t(org, async (tx) => {
      const pending = await tx.taskReminder.count({ where: { taskId, sentAt: null, cancelledAt: null } });
      if (pending >= MAX_PENDING_REMINDERS) throw unprocessable(`A task can have at most ${MAX_PENDING_REMINDERS} pending reminders`, 'too_many_reminders');
      const r = await tx.taskReminder.create({ data: { organisationId: org.organisationId, taskId, recipientUserId: recipient, remindAt: at, createdByUserId: org.userId } });
      await this.audit.record({ action: 'task.reminder_created', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: taskId, metadata: { reminderId: r.id, remindAt: input.remindAt, recipientUserId: recipient } }, tx);
      return r;
    });
  }

  async cancelReminder(org: OrgAccess, taskId: string, reminderId: string) {
    const task = await this.get(org, taskId);
    await org.access.requireResource('task:manage', task.companyId, 'Task not found');
    await this.t(org, async (tx) => {
      const r = await tx.taskReminder.updateMany({ where: { id: reminderId, taskId, sentAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } });
      if (!r.count) throw notFound('Pending reminder not found');
      await this.audit.record({ action: 'task.reminder_cancelled', organisationId: org.organisationId, actorUserId: org.userId, companyId: task.companyId, entityType: 'task', entityId: taskId, metadata: { reminderId } }, tx);
    });
  }
}

/** The database enforces the review rules too; translate its refusals into clean API errors. */
function mapTaskDbError(e: unknown): unknown {
  const msg = String((e as Error)?.message ?? '');
  if (msg.includes('only the designated reviewer')) return forbidden('Only the designated reviewer can complete a reviewed task', 'not_reviewer');
  if (msg.includes('must be submitted for review')) return conflict('This task has a reviewer: submit it for review first', 'review_required');
  if (msg.includes('assignee cannot change or remove the reviewer')) return forbidden('The assignee cannot change or remove the reviewer of their own task', 'assignee_cannot_change_reviewer');
  if (msg.includes('reviewer cannot be changed')) return conflict('The reviewer cannot be changed while the task is in review or done', 'reviewer_locked');
  if (msg.includes('task_reviewer_not_assignee_ck')) return unprocessable('The reviewer cannot be the assignee', 'reviewer_is_assignee');
  return e;
}
