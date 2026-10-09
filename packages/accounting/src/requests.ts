import { createHash } from 'node:crypto';
import { DEFAULT_APPROVAL_MODE, DEFAULT_REQUEST_EXPIRY_DAYS, Events, JOURNAL_SOURCES, MIN_REQUEST_REASON_LENGTH, type ApprovalMode, type RequestKind } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow, publishEvent, recordEvidenceLink } from '@uk/platform';
import { fmt, money } from './money';
import type { PostedJournal, PostingActor, PostingService } from './posting';

/**
 * Journal requests and the approval policy (M2, ADR-49, DEC-012).
 *
 * Opening balances and control-account adjustments are not posted by their author. They are REQUESTED (validated like a journal but not posted - a
 * pending request is not a ledger entry), then posted by the PostingService when a different person approves, or at once when the company's policy
 * exempts a request below the materiality threshold. Posted journals stay immutable; correction is a reversal.
 */
export interface RequestActor extends PostingActor {
  userId: string;
  /** Per-document visibility (restricted documents), supplied by the API from the central authoriser. */
  canReadDocument?(d: { id: string; companyId: string | null; visibility: string; createdByUserId: string | null }): boolean | Promise<boolean>;
}

export interface EffectivePolicy {
  openingBalanceApproval: ApprovalMode; controlAdjustmentApproval: ApprovalMode; materialityThreshold: string | null; requestExpiryDays: number;
  isDefault: boolean; updatedAt: Date | null; updatedByUserId: string | null;
}

export interface CreateRequestInput {
  organisationId: string; companyId: string; kind: RequestKind; actor: RequestActor;
  journalDate: string; description: string; reason: string; currency?: string;
  lines: { accountId: string; debit: string; credit: string; description?: string }[];
  evidenceDocumentIds: string[];
}

type RequestRow = Awaited<ReturnType<Tx['journalRequest']['findUniqueOrThrow']>>;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface RequestView {
  id: string; companyId: string; kind: string; status: string; effectiveStatus: string; journalDate: string; description: string; reason: string; currency: string; total: string; lines: unknown;
  evidenceDocumentIds: string[]; requestedByUserId: string; requestedAt: Date; expiresAt: Date; approvalRequired: boolean; selfApproved: boolean; policySnapshot: unknown;
  decidedByUserId: string | null; decidedAt: Date | null; decisionReason: string | null; postedJournalId: string | null;
}
export const requestView = (r: RequestRow, minor: number, now = new Date()): RequestView => ({
  id: r.id, companyId: r.companyId, kind: r.kind, status: r.status, effectiveStatus: r.status === 'PENDING' && r.expiresAt <= now ? 'EXPIRED' : r.status,
  journalDate: isoDay(r.journalDate), description: r.description, reason: r.reason, currency: r.currency, total: fmt(r.total, minor), lines: r.lines,
  evidenceDocumentIds: r.evidenceDocumentIds, requestedByUserId: r.requestedByUserId, requestedAt: r.requestedAt, expiresAt: r.expiresAt,
  approvalRequired: r.approvalRequired, selfApproved: r.selfApproved, policySnapshot: r.policySnapshot,
  decidedByUserId: r.decidedByUserId, decidedAt: r.decidedAt, decisionReason: r.decisionReason, postedJournalId: r.postedJournalId,
});

export class LedgerPolicyService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}

  async get(tx: Tx, companyId: string): Promise<EffectivePolicy> {
    const p = await tx.ledgerPolicy.findFirst({ where: { companyId } });
    if (!p) return { openingBalanceApproval: DEFAULT_APPROVAL_MODE, controlAdjustmentApproval: DEFAULT_APPROVAL_MODE, materialityThreshold: null, requestExpiryDays: DEFAULT_REQUEST_EXPIRY_DAYS, isDefault: true, updatedAt: null, updatedByUserId: null };
    return { openingBalanceApproval: p.openingBalanceApproval as ApprovalMode, controlAdjustmentApproval: p.controlAdjustmentApproval as ApprovalMode, materialityThreshold: p.materialityThreshold ? fmt(p.materialityThreshold, 2) : null,
      requestExpiryDays: p.requestExpiryDays, isDefault: false, updatedAt: p.updatedAt, updatedByUserId: p.updatedByUserId };
  }

  /** Changing the policy can weaken a control, so it needs its own permission and a reason, and is audited with before/after. */
  async set(tx: Tx, a: { organisationId: string; companyId: string; actor: RequestActor; openingBalanceApproval: ApprovalMode; controlAdjustmentApproval: ApprovalMode; materialityThreshold: string | null; requestExpiryDays: number; reason: string }): Promise<EffectivePolicy> {
    if (a.actor.kind !== 'USER') throw forbidden('Only a person can change the ledger policy', 'ai_cannot_post');
    if (!(await a.actor.can('ledger:policy', a.companyId))) throw forbidden('Requires permission ledger:policy', 'permission_denied');
    if (a.reason.trim().length < MIN_REQUEST_REASON_LENGTH) throw unprocessable(`A reason of at least ${MIN_REQUEST_REASON_LENGTH} characters is required`, 'reason_required');
    if (!(await tx.company.findUnique({ where: { id: a.companyId }, select: { id: true } }))) throw notFound('Company not found');
    const threshold = a.materialityThreshold === null ? null : money(a.materialityThreshold);
    if ((a.openingBalanceApproval === 'ABOVE_THRESHOLD' || a.controlAdjustmentApproval === 'ABOVE_THRESHOLD') && (!threshold || threshold.lte(0))) throw unprocessable('ABOVE_THRESHOLD needs a materiality threshold greater than zero', 'threshold_required');
    const before = await this.get(tx, a.companyId);
    const data = { openingBalanceApproval: a.openingBalanceApproval, controlAdjustmentApproval: a.controlAdjustmentApproval, materialityThreshold: threshold, requestExpiryDays: a.requestExpiryDays, updatedByUserId: a.actor.userId };
    await tx.ledgerPolicy.upsert({ where: { organisationId_companyId: { organisationId: a.organisationId, companyId: a.companyId } }, create: { organisationId: a.organisationId, companyId: a.companyId, ...data }, update: data });
    const after = await this.get(tx, a.companyId);
    const view = (p: EffectivePolicy) => ({ openingBalanceApproval: p.openingBalanceApproval, controlAdjustmentApproval: p.controlAdjustmentApproval, materialityThreshold: p.materialityThreshold, requestExpiryDays: p.requestExpiryDays });
    await tx.auditEvent.createMany({ data: [auditRow({ action: 'ledger.policy_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ledger_policy', entityId: a.companyId,
      before: view(before), after: view(after), reason: a.reason.trim(), metadata: { wasDefault: before.isDefault } }, this.opts.captureDeviceMetadata)] });
    return after;
  }
}

export class JournalRequestService {
  constructor(private readonly posting: PostingService, private readonly policies: LedgerPolicyService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}

  /** Does the policy require a second person for a request of this kind and total? Equal to the threshold is NOT above it. */
  static approvalRequired(policy: EffectivePolicy, kind: RequestKind, total: string): boolean {
    const mode = kind === 'OPENING_BALANCE' ? policy.openingBalanceApproval : policy.controlAdjustmentApproval;
    if (mode === 'ALWAYS') return true;
    return policy.materialityThreshold === null || money(total).gt(money(policy.materialityThreshold));
  }

  async create(tx: Tx, a: CreateRequestInput): Promise<RequestView> {
    if (a.actor.kind !== 'USER') throw forbidden('AI cannot request accounting entries; a person must', 'ai_cannot_post');
    const source = JOURNAL_SOURCES[a.kind]!;
    if (!(await a.actor.can(source.permission, a.companyId))) throw forbidden(`Requires permission ${source.permission}`, 'permission_denied');
    if (a.reason.trim().length < MIN_REQUEST_REASON_LENGTH) throw unprocessable(`A reason of at least ${MIN_REQUEST_REASON_LENGTH} characters is required`, 'reason_required');
    // everything that does not depend on the approval is checked now: an approver is never asked to approve what could not post
    const checked = await this.posting.validateForRequest(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: a.journalDate, sourceType: a.kind, description: a.description, currency: a.currency, lines: a.lines });
    const policy = await this.policies.get(tx, a.companyId);
    const approvalRequired = JournalRequestService.approvalRequired(policy, a.kind, checked.total);
    const evidenceIds = [...new Set(a.evidenceDocumentIds)];
    if (a.kind === 'CONTROL_ADJUSTMENT' && evidenceIds.length === 0) throw unprocessable('A control-account adjustment needs at least one evidence document', 'evidence_required');
    if (a.kind === 'OPENING_BALANCE' && approvalRequired && evidenceIds.length === 0) throw unprocessable('An opening balance that needs approval needs at least one evidence document (for example the prior-period trial balance)', 'evidence_required');
    await this.checkEvidence(tx, a.companyId, evidenceIds, a.actor);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + policy.requestExpiryDays * 86_400_000);
    const contentHash = createHash('sha256').update(JSON.stringify({ c: a.companyId, k: a.kind, d: a.journalDate, t: a.description.trim(), l: checked.lines.map((l) => [l.accountId, l.debit, l.credit, l.description ?? null]) })).digest('hex');
    const id = uuidv7();
    const snapshot = { openingBalanceApproval: policy.openingBalanceApproval, controlAdjustmentApproval: policy.controlAdjustmentApproval, materialityThreshold: policy.materialityThreshold, requestExpiryDays: policy.requestExpiryDays, policyIsDefault: policy.isDefault, total: checked.total, approvalRequired };
    await tx.journalRequest.create({ data: {
      id, organisationId: a.organisationId, companyId: a.companyId, kind: a.kind, status: 'PENDING', journalDate: new Date(`${a.journalDate}T00:00:00.000Z`), description: a.description.trim(), reason: a.reason.trim(),
      currency: checked.currency, lines: checked.lines as never, total: money(checked.total), evidenceDocumentIds: evidenceIds, requestedByUserId: a.actor.userId, requestedAt: now, expiresAt,
      approvalRequired, selfApproved: !approvalRequired, policySnapshot: snapshot, contentHash,
    } });
    await tx.auditEvent.createMany({ data: [auditRow({ action: 'ledger.request_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'journal_request', entityId: id,
      after: { kind: a.kind, status: 'PENDING', journalDate: a.journalDate, total: checked.total, approvalRequired, evidenceDocuments: evidenceIds.length }, reason: a.reason.trim(), metadata: { policy: snapshot } }, this.opts.captureDeviceMetadata)] });
    await publishEvent(tx, Events.ledgerRequestCreated, { aggregateId: id, organisationId: a.organisationId, actorUserId: a.actor.userId, payload: { requestId: id, companyId: a.companyId, kind: a.kind, requestedByUserId: a.actor.userId, approvalRequired } });

    // below the materiality threshold the policy exempts the request from a second person: post it at once (the requester is requester and decider)
    if (!approvalRequired) return this.finalise(tx, a.organisationId, id, a.actor, 'APPROVED', undefined);
    return this.view(tx, await tx.journalRequest.findUniqueOrThrow({ where: { id } }));
  }

  async approve(tx: Tx, a: { organisationId: string; companyId: string; requestId: string; actor: RequestActor; comment?: string }): Promise<RequestView> {
    const r = await this.lock(tx, a.companyId, a.requestId);
    if (a.actor.kind !== 'USER') throw forbidden('AI cannot approve accounting entries; a person must', 'ai_cannot_post');
    if (r.requestedByUserId === a.actor.userId) throw forbidden('A request cannot be approved by the person who made it', 'self_approval_not_allowed');
    if (!(await a.actor.can('ledger:approve', a.companyId))) throw forbidden('Requires permission ledger:approve', 'permission_denied');
    return this.finalise(tx, a.organisationId, r.id, a.actor, 'APPROVED', a.comment);
  }

  async reject(tx: Tx, a: { organisationId: string; companyId: string; requestId: string; actor: RequestActor; reason: string }): Promise<RequestView> {
    const r = await this.lock(tx, a.companyId, a.requestId);
    if (a.actor.kind !== 'USER') throw forbidden('AI cannot decide accounting requests; a person must', 'ai_cannot_post');
    if (!(await a.actor.can('ledger:approve', a.companyId))) throw forbidden('Requires permission ledger:approve', 'permission_denied');
    return this.finalise(tx, a.organisationId, r.id, a.actor, 'REJECTED', a.reason);
  }

  /** The requester withdraws their own pending request (no permission beyond having made it). */
  async cancel(tx: Tx, a: { organisationId: string; companyId: string; requestId: string; actor: RequestActor; reason?: string }): Promise<RequestView> {
    const r = await this.lock(tx, a.companyId, a.requestId);
    if (r.requestedByUserId !== a.actor.userId) throw forbidden('Only the person who made a request can cancel it', 'permission_denied');
    return this.finalise(tx, a.organisationId, r.id, a.actor, 'CANCELLED', a.reason);
  }

  async get(tx: Tx, companyId: string, id: string): Promise<RequestView> {
    const r = await tx.journalRequest.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('Journal request not found');
    return this.view(tx, r);
  }

  async list(tx: Tx, companyId: string, q: { limit: number; cursor?: string; status?: string; kind?: string }): Promise<{ items: RequestView[]; nextCursor: string | null }> {
    const now = new Date();
    const rows = await tx.journalRequest.findMany({ where: { companyId, ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}), ...(q.cursor ? { id: { lt: q.cursor } } : {}) }, orderBy: { id: 'desc' }, take: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    const minor = new Map<string, number>();
    for (const c of new Set(page.map((r) => r.currency))) minor.set(c, (await tx.currency.findUnique({ where: { code: c } }))?.minorUnits ?? 2);
    return { items: page.map((r) => requestView(r, minor.get(r.currency) ?? 2, now)), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
  }

  // ───── internals ─────
  /** Row lock first: concurrent approve / reject / cancel of one request serialise here, and the loser sees the final status. */
  private async lock(tx: Tx, companyId: string, id: string): Promise<RequestRow> {
    const found = await tx.journalRequest.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!found) throw notFound('Journal request not found');
    await tx.$queryRaw`SELECT id FROM journal_request WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await tx.journalRequest.findUniqueOrThrow({ where: { id } });
    if (r.status !== 'PENDING') throw conflict(`This request was already ${r.status.toLowerCase()}`, 'request_not_pending');
    if (r.expiresAt <= new Date()) throw conflict('This request has expired; make a new one', 'request_expired');
    return r;
  }

  private async finalise(tx: Tx, organisationId: string, id: string, actor: RequestActor, decision: 'APPROVED' | 'REJECTED' | 'CANCELLED', note?: string) {
    const r = await tx.journalRequest.findUniqueOrThrow({ where: { id } });
    let journal: PostedJournal | null = null;
    if (decision === 'APPROVED') {
      // the PostingService re-validates everything at posting time: a period closed since the request, an account made inactive, ... refuse here
      journal = await this.posting.post(tx, {
        organisationId, companyId: r.companyId, journalDate: isoDay(r.journalDate), sourceType: r.kind, sourceId: r.id, sourceReference: `REQ-${r.id.slice(-8)}`, description: r.description,
        lines: (r.lines as { accountId: string; debit: string; credit: string; description?: string }[]), idempotencyKey: `request:${r.id}`, actor, reason: note ?? r.reason,
        request: { id: r.id, requestedByUserId: r.requestedByUserId, selfApproved: r.selfApproved },
      });
      for (const docId of r.evidenceDocumentIds) {
        await recordEvidenceLink(tx, { organisationId, companyId: r.companyId, source: { type: 'journal', id: journal.id }, target: { type: 'document', id: docId }, kind: 'SUPPORTS', createdByUserId: actor.userId, note: `Evidence for ${r.kind.toLowerCase().replace('_', ' ')} request` });
      }
    }
    const upd = await tx.journalRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status: decision, decidedByUserId: actor.userId, decidedAt: new Date(), decisionReason: note?.trim() || null, postedJournalId: journal?.id ?? null } });
    if (upd.count !== 1) throw conflict('The request changed concurrently', 'request_not_pending');
    await tx.auditEvent.createMany({ data: [auditRow({
      action: `ledger.request_${decision.toLowerCase()}`, organisationId, companyId: r.companyId, actorUserId: actor.userId, entityType: 'journal_request', entityId: id,
      before: { status: 'PENDING' }, after: { status: decision, journalId: journal?.id ?? null, selfApproved: decision === 'APPROVED' ? r.selfApproved : undefined }, reason: note?.trim() || null,
      metadata: { kind: r.kind, requestedBy: r.requestedByUserId, total: r.total.toFixed(4) },
    }, this.opts.captureDeviceMetadata)] });
    await publishEvent(tx, Events.ledgerRequestDecided, { aggregateId: id, organisationId, actorUserId: actor.userId,
      payload: { requestId: id, companyId: r.companyId, kind: r.kind as RequestKind, decision, requesterUserId: r.requestedByUserId, decidedByUserId: actor.userId, journalId: journal?.id ?? null } });
    return this.view(tx, await tx.journalRequest.findUniqueOrThrow({ where: { id } }));
  }

  private async view(tx: Tx, r: RequestRow) {
    return requestView(r, (await tx.currency.findUnique({ where: { code: r.currency } }))?.minorUnits ?? 2);
  }

  /** Evidence documents must exist in this organisation, belong to the company (or the organisation) and be readable by the requester. */
  private async checkEvidence(tx: Tx, companyId: string, ids: string[], actor: RequestActor) {
    if (ids.length === 0) return;
    const docs = await tx.document.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
    if (docs.length !== ids.length) throw unprocessable('One or more evidence documents do not exist', 'invalid_evidence');
    for (const d of docs) {
      if (d.companyId && d.companyId !== companyId) throw unprocessable('Evidence must belong to the same company as the request', 'invalid_evidence');
      const ok = actor.canReadDocument ? await actor.canReadDocument(d) : await actor.can('document:read', d.companyId ?? companyId);
      if (!ok) throw unprocessable('One or more evidence documents do not exist', 'invalid_evidence'); // an unreadable document is indistinguishable from a missing one
    }
  }
}
