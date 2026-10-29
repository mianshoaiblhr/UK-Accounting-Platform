import { createHash } from 'node:crypto';
import { CT_RULE_PARAMETERS, canonicalJson, computeCorporationTax, endAfterMonths, financialYearParts, type CtComputationResult, type CtRates } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import type { CapitalAllowanceService } from './capital-allowances';
import type { CorporationTaxService, CtActor } from './corporation-tax';

/**
 * V4-M4 (DEC-101): the Corporation Tax computation of a CT period: the adjusted profit (V4-M2) less the stored capital allowances (V4-M3), losses
 * brought forward and carried back, and tax by financial year from verified CT_RATES rules. Prepared by one person, approved by another; the
 * canonical CT600 is built from the approved computation. The arithmetic is `computeCorporationTax` in @uk/contracts.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const shift = (s: string, days: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + days); return isoDay(d); };
type LossRow = Awaited<ReturnType<Tx['ctLossOpening']['findUniqueOrThrow']>>;
type CompRow = Awaited<ReturnType<Tx['ctComputation']['findUniqueOrThrow']>>;
type Statement = { result: CtComputationResult; neighbours: Neighbours; [k: string]: unknown };
type Neighbours = { previous: { periodId: string; computationId: string; lossesCarriedForward: string; profitsBeforeCarryBack: string } | null; following: { periodId: string; computationId: string; carryBack: string } | null; lossOpeningId: string | null };
const NOTICE = 'All of the adjusted profit is treated as trading profit: non-trading income, chargeable gains, distributions, group relief, the deductions allowance and instalment payments are not modelled. Nothing is filed.';

export const lossOpeningView = (o: LossRow) => ({
  id: o.id, companyId: o.companyId, asOf: isoDay(o.asOf), amount: o.amount.toFixed(2), evidenceDocumentId: o.evidenceDocumentId, reason: o.reason, enteredByUserId: o.enteredByUserId, createdAt: o.createdAt,
  verificationStatus: o.verificationStatus, verifiedByUserId: o.verifiedByUserId, verifiedAt: o.verifiedAt, verificationNotes: o.verificationNotes, supersededById: o.supersededById,
});
const computationView = (c: CompRow, stale = false) => ({
  id: c.id, periodId: c.periodId, status: c.status, fingerprint: c.fingerprint, carryBack: c.carryBack.toFixed(2), neighbours: c.neighbours as Neighbours, preparedByUserId: c.preparedByUserId, preparedAt: c.preparedAt,
  approval: c.approvedByUserId ? { byUserId: c.approvedByUserId, at: c.approvedAt, notes: c.approvalNotes } : null, supersededById: c.supersededById, stale, snapshot: c.snapshot as Record<string, unknown>,
});

export class CtComputationService {
  constructor(private readonly ct: CorporationTaxService, private readonly ca: CapitalAllowanceService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: CtActor, permission: string, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can prepare or approve a tax computation', 'ai_cannot_write');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }

  // ───── Loss opening balances ─────
  async listLossOpenings(tx: Tx, companyId: string) {
    return { items: (await tx.ctLossOpening.findMany({ where: { companyId }, orderBy: [{ asOf: 'asc' }, { createdAt: 'asc' }] })).map(lossOpeningView) };
  }
  private async evidence(tx: Tx, actor: CtActor, companyId: string, id: string) {
    const d = await tx.document.findFirst({ where: { id }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
    const ok = d && d.companyId === companyId && (actor.canReadDocument ? await actor.canReadDocument(d) : await actor.can('document:read', companyId));
    if (!ok) throw unprocessable('The evidence is not a document of this company that you can read', 'invalid_evidence');
  }
  async addLossOpening(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; asOf: string; amount: string; evidenceDocumentId: string; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    await this.evidence(tx, a.actor, a.companyId, a.evidenceDocumentId);
    let o: LossRow;
    try {
      o = await tx.ctLossOpening.create({ data: { organisationId: a.organisationId, companyId: a.companyId, asOf: toDate(a.asOf), amount: new Prisma.Decimal(a.amount), evidenceDocumentId: a.evidenceDocumentId, reason: a.reason.trim(), enteredByUserId: a.actor.userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('There is already a current loss opening balance at that date; supersede it', 'loss_opening_exists');
      throw e;
    }
    await this.audit(tx, { action: 'ct.loss_opening_added', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_loss_opening', entityId: o.id, after: lossOpeningView(o), reason: o.reason });
    return lossOpeningView(o);
  }
  private async lossOpening(tx: Tx, companyId: string, id: string) {
    const o = await tx.ctLossOpening.findFirst({ where: { id, companyId } });
    if (!o) throw notFound('Loss opening balance not found', 'loss_opening_not_found');
    return o;
  }
  async supersedeLossOpening(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; amount: string; evidenceDocumentId: string; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    const old = await this.lossOpening(tx, a.companyId, a.id);
    if (old.supersededById) throw conflict('This loss opening balance was already superseded', 'loss_opening_superseded');
    await this.evidence(tx, a.actor, a.companyId, a.evidenceDocumentId);
    const id = uuidv7();
    await tx.ctLossOpening.update({ where: { id: old.id }, data: { supersededById: id } });
    const o = await tx.ctLossOpening.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, asOf: old.asOf, amount: new Prisma.Decimal(a.amount), evidenceDocumentId: a.evidenceDocumentId, reason: a.reason.trim(), enteredByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'ct.loss_opening_superseded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_loss_opening', entityId: old.id,
      before: lossOpeningView(old), after: lossOpeningView(o), reason: a.reason.trim() });
    return lossOpeningView(o);
  }
  async verifyLossOpening(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; notes: string }) {
    await this.need(a.actor, 'tax:rule-verify', a.companyId);
    const o = await this.lossOpening(tx, a.companyId, a.id);
    if (o.supersededById) throw conflict('A superseded loss opening balance cannot be verified', 'loss_opening_superseded');
    if (o.verificationStatus === 'VERIFIED') throw conflict('This loss opening balance is already verified', 'already_verified');
    if (o.enteredByUserId === a.actor.userId) throw forbidden('A loss opening balance must be verified by someone other than the person who entered it', 'self_verification_not_allowed');
    const v = await tx.ctLossOpening.update({ where: { id: o.id }, data: { verificationStatus: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes.trim() } });
    await this.audit(tx, { action: 'ct.loss_opening_verified', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_loss_opening', entityId: o.id,
      before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED' }, reason: a.notes.trim() });
    return lossOpeningView(v);
  }

  // ───── The computation ─────
  private current(tx: Tx, periodId: string) { return tx.ctComputation.findFirst({ where: { periodId, supersededById: null } }); }
  private async approved(tx: Tx, periodId: string) { const c = await this.current(tx, periodId); return c?.status === 'APPROVED' ? c : null; }
  private result(c: CompRow) { return (c.snapshot as unknown as Statement).result; }
  private async rates(tx: Tx, start: string, end: string): Promise<Record<number, CtRates>> {
    const out: Record<number, CtRates> = {};
    for (const part of financialYearParts(start, end)) {
      const r = await this.ct.ruleFor(tx, 'CT_RATES', part.from);
      const later = await tx.ctRule.findFirst({ where: { kind: 'CT_RATES', supersededById: null, effectiveFrom: { gt: toDate(part.from), lte: toDate(part.to) } }, select: { id: true, effectiveFrom: true } });
      if (later) throw unprocessable(`A new CT_RATES rule starts on ${isoDay(later.effectiveFrom)}, inside financial year ${part.financialYear} of the period`, 'ct_rule_change_in_period', { ruleId: later.id });
      out[part.financialYear] = { ruleId: r.id, ...CT_RULE_PARAMETERS.CT_RATES.parse(r.parameters) };
    }
    return out;
  }

  /** The computation as it stands now, with what stops it from being prepared. Nothing is written. */
  async preview(tx: Tx, companyId: string, periodId: string, q: { carryBack?: string } = {}) {
    const p = await this.ct.getPeriod(tx, companyId, periodId);
    const start = isoDay(p.startDate), end = isoDay(p.endDate);
    const problems: string[] = [];
    const adjusted = await this.ct.adjustedProfit(tx, companyId, periodId);
    problems.push(...adjusted.problems);

    const caItems = (await this.ca.list(tx, companyId, periodId)).items.filter((c) => !c.supersededById);
    const ca = caItems[0];
    if (!ca) problems.push('The capital allowances of the period have not been stored');
    else if (ca.stale) problems.push('The stored capital allowances opened from an earlier computation of the previous period; store them again');
    const caTotals = (ca?.snapshot as { computation?: { totals: { allowances: string; balancingCharges: string } } } | undefined)?.computation?.totals ?? { allowances: '0', balancingCharges: '0' };

    const neighbours: Neighbours = { previous: null, following: null, lossOpeningId: null };
    let lossesBroughtForward = '0';
    const prevPeriod = await tx.ctPeriod.findFirst({ where: { companyId, endDate: toDate(shift(start, -1)) } });
    const prev = prevPeriod ? await this.approved(tx, prevPeriod.id) : null;
    if (prev) {
      const r = this.result(prev);
      neighbours.previous = { periodId: prevPeriod!.id, computationId: prev.id, lossesCarriedForward: r.lossesCarriedForward, profitsBeforeCarryBack: r.profitsBeforeCarryBack };
      lossesBroughtForward = r.lossesCarriedForward;
    } else {
      const o = await tx.ctLossOpening.findFirst({ where: { companyId, asOf: toDate(shift(start, -1)), supersededById: null } });
      if (!o) problems.push(`Losses brought forward are unknown: ${prevPeriod ? 'the previous CT period has no approved computation and ' : ''}there is no loss opening balance at ${shift(start, -1)}`);
      else {
        if (o.verificationStatus !== 'VERIFIED') problems.push('The loss opening balance has not been verified');
        neighbours.lossOpeningId = o.id; lossesBroughtForward = o.amount.toFixed(2);
      }
    }
    const nextPeriod = await tx.ctPeriod.findFirst({ where: { companyId, startDate: toDate(shift(end, 1)) } });
    const next = nextPeriod ? await this.approved(tx, nextPeriod.id) : null;
    let carriedBackIn = '0';
    if (next && next.carryBack.gt(0)) { neighbours.following = { periodId: nextPeriod!.id, computationId: next.id, carryBack: next.carryBack.toFixed(2) }; carriedBackIn = next.carryBack.toFixed(2); }

    const carryBack = q.carryBack ?? '0';
    if (Number(carryBack) > 0) {
      if (!prevPeriod || isoDay(prevPeriod.startDate) < shift(endAfterMonths(start, -12), 1)) throw unprocessable('A loss is carried back only to the immediately preceding CT period lying wholly within the 12 months before this one', 'carry_back_not_modelled');
      if (!prev) throw unprocessable('The preceding CT period has no approved computation to carry the loss back to', 'carry_back_not_modelled');
      if (Number(carryBack) > Number(this.result(prev).profitsBeforeCarryBack)) throw unprocessable('The amount carried back is more than the preceding period\'s profits', 'carry_back_exceeds_profits', { profits: this.result(prev).profitsBeforeCarryBack });
    }
    const days = Math.round((p.endDate.getTime() - p.startDate.getTime()) / 86_400_000) + 1;
    let result: CtComputationResult;
    try {
      result = computeCorporationTax({ startDate: start, endDate: end, days, twelveMonths: endAfterMonths(start, 12) === end, associatedCompanies: p.associatedCompanies,
        adjustedProfit: adjusted.adjustedProfit, allowances: caTotals.allowances, balancingCharges: caTotals.balancingCharges, lossesBroughtForward, lossCarriedBackFromFollowing: carriedBackIn, carryBack,
        rates: await this.rates(tx, start, end) });
    } catch (e) {
      if (String((e as Error).message).includes('carry-back claim')) throw unprocessable('The amount carried back is more than the period\'s trading loss', 'carry_back_exceeds_loss');
      throw e;
    }
    const statement = { periodId: p.id, companyId, startDate: start, endDate: end, turnover: await this.ct.turnover(tx, companyId, start, end),
      inputs: { adjustedProfitFingerprint: adjusted.fingerprint, capitalAllowancesComputationId: ca?.id ?? null }, neighbours, result, problems };
    return { ...statement, fingerprint: createHash('sha256').update(canonicalJson(statement)).digest('hex'), notice: NOTICE };
  }

  async prepare(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; periodId: string; fingerprint: string; carryBack?: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ctc:${a.periodId}`}))`;
    const v = await this.preview(tx, a.companyId, a.periodId, { carryBack: a.carryBack });
    if (v.fingerprint !== a.fingerprint) throw conflict('The computation has changed since it was read; read it again', 'fingerprint_mismatch', { fingerprint: v.fingerprint });
    if (v.problems.length) throw unprocessable('The computation cannot be prepared while something needs attention', 'ct_problems', { problems: v.problems });
    const old = await this.current(tx, a.periodId);
    const id = uuidv7();
    if (old) await tx.ctComputation.update({ where: { id: old.id }, data: { supersededById: id } });
    const { notice: _n, fingerprint, ...snapshot } = v;
    const c = await tx.ctComputation.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, periodId: a.periodId, snapshot: snapshot as unknown as Prisma.InputJsonValue, fingerprint,
      carryBack: new Prisma.Decimal(a.carryBack ?? '0'), neighbours: v.neighbours as unknown as Prisma.InputJsonValue, preparedByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'ct.computation_prepared', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_computation', entityId: c.id,
      before: old ? { computationId: old.id, status: old.status } : undefined, after: { periodId: a.periodId, fingerprint, taxableTotalProfits: v.result.taxableTotalProfits, corporationTax: v.result.corporationTax, carryBack: v.result.carryBack } });
    return computationView(c);
  }

  async approve(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; periodId: string; id: string; notes: string }) {
    await this.need(a.actor, 'ct:approve', a.companyId);
    const c = await tx.ctComputation.findFirst({ where: { id: a.id, companyId: a.companyId, periodId: a.periodId } });
    if (!c) throw notFound('Computation not found', 'computation_not_found');
    if (c.supersededById) throw conflict('A superseded computation cannot be approved', 'computation_superseded');
    if (c.status === 'APPROVED') throw conflict('This computation is already approved', 'already_approved');
    if (c.preparedByUserId === a.actor.userId) throw forbidden('A computation must be approved by someone other than the person who prepared it', 'self_approval_not_allowed');
    const live = await this.preview(tx, a.companyId, a.periodId, { carryBack: c.carryBack.gt(0) ? c.carryBack.toFixed(2) : undefined });
    if (live.fingerprint !== c.fingerprint) throw conflict('The figures have changed since the computation was prepared; prepare it again', 'computation_changed');
    const v = await tx.ctComputation.update({ where: { id: c.id }, data: { status: 'APPROVED', approvedByUserId: a.actor.userId, approvedAt: new Date(), approvalNotes: a.notes.trim() } });
    await this.audit(tx, { action: 'ct.computation_approved', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_computation', entityId: c.id,
      before: { status: 'PREPARED' }, after: { status: 'APPROVED', fingerprint: c.fingerprint }, reason: a.notes.trim() });
    return computationView(v);
  }

  /** Every computation of the period, latest first; the current one is stale when a neighbour's current approved figures differ from those it used. */
  async list(tx: Tx, companyId: string, periodId: string) {
    const p = await this.ct.getPeriod(tx, companyId, periodId);
    const rows = await tx.ctComputation.findMany({ where: { companyId, periodId }, orderBy: { preparedAt: 'desc' } });
    const prevPeriod = await tx.ctPeriod.findFirst({ where: { companyId, endDate: toDate(shift(isoDay(p.startDate), -1)) } });
    const nextPeriod = await tx.ctPeriod.findFirst({ where: { companyId, startDate: toDate(shift(isoDay(p.endDate), 1)) } });
    const prev = prevPeriod ? await this.approved(tx, prevPeriod.id) : null, next = nextPeriod ? await this.approved(tx, nextPeriod.id) : null;
    const stale = (c: CompRow) => {
      const n = c.neighbours as Neighbours;
      const prevNow = prev ? { lossesCarriedForward: this.result(prev).lossesCarriedForward, profitsBeforeCarryBack: this.result(prev).profitsBeforeCarryBack } : null;
      const prevThen = n.previous ? { lossesCarriedForward: n.previous.lossesCarriedForward, profitsBeforeCarryBack: n.previous.profitsBeforeCarryBack } : null;
      const nextNow = next && next.carryBack.gt(0) ? next.carryBack.toFixed(2) : null;
      return JSON.stringify(prevNow) !== JSON.stringify(prevThen) || nextNow !== (n.following?.carryBack ?? null);
    };
    return { items: rows.map((c) => computationView(c, !c.supersededById && stale(c))) };
  }

  /** The canonical CT600 of the period from its current approved computation (named fields; the form's boxes are mapped in V4-M5). */
  async ct600(tx: Tx, companyId: string, periodId: string) {
    const c = await this.approved(tx, periodId);
    if (!c || c.companyId !== companyId) throw unprocessable('The period has no approved computation', 'computation_not_approved');
    const profile = await this.ct.getProfile(tx, companyId);
    if (!profile.utr) throw unprocessable('The company has no Unique Taxpayer Reference', 'utr_missing');
    const co = await tx.company.findFirstOrThrow({ where: { id: companyId }, select: { name: true, companyNumber: true } });
    const s = c.snapshot as unknown as Statement & { startDate: string; endDate: string; turnover: string };
    const r = s.result;
    return {
      format: 'uk-ct600-canonical/1', computationId: c.id, fingerprint: c.fingerprint,
      company: { name: co.name, registrationNumber: co.companyNumber, utr: profile.utr }, period: { from: s.startDate, to: s.endDate },
      turnover: s.turnover, tradingProfits: r.tradingProfit, tradingLossesBroughtForwardUsed: r.lossesBroughtForwardUsed, netTradingProfits: r.profitsBeforeCarryBack,
      nonTradingLoanRelationships: '0.00', propertyIncome: '0.00', chargeableGains: '0.00', lossCarriedBackFromLaterPeriod: r.lossCarriedBackFromFollowing,
      taxableTotalProfits: r.taxableTotalProfits, associatedCompanies: r.associatedCompanies,
      financialYears: r.financialYears.map((y) => ({ financialYear: y.financialYear, profit: y.profit, rate: y.rate, taxAtRate: y.taxAtRate, marginalRelief: y.marginalRelief, basis: y.basis })),
      corporationTaxChargeable: r.corporationTax, taxPayable: r.corporationTax,
      losses: { tradingLossOfPeriod: r.tradingLoss, carriedBack: r.carryBack, carriedForward: r.lossesCarriedForward },
      approval: { byUserId: c.approvedByUserId, at: c.approvedAt },
    };
  }
}
