import {
  FINAL_STATUSES, RULE_ANCHORS, RULE_KINDS, addDaysIso, addMonthsIso, dueDateFor, isOverdue,
  type DueWindow, type ObligationKind, type ObligationStatus, type RuleKind,
} from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { vatPeriodFor } from './vat';

/**
 * V7-M1 compliance calendar (DEC-088). Deadline rules are sourced organisation data, used only once a second person verified them (the DEC-021
 * pattern); obligations are what a client must file or pay. No date figure is built in: every due date comes from a verified rule version, or
 * is typed by a person with a reason. Nothing here files anything (DEC-082, DEC-086).
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** Today in the United Kingdom: deadlines are UK dates, so the day turns over at midnight in London, not UTC. */
export const ukToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export interface ComplianceActor { userId: string; kind?: string; can(permission: string, companyId?: string): boolean | Promise<boolean>;
  canReadDocument?(d: { id: string; companyId: string | null; visibility: string; createdByUserId: string | null }): boolean | Promise<boolean> }
type RuleRow = Awaited<ReturnType<Tx['deadlineRule']['findUniqueOrThrow']>>;
type ObligationRow = Awaited<ReturnType<Tx['complianceObligation']['findUniqueOrThrow']>>;
interface RuleInput { kind: RuleKind; legalForms: string[]; daysBeforeMonths: number; months: number; daysAfterMonths: number; monthEndRule: boolean;
  effectiveFrom: string; effectiveTo?: string; source: { url: string; provision: string; retrievedOn: string } }

export const deadlineRuleView = (r: RuleRow) => ({
  id: r.id, kind: r.kind, legalForms: r.legalForms, daysBeforeMonths: r.daysBeforeMonths, months: r.months, daysAfterMonths: r.daysAfterMonths, monthEndRule: r.monthEndRule,
  effectiveFrom: isoDay(r.effectiveFrom), effectiveTo: r.effectiveTo ? isoDay(r.effectiveTo) : null,
  source: { url: r.sourceUrl, provision: r.sourceProvision, retrievedOn: isoDay(r.sourceRetrievedOn) }, enteredByUserId: r.enteredByUserId, createdAt: r.createdAt,
  verificationStatus: r.verificationStatus, verifiedByUserId: r.verifiedByUserId, verifiedAt: r.verifiedAt, verificationNotes: r.verificationNotes,
  evidenceDocumentId: r.evidenceDocumentId, supersededById: r.supersededById,
});
export const obligationView = (o: ObligationRow, today: string, companyName?: string) => {
  const due = isoDay(o.dueDate);
  return {
    id: o.id, companyId: o.companyId, ...(companyName !== undefined ? { companyName } : {}), kind: o.kind, title: o.title,
    periodStart: o.periodStart ? isoDay(o.periodStart) : null, periodEnd: o.periodEnd ? isoDay(o.periodEnd) : null, dueDate: due,
    source: o.source, deadlineRuleId: o.deadlineRuleId, status: o.status, overdue: isOverdue({ dueDate: due, status: o.status }, today),
    assigneeUserId: o.assigneeUserId, doneOn: o.doneOn ? isoDay(o.doneOn) : null, doneReference: o.doneReference, evidenceDocumentId: o.evidenceDocumentId,
    statusReason: o.statusReason, version: o.version, createdByUserId: o.createdByUserId, createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
};

/** The `where` fragment of a due window on `today` (DEC-088). */
export function dueWindowWhere(due: DueWindow, today: string): Prisma.ComplianceObligationWhereInput {
  const open = { status: { notIn: [...FINAL_STATUSES] } };
  const t = toDate(today);
  switch (due) {
    case 'overdue': return { ...open, dueDate: { lt: t } };
    case 'next14': return { ...open, dueDate: { gte: t, lte: toDate(addDaysIso(today, 14)) } };
    case 'soon': return { ...open, dueDate: { lte: toDate(addDaysIso(today, 14)) } };
    case 'next90': return { ...open, dueDate: { gte: t, lte: toDate(addDaysIso(today, 90)) } };
    case 'open': return open;
    case 'all': return {};
  }
}

export class ComplianceService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: ComplianceActor, permission: string, companyId?: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can change compliance records', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async readableEvidence(tx: Tx, actor: ComplianceActor, id: string, companyId: string | null) {
    // an unreadable document is indistinguishable from a missing one; an obligation's evidence must belong to its own client
    const d = await tx.document.findFirst({ where: { id }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
    const ok = d && (companyId === null || d.companyId === companyId) && (actor.canReadDocument ? await actor.canReadDocument(d) : await actor.can('document:read', d.companyId ?? undefined));
    if (!ok) throw unprocessable('The evidence document does not exist', 'invalid_evidence');
  }
  private async activeMember(tx: Tx, userId: string) {
    const m = await tx.organisationMembership.findFirst({ where: { userId, status: 'ACTIVE' }, select: { id: true } });
    if (!m) throw unprocessable('The owner must be an active member of the organisation', 'invalid_assignee');
  }

  // ───── Deadline rules (organisation data) ─────
  async listRules(tx: Tx, q: { includeSuperseded?: boolean } = {}) {
    const rows = await tx.deadlineRule.findMany({ where: q.includeSuperseded ? {} : { supersededById: null }, orderBy: [{ kind: 'asc' }, { effectiveFrom: 'asc' }, { createdAt: 'asc' }] });
    return { items: rows.map(deadlineRuleView) };
  }
  private async insertRule(tx: Tx, a: RuleInput & { organisationId: string; userId: string; id?: string }) {
    try {
      return await tx.deadlineRule.create({ data: { id: a.id, organisationId: a.organisationId, kind: a.kind, legalForms: a.legalForms, daysBeforeMonths: a.daysBeforeMonths,
        months: a.months, daysAfterMonths: a.daysAfterMonths, monthEndRule: a.monthEndRule, effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null,
        sourceUrl: a.source.url, sourceProvision: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn), enteredByUserId: a.userId } });
    } catch (e) {
      if (String((e as Error).message).includes('overlaps another current version')) throw conflict('These dates overlap a current version of this kind for one of these legal forms; supersede that version first', 'deadline_rule_overlap');
      throw e;
    }
  }
  async addRule(tx: Tx, a: RuleInput & { organisationId: string; actor: ComplianceActor }) {
    await this.need(a.actor, 'compliance:rules-manage');
    const r = await this.insertRule(tx, { ...a, userId: a.actor.userId });
    await this.audit(tx, { action: 'compliance.rule_added', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'deadline_rule', entityId: r.id,
      after: { ...deadlineRuleView(r), verification: 'UNVERIFIED' } });
    return deadlineRuleView(r);
  }
  /** Any change of a rule is a new version that is UNVERIFIED again; obligations already generated keep the version they came from. */
  async supersedeRule(tx: Tx, a: RuleInput & { organisationId: string; actor: ComplianceActor; id: string; reason: string }) {
    await this.need(a.actor, 'compliance:rules-manage');
    const old = await tx.deadlineRule.findFirst({ where: { id: a.id } });
    if (!old) throw notFound('Deadline rule not found');
    if (old.supersededById) throw conflict('This version was already superseded', 'deadline_rule_superseded');
    const newId = uuidv7();
    await tx.deadlineRule.update({ where: { id: old.id }, data: { supersededById: newId } });
    const r = await this.insertRule(tx, { ...a, id: newId, userId: a.actor.userId });
    await this.audit(tx, { action: 'compliance.rule_superseded', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'deadline_rule', entityId: old.id,
      before: deadlineRuleView(old), after: deadlineRuleView(r), reason: a.reason });
    return deadlineRuleView(r);
  }
  /** A holder of compliance:rule-verify who did not enter the version records what was checked against which source. */
  async verifyRule(tx: Tx, a: { organisationId: string; actor: ComplianceActor; id: string; notes: string; evidenceDocumentId?: string }) {
    await this.need(a.actor, 'compliance:rule-verify');
    const r = await tx.deadlineRule.findFirst({ where: { id: a.id } });
    if (!r) throw notFound('Deadline rule not found');
    if (r.supersededById) throw conflict('A superseded version cannot be verified', 'deadline_rule_superseded');
    if (r.verificationStatus === 'VERIFIED') throw conflict('This version is already verified', 'already_verified');
    if (r.enteredByUserId === a.actor.userId) throw forbidden('A deadline rule must be verified by someone other than the person who entered it', 'self_verification_not_allowed');
    if (a.evidenceDocumentId) await this.readableEvidence(tx, a.actor, a.evidenceDocumentId, null);
    const v = await tx.deadlineRule.update({ where: { id: r.id }, data: { verificationStatus: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(),
      verificationNotes: a.notes.trim(), evidenceDocumentId: a.evidenceDocumentId ?? null } });
    await this.audit(tx, { action: 'compliance.rule_verified', organisationId: a.organisationId, actorUserId: a.actor.userId, entityType: 'deadline_rule', entityId: r.id,
      before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED', source: { url: r.sourceUrl, provision: r.sourceProvision } }, reason: a.notes.trim() });
    return deadlineRuleView(v);
  }

  // ───── A client's profile ─────
  async getProfile(tx: Tx, companyId: string) {
    const p = await tx.companyComplianceProfile.findFirst({ where: { companyId } });
    return { companyId, confirmationDate: p?.confirmationDate ? isoDay(p.confirmationDate) : null, updatedByUserId: p?.updatedByUserId ?? null, updatedAt: p?.updatedAt ?? null };
  }
  async setProfile(tx: Tx, a: { organisationId: string; companyId: string; actor: ComplianceActor; confirmationDate: string | null; reason: string }) {
    await this.need(a.actor, 'compliance:manage', a.companyId);
    const before = await this.getProfile(tx, a.companyId);
    const data = { confirmationDate: a.confirmationDate ? toDate(a.confirmationDate) : null, updatedByUserId: a.actor.userId, updatedAt: new Date() };
    await tx.companyComplianceProfile.upsert({ where: { organisationId_companyId: { organisationId: a.organisationId, companyId: a.companyId } },
      create: { organisationId: a.organisationId, companyId: a.companyId, ...data }, update: data });
    await this.audit(tx, { action: 'compliance.profile_set', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'company_compliance_profile',
      entityId: a.companyId, before: { confirmationDate: before.confirmationDate }, after: { confirmationDate: a.confirmationDate }, reason: a.reason });
    return this.getProfile(tx, a.companyId);
  }

  // ───── Generation ─────
  /** Anchors of each rule kind for a client inside [from, through]: accounting period ends, VAT period ends, confirmation dates (DEC-088). */
  private async anchors(tx: Tx, companyId: string, from: string, through: string) {
    const out: { kind: RuleKind; periodStart: string | null; anchor: string }[] = [];
    const notApplicable: { kind: RuleKind; reason: string }[] = [];
    const periods = await tx.accountingPeriod.findMany({ where: { companyId, endDate: { gte: toDate(from), lte: toDate(through) } }, orderBy: { endDate: 'asc' } });
    for (const kind of RULE_KINDS.filter((k) => RULE_ANCHORS[k] === 'ACCOUNTING_PERIOD_END'))
      for (const p of periods) out.push({ kind, periodStart: isoDay(p.startDate), anchor: isoDay(p.endDate) });
    const vat = await tx.companyVatSetting.findFirst({ where: { companyId } });
    if (vat?.registered && vat.anchorPeriodEnd && vat.registeredFrom) {
      const reg = isoDay(vat.registeredFrom), anchor = isoDay(vat.anchorPeriodEnd);
      let p = vatPeriodFor(from > reg ? from : reg, anchor, vat.periodMonths);
      for (let i = 0; i < 200 && p.to <= through; i++) {
        if (p.to >= from) out.push({ kind: 'VAT_RETURN', periodStart: p.from > reg ? p.from : reg, anchor: p.to });
        p = vatPeriodFor(addDaysIso(p.to, 1), anchor, vat.periodMonths);
      }
    } else notApplicable.push({ kind: 'VAT_RETURN', reason: 'The client is not VAT registered' });
    const profile = await tx.companyComplianceProfile.findFirst({ where: { companyId } });
    if (profile?.confirmationDate) {
      const base = isoDay(profile.confirmationDate);
      for (let k = -12; k <= 12; k++) { const d = addMonthsIso(base, 12 * k); if (d >= from && d <= through) out.push({ kind: 'CONFIRMATION_STATEMENT', periodStart: null, anchor: d }); }
    } else notApplicable.push({ kind: 'CONFIRMATION_STATEMENT', reason: 'No confirmation date on the client\'s compliance profile' });
    return { anchors: out, notApplicable };
  }

  /** Creates the RULE obligations that are missing between `from` and `through`; reports what existed and what was skipped and why. Idempotent. */
  async generate(tx: Tx, a: { organisationId: string; companyId: string; actor: ComplianceActor; from?: string; through: string; today?: string }) {
    await this.need(a.actor, 'compliance:manage', a.companyId);
    const company = await tx.company.findFirst({ where: { id: a.companyId }, select: { legalForm: true } });
    if (!company) throw notFound('Company not found');
    const from = a.from ?? addMonthsIso(a.through, -12);
    const { anchors, notApplicable } = await this.anchors(tx, a.companyId, from, a.through);
    const rules = await tx.deadlineRule.findMany({ where: { supersededById: null, legalForms: { has: company.legalForm } } });
    const existing = new Set((await tx.complianceObligation.findMany({ where: { companyId: a.companyId, source: 'RULE' }, select: { kind: true, periodEnd: true } }))
      .map((o) => `${o.kind}|${o.periodEnd ? isoDay(o.periodEnd) : ''}`));
    const skipped: { kind: RuleKind; anchor: string; reason: string }[] = [];
    const rows: Prisma.ComplianceObligationCreateManyInput[] = [];
    let alreadyThere = 0;
    for (const x of anchors) {
      const ofKind = rules.filter((r) => r.kind === x.kind);
      if (ofKind.length === 0) { if (!notApplicable.some((n) => n.kind === x.kind)) notApplicable.push({ kind: x.kind, reason: `No deadline rule of this kind applies to the legal form ${company.legalForm}` }); continue; }
      if (existing.has(`${x.kind}|${x.anchor}`)) { alreadyThere++; continue; }
      const covering = ofKind.filter((r) => isoDay(r.effectiveFrom) <= x.anchor && (!r.effectiveTo || isoDay(r.effectiveTo) >= x.anchor));
      const rule = covering.find((r) => r.verificationStatus === 'VERIFIED');
      if (!rule) { skipped.push({ kind: x.kind, anchor: x.anchor, reason: covering.length ? 'rule_unverified' : 'no_rule_for_date' }); continue; }
      rows.push({ id: uuidv7(), organisationId: a.organisationId, companyId: a.companyId, kind: x.kind, periodStart: x.periodStart ? toDate(x.periodStart) : null, periodEnd: toDate(x.anchor),
        dueDate: toDate(dueDateFor(x.anchor, rule)), source: 'RULE', deadlineRuleId: rule.id, createdByUserId: a.actor.userId });
    }
    const created = rows.length ? (await tx.complianceObligation.createMany({ data: rows, skipDuplicates: true })).count : 0;
    const today = a.today ?? ukToday();
    await this.audit(tx, { action: 'compliance.obligations_generated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'company', entityId: a.companyId,
      after: { from, through: a.through, created, existing: alreadyThere + rows.length - created, skipped: skipped.length, ids: rows.map((r) => r.id) } });
    const made = rows.length ? await tx.complianceObligation.findMany({ where: { id: { in: rows.map((r) => r.id!) } }, orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }] }) : [];
    return { from, through: a.through, created: made.map((o) => obligationView(o, today)), existing: alreadyThere + rows.length - created, skipped, notApplicable };
  }

  // ───── Obligations ─────
  async listForCompany(tx: Tx, companyId: string, q: { due: DueWindow; status?: ObligationStatus; kind?: ObligationKind }, today = ukToday()) {
    const rows = await tx.complianceObligation.findMany({ where: { companyId, ...dueWindowWhere(q.due, today), ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}) },
      orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }, { id: 'asc' }] });
    return { today, items: rows.map((o) => obligationView(o, today)) };
  }
  async get(tx: Tx, companyId: string, id: string, today = ukToday()) {
    const o = await tx.complianceObligation.findFirst({ where: { id, companyId } });
    if (!o) throw notFound('Obligation not found');
    return obligationView(o, today);
  }
  async create(tx: Tx, a: { organisationId: string; companyId: string; actor: ComplianceActor; kind: ObligationKind; title?: string; periodStart?: string; periodEnd?: string;
    dueDate: string; assigneeUserId: string | null; reason: string; today?: string }) {
    await this.need(a.actor, 'compliance:manage', a.companyId);
    if (a.assigneeUserId) await this.activeMember(tx, a.assigneeUserId);
    const o = await tx.complianceObligation.create({ data: { organisationId: a.organisationId, companyId: a.companyId, kind: a.kind, title: a.title?.trim() ?? null,
      periodStart: a.periodStart ? toDate(a.periodStart) : null, periodEnd: a.periodEnd ? toDate(a.periodEnd) : null, dueDate: toDate(a.dueDate), source: 'MANUAL',
      assigneeUserId: a.assigneeUserId, createdByUserId: a.actor.userId } });
    const v = obligationView(o, a.today ?? ukToday());
    await this.audit(tx, { action: 'compliance.obligation_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'compliance_obligation',
      entityId: o.id, after: { kind: v.kind, title: v.title, periodStart: v.periodStart, periodEnd: v.periodEnd, dueDate: v.dueDate, source: 'MANUAL', assigneeUserId: v.assigneeUserId }, reason: a.reason });
    return v;
  }

  /** Versioned update (DEC-088): DONE needs its date; NOT_REQUIRED, reopening a final status and moving a due date need a reason. */
  async update(tx: Tx, a: { organisationId: string; companyId: string; actor: ComplianceActor; id: string; version: number; status?: ObligationStatus; assigneeUserId?: string | null;
    dueDate?: string; doneOn?: string; doneReference?: string | null; evidenceDocumentId?: string | null; reason?: string; today?: string }) {
    await this.need(a.actor, 'compliance:manage', a.companyId);
    const o = await tx.complianceObligation.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!o) throw notFound('Obligation not found');
    if (o.version !== a.version) throw conflict('This obligation was changed by someone else; reload it and try again', 'stale_version', { currentVersion: o.version });
    const reason = a.reason?.trim();
    const was = o.status as ObligationStatus, status = a.status ?? was;
    const wasFinal = FINAL_STATUSES.includes(was), changes = status !== was;
    if (changes && wasFinal && !reason) throw unprocessable(`Reopening a ${was === 'DONE' ? 'done' : 'not required'} obligation needs a reason`, 'reason_required');
    if (status === 'NOT_REQUIRED' && changes && !reason) throw unprocessable('Marking an obligation not required needs a reason', 'reason_required');
    if (a.dueDate !== undefined && a.dueDate !== isoDay(o.dueDate) && !reason) throw unprocessable('Moving a due date needs a reason (an extension, first accounts, a long period)', 'reason_required');
    if (status !== 'DONE' && (a.doneOn !== undefined || a.doneReference !== undefined)) throw unprocessable('A done date and reference belong to a DONE obligation', 'not_done');
    const doneOn = status === 'DONE' ? a.doneOn ?? (o.doneOn ? isoDay(o.doneOn) : undefined) : undefined;
    if (status === 'DONE' && !doneOn) throw unprocessable('Say when it was done (doneOn)', 'done_on_required');
    if (doneOn && doneOn > (a.today ?? ukToday())) throw unprocessable('The done date cannot be in the future', 'done_on_future');
    if (a.assigneeUserId) await this.activeMember(tx, a.assigneeUserId);
    if (a.evidenceDocumentId) await this.readableEvidence(tx, a.actor, a.evidenceDocumentId, a.companyId);
    const data: Prisma.ComplianceObligationUpdateInput = {
      version: o.version + 1, status,
      doneOn: doneOn ? toDate(doneOn) : null,
      doneReference: status === 'DONE' ? (a.doneReference !== undefined ? a.doneReference : o.doneReference) : null,
      statusReason: changes ? (reason ?? null) : status === 'NOT_REQUIRED' ? o.statusReason : (reason ?? o.statusReason),
      ...(a.assigneeUserId !== undefined ? { assigneeUserId: a.assigneeUserId } : {}),
      ...(a.dueDate !== undefined ? { dueDate: toDate(a.dueDate) } : {}),
      ...(a.evidenceDocumentId !== undefined ? { evidenceDocumentId: a.evidenceDocumentId } : {}),
    };
    let after: ObligationRow;
    try {
      after = await tx.complianceObligation.update({ where: { id: o.id }, data });
    } catch (e) {
      if (String((e as Error).message).includes('advance its version')) throw conflict('This obligation was changed by someone else; reload it and try again', 'stale_version');
      throw e;
    }
    const today = a.today ?? ukToday();
    const pick = (x: ReturnType<typeof obligationView>) => ({ status: x.status, dueDate: x.dueDate, assigneeUserId: x.assigneeUserId, doneOn: x.doneOn, doneReference: x.doneReference, evidenceDocumentId: x.evidenceDocumentId, version: x.version });
    await this.audit(tx, { action: 'compliance.obligation_updated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'compliance_obligation',
      entityId: o.id, before: pick(obligationView(o, today)), after: pick(obligationView(after, today)), reason });
    return obligationView(after, today);
  }

  // ───── Practice-wide views (only the clients the caller may read) ─────
  async listForPractice(tx: Tx, companyIds: string[] | 'ALL', q: { due: DueWindow; status?: ObligationStatus; kind?: ObligationKind; companyId?: string; assigneeUserId?: string; limit: number; cursor?: string },
    today = ukToday()) {
    if (companyIds !== 'ALL' && companyIds.length === 0) return { today, items: [], nextCursor: null };
    if (q.companyId && companyIds !== 'ALL' && !companyIds.includes(q.companyId)) return { today, items: [], nextCursor: null };
    const scope: Prisma.ComplianceObligationWhereInput = q.companyId ? { companyId: q.companyId } : companyIds === 'ALL' ? {} : { companyId: { in: companyIds } };
    let after: Prisma.ComplianceObligationWhereInput = {};
    if (q.cursor) {
      const [d, id] = q.cursor.split('|');
      if (!d || !id || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw unprocessable('Invalid cursor', 'invalid_cursor');
      after = { OR: [{ dueDate: { gt: toDate(d) } }, { dueDate: toDate(d), id: { gt: id } }] };
    }
    const rows = await tx.complianceObligation.findMany({
      where: { AND: [scope, dueWindowWhere(q.due, today), after, q.status ? { status: q.status } : {}, q.kind ? { kind: q.kind } : {}, q.assigneeUserId ? { assigneeUserId: q.assigneeUserId } : {}] },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const names = new Map((await tx.company.findMany({ where: { id: { in: [...new Set(page.map((o) => o.companyId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const last = page[page.length - 1];
    return { today, items: page.map((o) => obligationView(o, today, names.get(o.companyId) ?? '')), nextCursor: rows.length > q.limit && last ? `${isoDay(last.dueDate)}|${last.id}` : null };
  }
  async summary(tx: Tx, companyIds: string[] | 'ALL', today = ukToday()) {
    if (companyIds !== 'ALL' && companyIds.length === 0) return { today, overdue: 0, dueNext14: 0, waitingOnClient: 0, ready: 0 };
    const scope: Prisma.ComplianceObligationWhereInput = companyIds === 'ALL' ? {} : { companyId: { in: companyIds } };
    const count = (w: Prisma.ComplianceObligationWhereInput) => tx.complianceObligation.count({ where: { AND: [scope, w] } });
    const [overdue, dueNext14, waitingOnClient, ready] = await Promise.all([
      count(dueWindowWhere('overdue', today)), count(dueWindowWhere('next14', today)), count({ status: 'WAITING_ON_CLIENT' }), count({ status: 'READY' }),
    ]);
    return { today, overdue, dueNext14, waitingOnClient, ready };
  }
}
