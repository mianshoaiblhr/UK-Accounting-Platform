import { Events, WORKFLOW_DEFINITIONS, type WorkflowDefinition, type WorkflowTransitionDef } from '@uk/contracts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '@uk/core';
import type { Tx, WorkflowInstance } from '@uk/db';
import { auditRow } from './audit';
import { recordEvidenceLink } from './evidence';
import { publishEvent } from './outbox';

/** Versioned registry: an instance keeps the definition version it started with; new instances use the latest. */
export class WorkflowRegistry {
  private readonly defs = new Map<string, WorkflowDefinition>();
  constructor(initial: WorkflowDefinition[] = WORKFLOW_DEFINITIONS) { initial.forEach((d) => this.register(d)); }
  register(d: WorkflowDefinition): this {
    const key = `${d.type}@${d.version}`;
    if (this.defs.has(key)) throw new Error(`workflow ${key} already registered`);
    this.defs.set(key, d);
    return this;
  }
  /** `version` omitted = latest. */
  get(type: string, version?: number): WorkflowDefinition {
    const d = version === undefined
      ? [...this.defs.values()].filter((x) => x.type === type).sort((a, b) => b.version - a.version)[0]
      : this.defs.get(`${type}@${version}`);
    if (!d) throw unprocessable(`Unknown workflow type ${type}`, 'unknown_workflow');
    return d;
  }
  /** Latest version of every type. */
  list() {
    const types = [...new Set([...this.defs.values()].map((d) => d.type))];
    return types.map((t) => this.get(t));
  }
}

/**
 * Who is acting. `can` (preferred) evaluates a permission for the instance's company using the central
 * authorisation rules; `permissions` is a plain organisation-wide set for server-side callers and tests.
 */
export interface Actor {
  userId: string;
  permissions?: ReadonlySet<string>;
  can?: (permission: string, companyId: string | null) => boolean | Promise<boolean>;
  /** Per-document visibility (restricted documents). When absent, company-level `document:read` decides (server-side callers and tests). */
  canReadDocument?: (doc: { id: string; companyId: string | null; visibility: string; createdByUserId: string }) => boolean | Promise<boolean>;
}
const holds = async (actor: Actor, permission: string, companyId: string | null) =>
  actor.can ? actor.can(permission, companyId) : !!actor.permissions?.has(permission);

/**
 * Persisted state machine: declarative versioned definitions, optimistic concurrency, per-transition permission
 * checks (for the instance's company), segregation of duties, comment/evidence rules, append-only history and an
 * outbox event per transition. Later modules (filing approval, journal review, AI proposals) plug in definitions that
 * may only ADD controls; none re-implements approvals. State can only change through a declared transition.
 */
export class WorkflowEngine {
  /** `captureDeviceMetadata` mirrors AUDIT_CAPTURE_DEVICE_METADATA for audit rows the engine writes. */
  constructor(readonly registry: WorkflowRegistry, readonly opts: { captureDeviceMetadata?: boolean } = {}) {}

  /** Every state change is also an audit event carrying the workflow it belongs to (specification: audit "source workflow"). */
  private audit(tx: Tx, e: { organisationId: string; companyId: string | null; actorUserId: string | null; action: string; instanceId: string; from: string | null; to: string; reason?: string | null; subjectType: string; subjectId: string; workflowType: string; outcome?: 'SUCCESS' }) {
    return tx.auditEvent.createMany({ data: [auditRow({
      action: e.action, organisationId: e.organisationId, companyId: e.companyId, actorUserId: e.actorUserId, entityType: 'workflow_instance', entityId: e.instanceId,
      before: e.from ? { state: e.from } : null, after: { state: e.to }, reason: e.reason, sourceWorkflowId: e.instanceId,
      metadata: { workflowType: e.workflowType, subjectType: e.subjectType, subjectId: e.subjectId },
    }, this.opts.captureDeviceMetadata ?? true)] });
  }

  async start(tx: Tx, a: { type: string; organisationId: string; companyId?: string | null; subjectType: string; subjectId: string; actorUserId: string; context?: Record<string, unknown>; assigneeUserId?: string | null }): Promise<WorkflowInstance> {
    const def = this.registry.get(a.type);
    const inst = await tx.workflowInstance.create({
      data: { organisationId: a.organisationId, companyId: a.companyId ?? null, type: def.type, definitionVersion: def.version, state: def.initialState,
        subjectType: a.subjectType, subjectId: a.subjectId, context: (a.context ?? {}) as never, startedByUserId: a.actorUserId, assigneeUserId: a.assigneeUserId ?? null },
    });
    await tx.workflowTransition.createMany({ data: [{ organisationId: a.organisationId, instanceId: inst.id, fromState: null, toState: def.initialState, action: 'start', actorUserId: a.actorUserId }] });
    await this.audit(tx, { organisationId: a.organisationId, companyId: inst.companyId, actorUserId: a.actorUserId, action: 'workflow.started', instanceId: inst.id, from: null, to: def.initialState, subjectType: a.subjectType, subjectId: a.subjectId, workflowType: def.type });
    await publishEvent(tx, Events.workflowTransitioned, { aggregateId: inst.id, organisationId: a.organisationId, actorUserId: a.actorUserId,
      payload: { instanceId: inst.id, workflowType: def.type, from: null, to: def.initialState, action: 'start', subjectType: a.subjectType, subjectId: a.subjectId } });
    return inst;
  }

  /** Actions the actor could take right now (permission + segregation of duties; comment/evidence are request-time rules). */
  async availableActions(tx: Tx, inst: Pick<WorkflowInstance, 'id' | 'type' | 'definitionVersion' | 'state' | 'startedByUserId' | 'companyId' | 'attempt'>, actor: Actor): Promise<string[]> {
    const def = this.registry.get(inst.type, inst.definitionVersion);
    const out: string[] = [];
    for (const t of def.transitions.filter((x) => x.from.includes(inst.state))) {
      if (!(await holds(actor, t.permission, inst.companyId))) continue;
      if (t.requireDifferentFromStarter && actor.userId === inst.startedByUserId) continue;
      if (await this.violatesDistinct(tx, inst, t, actor.userId)) continue;
      if (!out.includes(t.action)) out.push(t.action);
    }
    return out;
  }

  private async violatesDistinct(tx: Tx, inst: { id: string; attempt: number }, t: WorkflowTransitionDef, userId: string): Promise<boolean> {
    if (!t.requireDistinctFrom?.length) return false;
    const n = await tx.workflowTransition.count({ where: { instanceId: inst.id, action: { in: t.requireDistinctFrom }, actorUserId: userId } });
    return n > 0;
  }

  /** Evidence documents must exist in this organisation, belong to the instance's company (or be organisation-level) and be readable by the actor. */
  private async checkEvidence(tx: Tx, inst: WorkflowInstance, ids: string[], actor: Actor) {
    const unique = [...new Set(ids)];
    const docs = await tx.document.findMany({ where: { id: { in: unique } }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } }); // RLS: this organisation only
    if (docs.length !== unique.length) throw unprocessable('One or more evidence documents do not exist', 'invalid_evidence');
    for (const d of docs) {
      if (d.companyId && inst.companyId && d.companyId !== inst.companyId) throw unprocessable('Evidence must belong to the same company as the workflow', 'invalid_evidence');
      if (actor.canReadDocument) {
        // an invisible (restricted) document is indistinguishable from a missing one
        if (!(await actor.canReadDocument(d))) throw unprocessable('One or more evidence documents do not exist', 'invalid_evidence');
      } else if (!(await holds(actor, 'document:read', d.companyId))) throw forbidden('You cannot read one of the evidence documents', 'permission_denied');
    }
  }

  async transition(tx: Tx, a: { organisationId: string; instanceId: string; action: string; actor: Actor; comment?: string; evidenceDocumentIds?: string[]; expectedVersion?: number }): Promise<WorkflowInstance> {
    const inst = await tx.workflowInstance.findUnique({ where: { id: a.instanceId } });
    if (!inst) throw notFound('Workflow not found');
    const def = this.registry.get(inst.type, inst.definitionVersion);
    const t = def.transitions.find((x) => x.action === a.action && x.from.includes(inst.state));
    if (def.terminalStates.includes(inst.state) && !t?.retry) throw conflict(`Workflow is already ${inst.state}`, 'workflow_finished');
    if (a.expectedVersion !== undefined && a.expectedVersion !== inst.version) throw conflict('Workflow changed since you loaded it', 'version_conflict');
    if (!t) throw unprocessable(`Action ${a.action} is not allowed from state ${inst.state}`, 'invalid_transition');
    if (!(await holds(a.actor, t.permission, inst.companyId))) throw forbidden(`Requires permission ${t.permission}`, 'permission_denied');
    if (t.requireDifferentFromStarter && a.actor.userId === inst.startedByUserId) {
      throw new AppError(403, 'separation_of_duties', 'The person who started this workflow cannot perform this action');
    }
    if (await this.violatesDistinct(tx, inst, t, a.actor.userId)) {
      throw new AppError(403, 'separation_of_duties', 'You already performed a preceding step of this workflow and cannot perform this one');
    }
    if (t.commentRequired && !a.comment?.trim()) throw unprocessable('A comment is required for this action', 'comment_required');
    const evidence = a.evidenceDocumentIds ?? [];
    if (t.evidenceRequired && evidence.length === 0) throw unprocessable('Evidence is required for this action', 'evidence_required');
    if (evidence.length) await this.checkEvidence(tx, inst, evidence, a.actor);

    const terminal = def.terminalStates.includes(t.to);
    const attempt = t.retry ? inst.attempt + 1 : inst.attempt;
    // History first: a database trigger refuses any state change that is not accompanied by its recorded transition.
    await tx.workflowTransition.createMany({ data: [{
      organisationId: a.organisationId, instanceId: inst.id, fromState: inst.state, toState: t.to, action: t.action, actorUserId: a.actor.userId,
      comment: a.comment, attempt, evidenceDocumentIds: [...new Set(evidence)],
    }] });
    const upd = await tx.workflowInstance.updateMany({
      where: { id: inst.id, version: inst.version },
      data: { state: t.to, version: { increment: 1 }, attempt, completedAt: terminal ? new Date() : null },
    });
    if (upd.count !== 1) throw conflict('Workflow changed concurrently', 'version_conflict'); // the caller's transaction rolls the history row back
    // Evidence offered for the transition becomes part of the evidence graph, atomically with the history row.
    for (const docId of new Set(evidence)) await recordEvidenceLink(tx, { organisationId: a.organisationId, companyId: inst.companyId, source: { type: 'workflow_instance', id: inst.id }, target: { type: 'document', id: docId }, kind: 'SUPPORTS', createdByUserId: a.actor.userId });
    await this.audit(tx, { organisationId: a.organisationId, companyId: inst.companyId, actorUserId: a.actor.userId, action: `workflow.${t.action}`, instanceId: inst.id, from: inst.state, to: t.to, reason: a.comment, subjectType: inst.subjectType, subjectId: inst.subjectId, workflowType: inst.type });
    await publishEvent(tx, Events.workflowTransitioned, { aggregateId: inst.id, organisationId: a.organisationId, actorUserId: a.actor.userId,
      payload: { instanceId: inst.id, workflowType: inst.type, from: inst.state, to: t.to, action: t.action, subjectType: inst.subjectType, subjectId: inst.subjectId } });
    return tx.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
  }

  /**
   * Reassignment is an explicit, recorded step (state unchanged). The actor needs `workflow:manage` for the
   * instance's company; `canBeAssigned` lets the caller prove the new assignee can work on that company.
   */
  async reassign(tx: Tx, a: { organisationId: string; instanceId: string; assigneeUserId: string | null; actor: Actor; comment?: string; canBeAssigned?: (userId: string, companyId: string | null) => Promise<boolean> }): Promise<WorkflowInstance> {
    const inst = await tx.workflowInstance.findUnique({ where: { id: a.instanceId } });
    if (!inst) throw notFound('Workflow not found');
    const def = this.registry.get(inst.type, inst.definitionVersion);
    if (def.terminalStates.includes(inst.state)) throw conflict(`Workflow is already ${inst.state}`, 'workflow_finished');
    if (!(await holds(a.actor, 'workflow:manage', inst.companyId))) throw forbidden('Requires permission workflow:manage', 'permission_denied');
    if (a.assigneeUserId && a.canBeAssigned && !(await a.canBeAssigned(a.assigneeUserId, inst.companyId))) {
      throw unprocessable('Assignee cannot work on this company', 'invalid_assignee');
    }
    const upd = await tx.workflowInstance.updateMany({ where: { id: inst.id, version: inst.version }, data: { assigneeUserId: a.assigneeUserId, version: { increment: 1 } } });
    if (upd.count !== 1) throw conflict('Workflow changed concurrently', 'version_conflict');
    await tx.workflowTransition.createMany({ data: [{
      organisationId: a.organisationId, instanceId: inst.id, fromState: inst.state, toState: inst.state, action: 'reassign', actorUserId: a.actor.userId,
      comment: a.comment ?? (a.assigneeUserId ? `Reassigned to ${a.assigneeUserId}` : 'Unassigned'), attempt: inst.attempt,
    }] });
    await this.audit(tx, { organisationId: a.organisationId, companyId: inst.companyId, actorUserId: a.actor.userId, action: 'workflow.reassign', instanceId: inst.id, from: inst.state, to: inst.state, reason: a.comment, subjectType: inst.subjectType, subjectId: inst.subjectId, workflowType: inst.type });
    await publishEvent(tx, Events.workflowTransitioned, { aggregateId: inst.id, organisationId: a.organisationId, actorUserId: a.actor.userId,
      payload: { instanceId: inst.id, workflowType: inst.type, from: inst.state, to: inst.state, action: 'reassign', subjectType: inst.subjectType, subjectId: inst.subjectId } });
    return tx.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
  }
}
