import { CT_RULE_PARAMETERS, splitCtPeriods, type CtRuleKind } from '@uk/contracts';
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
}
