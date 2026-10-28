import { createHash } from 'node:crypto';
import { CLOSING_SOURCES, CT_RULE_PARAMETERS, canonicalJson, ruleAdjustment, splitCtPeriods, type CtAdjustmentCategory, type CtRuleKind } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';

/**
 * V4-M1 (DEC-097): Corporation Tax rules, the company's tax profile and its CT accounting periods. A rule is organisation data entered with its
 * source, UNVERIFIED until a holder of tax:rule-verify who did not enter it verifies it, and changed only by a new version (the DEC-021 pattern).
 * No rate, limit or period length is written here: periods are split by the verified PERIOD_MAX_MONTHS rule for the year's start.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
type RuleRow = Awaited<ReturnType<Tx['ctRule']['findUniqueOrThrow']>>;
type PeriodRow = Awaited<ReturnType<Tx['ctPeriod']['findUniqueOrThrow']>>;
type AdjRuleRow = Awaited<ReturnType<Tx['ctAdjustmentRule']['findUniqueOrThrow']>>;
type AdjRow = Awaited<ReturnType<Tx['ctAdjustment']['findUniqueOrThrow']>>;
type Source = { url: string; provision: string; retrievedOn: string };
export interface CtActor { userId: string; kind?: string; can(permission: string, companyId: string): boolean | Promise<boolean>;
  canReadDocument?(d: { id: string; companyId: string | null; visibility: string; createdByUserId: string | null }): boolean | Promise<boolean> }

export const ctRuleView = (r: RuleRow) => ({
  id: r.id, jurisdiction: r.jurisdiction, kind: r.kind, effectiveFrom: isoDay(r.effectiveFrom), effectiveTo: r.effectiveTo ? isoDay(r.effectiveTo) : null, parameters: r.parameters as Record<string, unknown>,
  source: { url: r.sourceUrl, provision: r.sourceProvision, retrievedOn: isoDay(r.sourceRetrievedOn) }, enteredByUserId: r.enteredByUserId, createdAt: r.createdAt,
  verificationStatus: r.verificationStatus, verifiedByUserId: r.verifiedByUserId, verifiedAt: r.verifiedAt, verificationNotes: r.verificationNotes, evidenceDocumentId: r.evidenceDocumentId, supersededById: r.supersededById,
});
export const ctPeriodView = (p: PeriodRow) => ({
  id: p.id, companyId: p.companyId, frameworkId: p.frameworkId, startDate: isoDay(p.startDate), endDate: isoDay(p.endDate), periodRuleId: p.periodRuleId,
  associatedCompanies: p.associatedCompanies, associatedReason: p.associatedReason, version: p.version, createdByUserId: p.createdByUserId, createdAt: p.createdAt, updatedAt: p.updatedAt,
});

export const ctAdjustmentRuleView = (r: AdjRuleRow) => ({
  id: r.id, companyId: r.companyId, accountId: r.accountId, category: r.category, percentage: r.percentage.toFixed(2), effectiveFrom: isoDay(r.effectiveFrom), effectiveTo: r.effectiveTo ? isoDay(r.effectiveTo) : null,
  provision: r.provision, reason: r.reason, enteredByUserId: r.enteredByUserId, createdAt: r.createdAt,
  verificationStatus: r.verificationStatus, verifiedByUserId: r.verifiedByUserId, verifiedAt: r.verifiedAt, verificationNotes: r.verificationNotes, supersededById: r.supersededById,
});
export const ctAdjustmentView = (a: AdjRow) => ({
  id: a.id, companyId: a.companyId, periodId: a.periodId, category: a.category, direction: a.direction, amount: a.amount.toFixed(2), description: a.description, evidenceDocumentId: a.evidenceDocumentId,
  enteredByUserId: a.enteredByUserId, createdAt: a.createdAt, withdrawn: a.withdrawnAt ? { byUserId: a.withdrawnByUserId, at: a.withdrawnAt, reason: a.withdrawalReason } : null,
});
const CLOSING: string[] = [...CLOSING_SOURCES];
const TAX_LINE = 'PL.TAXATION';
const STATEMENT_NOTICE = 'The profit of the period adjusted for tax, before capital allowances and losses. It is read from the ledger each time and is not a tax computation.';
/** Adds two signed decimal strings exactly, in minor units. */
function addMoney(a: string, b: string, minor: number): string {
  const units = (s: string) => { const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.'); const v = BigInt(i! + f.padEnd(minor, '0').slice(0, minor)); return neg ? -v : v; };
  const t = units(a) + units(b), neg = t < 0n, abs = neg ? -t : t, scale = 10n ** BigInt(minor);
  return `${neg ? '-' : ''}${abs / scale}${minor ? `.${(abs % scale).toString().padStart(minor, '0')}` : ''}`;
}
const negate = (s: string) => (s.startsWith('-') ? s.slice(1) : /^[0.]+$/.test(s) ? s : `-${s}`);

export class CorporationTaxService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: CtActor, permission: string, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can change Corporation Tax records', 'ai_cannot_write');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }

  // ───── Rules ─────
  async listRules(tx: Tx, q: { kind?: CtRuleKind; includeSuperseded?: boolean }) {
    const rows = await tx.ctRule.findMany({ where: { ...(q.kind ? { kind: q.kind } : {}), ...(q.includeSuperseded ? {} : { supersededById: null }) }, orderBy: [{ kind: 'asc' }, { effectiveFrom: 'asc' }, { createdAt: 'asc' }] });
    return { items: rows.map(ctRuleView) };
  }
  async getRule(tx: Tx, id: string) { return ctRuleView(await this.rule(tx, id)); }
  private async rule(tx: Tx, id: string) {
    const r = await tx.ctRule.findFirst({ where: { id } });
    if (!r) throw notFound('Corporation Tax rule not found', 'ct_rule_not_found');
    return r;
  }
  private async insertRule(tx: Tx, a: { id?: string; organisationId: string; userId: string; kind: CtRuleKind; effectiveFrom: string; effectiveTo?: string; parameters: unknown; source: Source }) {
    const parameters = CT_RULE_PARAMETERS[a.kind].parse(a.parameters) as Prisma.InputJsonValue;   // the schema checked it; parsing again keeps only its own fields
    try {
      return await tx.ctRule.create({ data: { id: a.id, organisationId: a.organisationId, kind: a.kind, effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null,
        parameters, sourceUrl: a.source.url, sourceProvision: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn), enteredByUserId: a.userId } });
    } catch (e) {
      if (String((e as Error).message).includes('overlaps another current version')) throw conflict('These dates overlap another current version of this rule; supersede that version first', 'ct_rule_overlap');
      throw e;
    }
  }
  async addRule(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; kind: CtRuleKind; effectiveFrom: string; effectiveTo?: string; parameters: unknown; source: Source }) {
    await this.need(a.actor, 'ct:manage', a.companyId);
    const r = await this.insertRule(tx, { ...a, userId: a.actor.userId });
    await this.audit(tx, { action: 'ct.rule_added', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_rule', entityId: r.id, after: ctRuleView(r) });
    return ctRuleView(r);
  }
  /** Any change is a new UNVERIFIED version of the same kind; the old one stays for the periods and computations that used it. */
  async supersedeRule(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; kind: CtRuleKind; effectiveFrom: string; effectiveTo?: string; parameters: unknown; source: Source; reason: string }) {
    await this.need(a.actor, 'ct:manage', a.companyId);
    const old = await this.rule(tx, a.id);
    if (old.supersededById) throw conflict('This version was already superseded', 'ct_rule_superseded');
    if (old.kind !== a.kind) throw unprocessable('A new version keeps the kind of the version it replaces', 'kind_mismatch');
    const id = uuidv7();
    await tx.ctRule.update({ where: { id: old.id }, data: { supersededById: id } });
    const r = await this.insertRule(tx, { ...a, id, userId: a.actor.userId });
    await this.audit(tx, { action: 'ct.rule_superseded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_rule', entityId: old.id,
      before: ctRuleView(old), after: ctRuleView(r), reason: a.reason.trim() });
    return ctRuleView(r);
  }
  async verifyRule(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; notes: string; evidenceDocumentId?: string }) {
    await this.need(a.actor, 'tax:rule-verify', a.companyId);
    const r = await this.rule(tx, a.id);
    if (r.supersededById) throw conflict('A superseded version cannot be verified', 'ct_rule_superseded');
    if (r.verificationStatus === 'VERIFIED') throw conflict('This version is already verified', 'already_verified');
    if (r.enteredByUserId === a.actor.userId) throw forbidden('A Corporation Tax rule must be verified by someone other than the person who entered it', 'self_verification_not_allowed');
    if (a.evidenceDocumentId) {
      const d = await tx.document.findFirst({ where: { id: a.evidenceDocumentId }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
      const ok = d && (a.actor.canReadDocument ? await a.actor.canReadDocument(d) : await a.actor.can('document:read', d.companyId ?? a.companyId));
      if (!ok) throw unprocessable('The evidence document does not exist', 'invalid_evidence');
    }
    const v = await tx.ctRule.update({ where: { id: r.id }, data: { verificationStatus: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes.trim(), evidenceDocumentId: a.evidenceDocumentId ?? null } });
    await this.audit(tx, { action: 'ct.rule_verified', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_rule', entityId: r.id,
      before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED', kind: r.kind, source: { url: r.sourceUrl, provision: r.sourceProvision } }, reason: a.notes.trim() });
    return ctRuleView(v);
  }
  /** The current version of a kind covering a date; refused with a clear code when there is none or it is not verified. */
  async ruleFor(tx: Tx, kind: CtRuleKind, date: string): Promise<RuleRow> {
    const d = toDate(date);
    const r = await tx.ctRule.findFirst({ where: { kind, supersededById: null, effectiveFrom: { lte: d }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }] } });
    if (!r) throw unprocessable(`No ${kind} rule covers ${date}; enter it with its source first`, 'ct_rule_not_found', { kind, date });
    if (r.verificationStatus !== 'VERIFIED') throw unprocessable(`The ${kind} rule for ${date} has not been verified; someone other than the person who entered it must verify it first`, 'ct_rule_unverified', { kind, ruleId: r.id });
    return r;
  }

  // ───── The tax profile ─────
  async getProfile(tx: Tx, companyId: string) {
    const p = await tx.companyTaxProfile.findFirst({ where: { companyId } });
    return { companyId, utr: p?.utr ?? null, updatedByUserId: p?.updatedByUserId ?? null, updatedAt: p?.updatedAt ?? null };
  }
  async setProfile(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; utr: string | null; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    const before = await this.getProfile(tx, a.companyId);
    await tx.companyTaxProfile.upsert({ where: { organisationId_companyId: { organisationId: a.organisationId, companyId: a.companyId } },
      create: { organisationId: a.organisationId, companyId: a.companyId, utr: a.utr, updatedByUserId: a.actor.userId },
      update: { utr: a.utr, updatedByUserId: a.actor.userId, updatedAt: new Date() } });
    await this.audit(tx, { action: 'ct.tax_profile_set', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'company_tax_profile', entityId: a.companyId,
      before: { utr: before.utr }, after: { utr: a.utr }, reason: a.reason.trim() });
    return this.getProfile(tx, a.companyId);
  }

  // ───── CT accounting periods ─────
  async listPeriods(tx: Tx, companyId: string) {
    return { items: (await tx.ctPeriod.findMany({ where: { companyId }, orderBy: { startDate: 'asc' } })).map(ctPeriodView) };
  }
  /** The periods of an accounts year, split by the verified maximum for the year's start. Deriving again returns what exists. */
  async derivePeriods(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; yearStart: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    const fw = await tx.companyReportingFramework.findFirst({ where: { companyId: a.companyId, yearStart: toDate(a.yearStart) } });
    if (!fw) throw notFound('No accounts year of this company starts on that date', 'year_not_found');
    const existing = await tx.ctPeriod.findMany({ where: { companyId: a.companyId, frameworkId: fw.id }, orderBy: { startDate: 'asc' } });
    if (existing.length) {
      // the accounts year can be changed until it is approved; periods never change, so a changed year is reported rather than re-split
      if (isoDay(existing.at(-1)!.endDate) !== isoDay(fw.yearEnd)) throw conflict('The accounts year has changed since its CT accounting periods were derived', 'ct_periods_stale', { periods: existing.map(ctPeriodView) });
      return { created: false, items: existing.map(ctPeriodView) };
    }
    const rule = await this.ruleFor(tx, 'PERIOD_MAX_MONTHS', a.yearStart);
    const { months } = CT_RULE_PARAMETERS.PERIOD_MAX_MONTHS.parse(rule.parameters);
    const parts = splitCtPeriods(a.yearStart, isoDay(fw.yearEnd), months);
    const clash = await tx.ctPeriod.findFirst({ where: { companyId: a.companyId, startDate: { lte: fw.yearEnd }, endDate: { gte: fw.yearStart } } });
    if (clash) throw conflict('Another CT accounting period of this company covers part of this year', 'ct_period_overlap', { periodId: clash.id });
    const rows: PeriodRow[] = [];
    try {
      for (const p of parts) rows.push(await tx.ctPeriod.create({ data: { organisationId: a.organisationId, companyId: a.companyId, frameworkId: fw.id, startDate: toDate(p.start), endDate: toDate(p.end), periodRuleId: rule.id, createdByUserId: a.actor.userId } }));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('The periods of this year were derived at the same moment; read them again', 'ct_period_exists');
      throw e;
    }
    await this.audit(tx, { action: 'ct.periods_derived', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'company_reporting_framework', entityId: fw.id,
      after: { yearStart: a.yearStart, yearEnd: isoDay(fw.yearEnd), periodRuleId: rule.id, maxMonths: months, periods: rows.map((r) => ({ id: r.id, start: isoDay(r.startDate), end: isoDay(r.endDate) })) } });
    return { created: true, items: rows.map(ctPeriodView) };
  }
  async getPeriod(tx: Tx, companyId: string, id: string) {
    const p = await tx.ctPeriod.findFirst({ where: { id, companyId } });
    if (!p) throw notFound('CT accounting period not found', 'ct_period_not_found');
    return p;
  }
  async setAssociated(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; associatedCompanies: number; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    const before = await this.getPeriod(tx, a.companyId, a.id);
    const n = await tx.ctPeriod.updateMany({ where: { id: before.id, version: before.version }, data: { associatedCompanies: a.associatedCompanies, associatedReason: a.reason.trim(), version: before.version + 1 } });
    if (n.count !== 1) throw conflict('The period changed while you were editing it; read it again', 'version_conflict');
    const after = await this.getPeriod(tx, a.companyId, a.id);
    await this.audit(tx, { action: 'ct.associated_companies_set', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_period', entityId: a.id,
      before: { associatedCompanies: before.associatedCompanies, version: before.version }, after: { associatedCompanies: after.associatedCompanies, version: after.version }, reason: a.reason.trim() });
    return ctPeriodView(after);
  }

  // ───── V4-M2 (DEC-099): account adjustment rules ─────
  async listAdjustmentRules(tx: Tx, companyId: string, q: { accountId?: string; includeSuperseded?: boolean }) {
    const rows = await tx.ctAdjustmentRule.findMany({ where: { companyId, ...(q.accountId ? { accountId: q.accountId } : {}), ...(q.includeSuperseded ? {} : { supersededById: null }) },
      orderBy: [{ accountId: 'asc' }, { effectiveFrom: 'asc' }, { createdAt: 'asc' }] });
    return { items: rows.map(ctAdjustmentRuleView) };
  }
  private async adjustmentRule(tx: Tx, companyId: string, id: string) {
    const r = await tx.ctAdjustmentRule.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('Adjustment rule not found', 'adjustment_rule_not_found');
    return r;
  }
  private async insertAdjustmentRule(tx: Tx, a: { id?: string; organisationId: string; companyId: string; userId: string; accountId: string; category: CtAdjustmentCategory; percentage: string; effectiveFrom: string; effectiveTo?: string; provision?: string; reason: string }) {
    const acc = await tx.account.findFirst({ where: { id: a.accountId, companyId: a.companyId }, select: { type: true, reportingMapping: true } });
    if (!acc) throw notFound('Account not found', 'account_not_found');
    if (!['INCOME', 'EXPENSE'].includes(acc.type) || acc.reportingMapping === TAX_LINE) throw unprocessable('An adjustment rule names an income or expense account other than the tax charge', 'account_not_profit_and_loss');
    try {
      return await tx.ctAdjustmentRule.create({ data: { id: a.id, organisationId: a.organisationId, companyId: a.companyId, accountId: a.accountId, category: a.category, percentage: new Prisma.Decimal(a.percentage),
        effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null, provision: a.provision?.trim() ?? null, reason: a.reason.trim(), enteredByUserId: a.userId } });
    } catch (e) {
      if (String((e as Error).message).includes('overlaps another current rule')) throw conflict('These dates overlap another current rule of this account; supersede it first', 'adjustment_rule_overlap');
      throw e;
    }
  }
  async addAdjustmentRule(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; accountId: string; category: CtAdjustmentCategory; percentage: string; effectiveFrom: string; effectiveTo?: string; provision?: string; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    const r = await this.insertAdjustmentRule(tx, { ...a, userId: a.actor.userId });
    await this.audit(tx, { action: 'ct.adjustment_rule_added', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_adjustment_rule', entityId: r.id, after: ctAdjustmentRuleView(r), reason: r.reason });
    return ctAdjustmentRuleView(r);
  }
  async supersedeAdjustmentRule(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; category: CtAdjustmentCategory; percentage: string; effectiveFrom: string; effectiveTo?: string; provision?: string; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    const old = await this.adjustmentRule(tx, a.companyId, a.id);
    if (old.supersededById) throw conflict('This rule was already superseded', 'adjustment_rule_superseded');
    const id = uuidv7();
    await tx.ctAdjustmentRule.update({ where: { id: old.id }, data: { supersededById: id } });
    const r = await this.insertAdjustmentRule(tx, { ...a, id, accountId: old.accountId, userId: a.actor.userId });
    await this.audit(tx, { action: 'ct.adjustment_rule_superseded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_adjustment_rule', entityId: old.id,
      before: ctAdjustmentRuleView(old), after: ctAdjustmentRuleView(r), reason: a.reason.trim() });
    return ctAdjustmentRuleView(r);
  }
  async verifyAdjustmentRule(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; notes: string }) {
    await this.need(a.actor, 'tax:rule-verify', a.companyId);
    const r = await this.adjustmentRule(tx, a.companyId, a.id);
    if (r.supersededById) throw conflict('A superseded rule cannot be verified', 'adjustment_rule_superseded');
    if (r.verificationStatus === 'VERIFIED') throw conflict('This rule is already verified', 'already_verified');
    if (r.enteredByUserId === a.actor.userId) throw forbidden('An adjustment rule must be verified by someone other than the person who entered it', 'self_verification_not_allowed');
    const v = await tx.ctAdjustmentRule.update({ where: { id: r.id }, data: { verificationStatus: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes.trim() } });
    await this.audit(tx, { action: 'ct.adjustment_rule_verified', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_adjustment_rule', entityId: r.id,
      before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED' }, reason: a.notes.trim() });
    return ctAdjustmentRuleView(v);
  }

  // ───── V4-M2 (DEC-099): manual adjustments ─────
  async listAdjustments(tx: Tx, companyId: string, periodId: string) {
    await this.getPeriod(tx, companyId, periodId);
    return { items: (await tx.ctAdjustment.findMany({ where: { companyId, periodId }, orderBy: { createdAt: 'asc' } })).map(ctAdjustmentView) };
  }
  async addAdjustment(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; periodId: string; category: CtAdjustmentCategory; direction: 'ADD' | 'DEDUCT'; amount: string; description: string; evidenceDocumentId: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    await this.getPeriod(tx, a.companyId, a.periodId);
    const d = await tx.document.findFirst({ where: { id: a.evidenceDocumentId }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
    const readable = d && d.companyId === a.companyId && (a.actor.canReadDocument ? await a.actor.canReadDocument(d) : await a.actor.can('document:read', a.companyId));
    if (!readable) throw unprocessable('The evidence is not a document of this company that you can read', 'invalid_evidence');
    const r = await tx.ctAdjustment.create({ data: { organisationId: a.organisationId, companyId: a.companyId, periodId: a.periodId, category: a.category, direction: a.direction, amount: new Prisma.Decimal(a.amount),
      description: a.description.trim(), evidenceDocumentId: a.evidenceDocumentId, enteredByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'ct.adjustment_added', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_adjustment', entityId: r.id, after: ctAdjustmentView(r) });
    return ctAdjustmentView(r);
  }
  async withdrawAdjustment(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; periodId: string; id: string; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    const before = await tx.ctAdjustment.findFirst({ where: { id: a.id, companyId: a.companyId, periodId: a.periodId } });
    if (!before) throw notFound('Adjustment not found', 'adjustment_not_found');
    if (before.withdrawnAt) throw conflict('This adjustment is already withdrawn', 'adjustment_withdrawn');
    const r = await tx.ctAdjustment.update({ where: { id: before.id }, data: { withdrawnAt: new Date(), withdrawnByUserId: a.actor.userId, withdrawalReason: a.reason.trim() } });
    await this.audit(tx, { action: 'ct.adjustment_withdrawn', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_adjustment', entityId: r.id,
      before: { withdrawn: false }, after: { withdrawn: true }, reason: a.reason.trim() });
    return ctAdjustmentView(r);
  }

  // ───── V4-M2 (DEC-099): the profit of a CT period adjusted for tax ─────
  private async movements(tx: Tx, companyId: string, from: string, to: string, accountId?: string) {
    return tx.$queryRaw<{ account_id: string; code: string; name: string; type: string; reporting_mapping: string; d: string; c: string }[]>`
      SELECT l.account_id, a.code, a.name, a.type::text AS type, a.reporting_mapping, sum(l.debit)::text AS d, sum(l.credit)::text AS c
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date >= ${from}::date AND j.journal_date <= ${to}::date AND j.source_type <> ALL(${CLOSING}::text[])
         AND (${accountId ?? null}::uuid IS NULL OR l.account_id = ${accountId ?? null}::uuid)
       GROUP BY l.account_id, a.code, a.name, a.type, a.reporting_mapping ORDER BY a.code`;
  }
  async adjustedProfit(tx: Tx, companyId: string, periodId: string) {
    const p = await this.getPeriod(tx, companyId, periodId);
    const from = isoDay(p.startDate), to = isoDay(p.endDate);
    const co = await tx.company.findFirstOrThrow({ where: { id: companyId }, select: { baseCurrency: true } });
    const minor = (await tx.currency.findUnique({ where: { code: co.baseCurrency } }))?.minorUnits ?? 2;
    const zero = minor ? `0.${'0'.repeat(minor)}` : '0';
    const pl = (await this.movements(tx, companyId, from, to)).filter((m) => (m.type === 'INCOME' || m.type === 'EXPENSE') && m.reporting_mapping !== TAX_LINE);
    let accountingProfit = zero;
    for (const m of pl) accountingProfit = addMoney(accountingProfit, addMoney(m.c, negate(m.d), minor), minor);

    const rules = await tx.ctAdjustmentRule.findMany({ where: { companyId, supersededById: null, effectiveFrom: { lte: p.endDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: p.startDate } }] }, orderBy: [{ effectiveFrom: 'asc' }] });
    const accounts = new Map((await tx.account.findMany({ where: { id: { in: rules.map((r) => r.accountId) } }, select: { id: true, code: true, name: true } })).map((x) => [x.id, x]));
    const adjustments: Record<string, unknown>[] = [];
    const problems: string[] = [];
    for (const r of rules) {
      const rf = isoDay(r.effectiveFrom) > from ? isoDay(r.effectiveFrom) : from, rt = r.effectiveTo && isoDay(r.effectiveTo) < to ? isoDay(r.effectiveTo) : to;
      const m = (await this.movements(tx, companyId, rf, rt, r.accountId))[0];
      const amount = ruleAdjustment(m?.d ?? '0', m?.c ?? '0', r.percentage.toFixed(2), minor);
      if (/^-?[0.]+$/.test(amount)) continue;
      const acc = accounts.get(r.accountId)!;
      if (r.verificationStatus !== 'VERIFIED') problems.push(`The rule for account ${acc.code} ${acc.name} (${r.category}) has not been verified`);
      adjustments.push({ source: 'RULE', ruleId: r.id, category: r.category, direction: amount.startsWith('-') ? 'DEDUCT' : 'ADD', amount: amount.replace('-', ''),
        account: { id: acc.id, code: acc.code, name: acc.name }, debits: m?.d ?? zero, credits: m?.c ?? zero, percentage: r.percentage.toFixed(2), verificationStatus: r.verificationStatus,
        description: `${r.percentage.toFixed(2)}% of the net debit of ${acc.code} ${acc.name}, ${rf} to ${rt}`, drilldown: { accountId: acc.id, from: rf, to: rt, excludeClosing: true } });
    }
    for (const a of await tx.ctAdjustment.findMany({ where: { companyId, periodId, withdrawnAt: null }, orderBy: { createdAt: 'asc' } })) {
      adjustments.push({ source: 'MANUAL', adjustmentId: a.id, category: a.category, direction: a.direction, amount: a.amount.toFixed(minor), description: a.description, evidenceDocumentId: a.evidenceDocumentId });
    }
    if (p.associatedReason === null) problems.push('The number of associated companies has not been set with a reason');
    let added = zero, deducted = zero;
    for (const a of adjustments as { direction: string; amount: string }[]) { if (a.direction === 'ADD') added = addMoney(added, a.amount, minor); else deducted = addMoney(deducted, a.amount, minor); }
    const adjustedProfit = addMoney(addMoney(accountingProfit, added, minor), negate(deducted), minor);
    const statement = { periodId: p.id, companyId, startDate: from, endDate: to, currency: co.baseCurrency, accountingProfit, adjustments, totalAdded: added, totalDeducted: deducted, adjustedProfit, problems };
    return { ...statement, fingerprint: createHash('sha256').update(canonicalJson(statement)).digest('hex'), notice: STATEMENT_NOTICE };
  }
}
