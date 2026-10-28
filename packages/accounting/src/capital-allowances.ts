import { createHash } from 'node:crypto';
import { CT_RULE_PARAMETERS, canonicalJson, computeCapitalAllowances, endAfterMonths, type CaInput, type CaPool, type CtRuleKind } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import type { CorporationTaxService, CtActor } from './corporation-tax';

/**
 * V4-M3 (DEC-100): capital allowances of a CT period from the fixed-asset register's tax fields (tax category and tax cost; depreciation never
 * reads them, DEC-058). The rates and limits are verified CT rules; the openings are the prior period's stored computation or verified opening
 * balances. The arithmetic is `computeCapitalAllowances` in @uk/contracts.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dayBefore = (s: string) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() - 1); return isoDay(d); };
type OpeningRow = Awaited<ReturnType<Tx['caPoolOpening']['findUniqueOrThrow']>>;
type ComputationRow = Awaited<ReturnType<Tx['caComputation']['findUniqueOrThrow']>>;
const CA_NOTICE = 'Capital allowances of the period from the fixed-asset register\'s tax category and tax cost. First-year allowances, cars, private use and the structures and buildings allowance are not modelled.';

export const poolOpeningView = (o: OpeningRow) => ({
  id: o.id, companyId: o.companyId, pool: o.pool as CaPool, assetId: o.assetId, asOf: isoDay(o.asOf), amount: o.amount.toFixed(2), evidenceDocumentId: o.evidenceDocumentId, reason: o.reason,
  enteredByUserId: o.enteredByUserId, createdAt: o.createdAt, verificationStatus: o.verificationStatus, verifiedByUserId: o.verifiedByUserId, verifiedAt: o.verifiedAt, verificationNotes: o.verificationNotes, supersededById: o.supersededById,
});
const computationView = (c: ComputationRow, stale = false) => ({ id: c.id, periodId: c.periodId, priorComputationId: c.priorComputationId, fingerprint: c.fingerprint, preparedByUserId: c.preparedByUserId,
  preparedAt: c.preparedAt, supersededById: c.supersededById, stale, snapshot: c.snapshot as Record<string, unknown> });

export class CapitalAllowanceService {
  constructor(private readonly ct: CorporationTaxService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: CtActor, permission: string, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can change capital allowances records', 'ai_cannot_write');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async evidence(tx: Tx, actor: CtActor, companyId: string, id: string) {
    const d = await tx.document.findFirst({ where: { id }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
    const ok = d && d.companyId === companyId && (actor.canReadDocument ? await actor.canReadDocument(d) : await actor.can('document:read', companyId));
    if (!ok) throw unprocessable('The evidence is not a document of this company that you can read', 'invalid_evidence');
  }

  // ───── Opening balances ─────
  async listOpenings(tx: Tx, companyId: string, q: { includeSuperseded?: boolean } = {}) {
    const rows = await tx.caPoolOpening.findMany({ where: { companyId, ...(q.includeSuperseded ? {} : { supersededById: null }) }, orderBy: [{ asOf: 'asc' }, { pool: 'asc' }, { createdAt: 'asc' }] });
    return { items: rows.map(poolOpeningView) };
  }
  private async opening(tx: Tx, companyId: string, id: string) {
    const o = await tx.caPoolOpening.findFirst({ where: { id, companyId } });
    if (!o) throw notFound('Opening balance not found', 'pool_opening_not_found');
    return o;
  }
  private mapDb(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('This pool already has a current opening balance at that date; supersede it', 'pool_opening_exists');
    throw e;
  }
  async addOpening(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; pool: CaPool; assetId?: string; asOf: string; amount: string; evidenceDocumentId: string; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    if (a.assetId && !(await tx.fixedAsset.findFirst({ where: { id: a.assetId, companyId: a.companyId }, select: { id: true } }))) throw notFound('Asset not found', 'asset_not_found');
    await this.evidence(tx, a.actor, a.companyId, a.evidenceDocumentId);
    let o: OpeningRow;
    try {
      o = await tx.caPoolOpening.create({ data: { organisationId: a.organisationId, companyId: a.companyId, pool: a.pool, assetId: a.assetId ?? null, asOf: toDate(a.asOf), amount: new Prisma.Decimal(a.amount),
        evidenceDocumentId: a.evidenceDocumentId, reason: a.reason.trim(), enteredByUserId: a.actor.userId } });
    } catch (e) { this.mapDb(e); }
    await this.audit(tx, { action: 'ca.pool_opening_added', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ca_pool_opening', entityId: o.id, after: poolOpeningView(o), reason: o.reason });
    return poolOpeningView(o);
  }
  async supersedeOpening(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; amount: string; evidenceDocumentId: string; reason: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    const old = await this.opening(tx, a.companyId, a.id);
    if (old.supersededById) throw conflict('This opening balance was already superseded', 'pool_opening_superseded');
    await this.evidence(tx, a.actor, a.companyId, a.evidenceDocumentId);
    const id = uuidv7();
    await tx.caPoolOpening.update({ where: { id: old.id }, data: { supersededById: id } });
    const o = await tx.caPoolOpening.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, pool: old.pool, assetId: old.assetId, asOf: old.asOf, amount: new Prisma.Decimal(a.amount),
      evidenceDocumentId: a.evidenceDocumentId, reason: a.reason.trim(), enteredByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'ca.pool_opening_superseded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ca_pool_opening', entityId: old.id,
      before: poolOpeningView(old), after: poolOpeningView(o), reason: a.reason.trim() });
    return poolOpeningView(o);
  }
  async verifyOpening(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; notes: string }) {
    await this.need(a.actor, 'tax:rule-verify', a.companyId);
    const o = await this.opening(tx, a.companyId, a.id);
    if (o.supersededById) throw conflict('A superseded opening balance cannot be verified', 'pool_opening_superseded');
    if (o.verificationStatus === 'VERIFIED') throw conflict('This opening balance is already verified', 'already_verified');
    if (o.enteredByUserId === a.actor.userId) throw forbidden('An opening balance must be verified by someone other than the person who entered it', 'self_verification_not_allowed');
    const v = await tx.caPoolOpening.update({ where: { id: o.id }, data: { verificationStatus: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes.trim() } });
    await this.audit(tx, { action: 'ca.pool_opening_verified', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ca_pool_opening', entityId: o.id,
      before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED' }, reason: a.notes.trim() });
    return poolOpeningView(v);
  }

  // ───── The computation of a period ─────
  private async rule(tx: Tx, kind: CtRuleKind, start: string, end: string) {
    const r = await this.ct.ruleFor(tx, kind, start);
    const later = await tx.ctRule.findFirst({ where: { kind, supersededById: null, effectiveFrom: { gt: toDate(start), lte: toDate(end) } }, select: { id: true, effectiveFrom: true } });
    if (later) throw unprocessable(`A new ${kind} rule starts on ${isoDay(later.effectiveFrom)}, inside the period; a change of rate or limit within a period is not modelled`, 'ca_rule_change_in_period', { kind, ruleId: later.id });
    return r;
  }
  private async current(tx: Tx, periodId: string) { return tx.caComputation.findFirst({ where: { periodId, supersededById: null } }); }
  private async priorPeriod(tx: Tx, companyId: string, start: string) { return tx.ctPeriod.findFirst({ where: { companyId, endDate: toDate(dayBefore(start)) } }); }

  /** The computation as it stands now, with what stops it from being stored. Nothing is written. */
  async preview(tx: Tx, companyId: string, periodId: string) {
    const p = await this.ct.getPeriod(tx, companyId, periodId);
    const start = isoDay(p.startDate), end = isoDay(p.endDate);
    const [aia, wda, small] = [await this.rule(tx, 'AIA_LIMIT', start, end), await this.rule(tx, 'WDA_RATES', start, end), await this.rule(tx, 'SMALL_POOL_LIMIT', start, end)];
    const aiaP = CT_RULE_PARAMETERS.AIA_LIMIT.parse(aia.parameters), wdaP = CT_RULE_PARAMETERS.WDA_RATES.parse(wda.parameters), smallP = CT_RULE_PARAMETERS.SMALL_POOL_LIMIT.parse(small.parameters);
    const problems: string[] = [];

    // openings: the prior period's current computation, else verified opening balances at the day before the start
    const prior = await this.priorPeriod(tx, companyId, start);
    const priorComp = prior ? await this.current(tx, prior.id) : null;
    let openings: CaInput['openings'] = { MAIN: '0', SPECIAL_RATE: '0', single: [] };
    let openingsFrom: Record<string, unknown>;
    if (priorComp) {
      const pools = ((priorComp.snapshot as { computation: { pools: { pool: CaPool; assetId: string | null; closing: string }[] } }).computation.pools);
      const closing = (pool: CaPool) => pools.find((x) => x.pool === pool)?.closing ?? '0';
      openings = { MAIN: closing('MAIN'), SPECIAL_RATE: closing('SPECIAL_RATE'), single: pools.filter((x) => x.pool === 'SINGLE_ASSET' && x.closing !== '0.00').map((x) => ({ assetId: x.assetId!, amount: x.closing })) };
      openingsFrom = { kind: 'PRIOR_COMPUTATION', computationId: priorComp.id, periodId: prior!.id };
    } else {
      const rows = await tx.caPoolOpening.findMany({ where: { companyId, asOf: toDate(dayBefore(start)), supersededById: null } });
      for (const pool of ['MAIN', 'SPECIAL_RATE'] as const) if (!rows.some((r) => r.pool === pool)) problems.push(`No opening balance of the ${pool === 'MAIN' ? 'main' : 'special rate'} pool at ${dayBefore(start)}${prior ? ', and the previous CT period has no stored computation' : ''}`);
      for (const r of rows) if (r.verificationStatus !== 'VERIFIED') problems.push(`The opening balance of the ${r.pool.toLowerCase().replace('_', ' ')} pool${r.assetId ? ' of an asset' : ''} has not been verified`);
      const amt = (pool: CaPool) => rows.find((r) => r.pool === pool)?.amount.toFixed(2) ?? '0';
      openings = { MAIN: amt('MAIN'), SPECIAL_RATE: amt('SPECIAL_RATE'), single: rows.filter((r) => r.pool === 'SINGLE_ASSET').map((r) => ({ assetId: r.assetId!, amount: r.amount.toFixed(2) })) };
      openingsFrom = { kind: 'OPENING_BALANCES', openingIds: rows.map((r) => r.id) };
    }

    // the register: additions acquired in the period, disposals in the period; the tax cost when set, else the cost
    const assets = await tx.fixedAsset.findMany({ where: { companyId, status: { not: 'VOID' }, OR: [{ acquiredOn: { gte: p.startDate, lte: p.endDate } }, { disposedOn: { gte: p.startDate, lte: p.endDate } }] }, orderBy: { number: 'asc' } });
    const base = (a: (typeof assets)[number]) => ({ assetId: a.id, number: a.number, description: a.description, category: a.taxCategory, cost: (a.taxCost ?? a.cost).toFixed(2) });
    const additions = assets.filter((a) => a.acquiredOn >= p.startDate && a.acquiredOn <= p.endDate).map((a) => ({ ...base(a), acquiredOn: isoDay(a.acquiredOn) }));
    const disposals = assets.filter((a) => a.status === 'DISPOSED' && a.disposedOn && a.disposedOn >= p.startDate && a.disposedOn <= p.endDate).map((a) => ({ ...base(a), disposedOn: isoDay(a.disposedOn!), proceeds: (a.proceeds ?? new Prisma.Decimal(0)).toFixed(2) }));
    for (const a of [...additions, ...disposals]) if (a.category === 'UNDECIDED') problems.push(`Asset ${a.number} (${a.description}) has no tax category`);

    const twelveMonths = endAfterMonths(start, 12) === end;
    const days = Math.round((p.endDate.getTime() - p.startDate.getTime()) / 86_400_000) + 1;
    const computation = computeCapitalAllowances({ days, twelveMonths, aiaLimit: aiaP.annualLimit, mainRate: wdaP.mainRate, specialRate: wdaP.specialRate, smallPoolLimit: smallP.limit, openings, additions, disposals });
    const statement = {
      periodId: p.id, companyId, startDate: start, endDate: end, rules: { aiaLimitRuleId: aia.id, wdaRatesRuleId: wda.id, smallPoolLimitRuleId: small.id }, openingsFrom,
      notQualifying: additions.filter((a) => a.category === 'NOT_QUALIFYING').map((a) => ({ assetId: a.assetId, number: a.number, description: a.description, cost: a.cost })),
      computation, problems,
    };
    return { ...statement, priorComputationId: priorComp?.id ?? null, fingerprint: createHash('sha256').update(canonicalJson(statement)).digest('hex'), notice: CA_NOTICE };
  }

  /** Stores the computation as read (its fingerprint must match); the period's previous computation is superseded. */
  async store(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; periodId: string; fingerprint: string }) {
    await this.need(a.actor, 'ct:prepare', a.companyId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ca:${a.periodId}`}))`;
    const v = await this.preview(tx, a.companyId, a.periodId);
    if (v.fingerprint !== a.fingerprint) throw conflict('The computation has changed since it was read; read it again', 'fingerprint_mismatch', { fingerprint: v.fingerprint });
    if (v.problems.length) throw unprocessable('The computation cannot be stored while something needs attention', 'ca_problems', { problems: v.problems });
    const old = await this.current(tx, a.periodId);
    const id = uuidv7();
    if (old) await tx.caComputation.update({ where: { id: old.id }, data: { supersededById: id } });
    const { notice: _n, priorComputationId, fingerprint, ...snapshot } = v;
    const c = await tx.caComputation.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, periodId: a.periodId, priorComputationId, snapshot: snapshot as unknown as Prisma.InputJsonValue,
      fingerprint, preparedByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'ca.computation_stored', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ca_computation', entityId: c.id,
      before: old ? { computationId: old.id } : undefined, after: { periodId: a.periodId, fingerprint, totals: v.computation.totals } });
    return computationView(c);
  }

  /** Every stored computation of the period, latest first; one is stale when the prior period's current computation is no longer the one it opened from. */
  async list(tx: Tx, companyId: string, periodId: string) {
    const p = await this.ct.getPeriod(tx, companyId, periodId);
    const prior = await this.priorPeriod(tx, companyId, isoDay(p.startDate));
    const priorCurrent = prior ? await this.current(tx, prior.id) : null;
    const rows = await tx.caComputation.findMany({ where: { companyId, periodId }, orderBy: { preparedAt: 'desc' } });
    return { items: rows.map((c) => computationView(c, !c.supersededById && (c.priorComputationId ?? null) !== (priorCurrent?.id ?? null))) };
  }
}
