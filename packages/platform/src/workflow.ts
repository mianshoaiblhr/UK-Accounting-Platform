import { Events, WORKFLOW_DEFINITIONS, type WorkflowDefinition } from '@uk/contracts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '@uk/core';
import type { Tx, WorkflowInstance } from '@uk/db';
import { publishEvent } from './outbox';

export class WorkflowRegistry {
  private readonly defs = new Map<string, WorkflowDefinition>();
  constructor(initial: WorkflowDefinition[] = WORKFLOW_DEFINITIONS) { initial.forEach((d) => this.register(d)); }
  register(d: WorkflowDefinition): this {
    if (this.defs.has(d.type)) throw new Error(`workflow ${d.type} already registered`);
    this.defs.set(d.type, d);
    return this;
  }
  get(type: string): WorkflowDefinition {
    const d = this.defs.get(type);
    if (!d) throw unprocessable(`Unknown workflow type ${type}`, 'unknown_workflow');
    return d;
  }
  list() { return [...this.defs.values()]; }
}

export interface Actor { userId: string; permissions: ReadonlySet<string> }

/**
 * Persisted state machine: declarative definitions, optimistic concurrency, permission + segregation-of-duties
 * checks, append-only history, and an outbox event per transition. Later modules (filing approval, journal
 * review, AI proposals) plug in definitions; none of them re-implement approvals.
 */
export class WorkflowEngine {
  constructor(readonly registry: WorkflowRegistry) {}

  async start(tx: Tx, a: { type: string; organisationId: string; companyId?: string | null; subjectType: string; subjectId: string; actorUserId: string; context?: Record<string, unknown> }): Promise<WorkflowInstance> {
    const def = this.registry.get(a.type);
    const inst = await tx.workflowInstance.create({
      data: { organisationId: a.organisationId, companyId: a.companyId ?? null, type: def.type, definitionVersion: def.version, state: def.initialState,
        subjectType: a.subjectType, subjectId: a.subjectId, context: (a.context ?? {}) as never, startedByUserId: a.actorUserId },
    });
    await tx.workflowTransition.createMany({ data: [{ organisationId: a.organisationId, instanceId: inst.id, fromState: null, toState: def.initialState, action: 'start', actorUserId: a.actorUserId }] });
    await publishEvent(tx, Events.workflowTransitioned, { aggregateId: inst.id, organisationId: a.organisationId, actorUserId: a.actorUserId,
      payload: { instanceId: inst.id, workflowType: def.type, from: null, to: def.initialState, action: 'start', subjectType: a.subjectType, subjectId: a.subjectId } });
    return inst;
  }

  availableActions(def: WorkflowDefinition, state: string, startedByUserId: string, actor: Actor): string[] {
    return def.transitions
      .filter((t) => t.from.includes(state) && actor.permissions.has(t.permission) && !(t.requireDifferentFromStarter && actor.userId === startedByUserId))
      .map((t) => t.action);
  }

  async transition(tx: Tx, a: { organisationId: string; instanceId: string; action: string; actor: Actor; comment?: string; expectedVersion?: number }): Promise<WorkflowInstance> {
    const inst = await tx.workflowInstance.findUnique({ where: { id: a.instanceId } });
    if (!inst) throw notFound('Workflow not found');
    const def = this.registry.get(inst.type);
    if (def.terminalStates.includes(inst.state)) throw conflict(`Workflow is already ${inst.state}`, 'workflow_finished');
    if (a.expectedVersion !== undefined && a.expectedVersion !== inst.version) throw conflict('Workflow changed since you loaded it', 'version_conflict');
    const t = def.transitions.find((x) => x.action === a.action && x.from.includes(inst.state));
    if (!t) throw unprocessable(`Action ${a.action} is not allowed from state ${inst.state}`, 'invalid_transition');
    if (!a.actor.permissions.has(t.permission)) throw forbidden(`Requires permission ${t.permission}`, 'permission_denied');
    if (t.requireDifferentFromStarter && a.actor.userId === inst.startedByUserId) {
      throw new AppError(403, 'separation_of_duties', 'The person who started this workflow cannot perform this action');
    }
    if (t.commentRequired && !a.comment?.trim()) throw unprocessable('A comment is required for this action', 'comment_required');

    const terminal = def.terminalStates.includes(t.to);
    const upd = await tx.workflowInstance.updateMany({
      where: { id: inst.id, version: inst.version },
      data: { state: t.to, version: { increment: 1 }, completedAt: terminal ? new Date() : null },
    });
    if (upd.count !== 1) throw conflict('Workflow changed concurrently', 'version_conflict');
    await tx.workflowTransition.createMany({ data: [{ organisationId: a.organisationId, instanceId: inst.id, fromState: inst.state, toState: t.to, action: t.action, actorUserId: a.actor.userId, comment: a.comment }] });
    await publishEvent(tx, Events.workflowTransitioned, { aggregateId: inst.id, organisationId: a.organisationId, actorUserId: a.actor.userId,
      payload: { instanceId: inst.id, workflowType: inst.type, from: inst.state, to: t.to, action: t.action, subjectType: inst.subjectType, subjectId: inst.subjectId } });
    return tx.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
  }
}
