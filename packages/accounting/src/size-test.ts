import { SIZE_CLASSES, type EntitySize, type SizeClass, type ThresholdLimits } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { money, type Money } from './money';
import type { RuleActor } from './statutory';
import type { StatutoryReportService } from './statutory-report';

/**
 * V2-M5b (DEC-066; v2-plan section 5f): the size test. Threshold sets are organisation data with a source, UNVERIFIED until a second person
 * holding `accounts:rule-verify` verifies them (DEC-052); the database enforces the same rules. The test reads the statutory statements of each
 * framework year (V2-M1) and the preparer's facts (V2-M5a) and writes nothing. No threshold exists in code.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000) + 1;
const addYear = (s: string) => { const d = toDate(s); d.setUTCFullYear(d.getUTCFullYear() + 1); return isoDay(d); };
const ORDER: Record<string, number> = { MICRO: 0, SMALL: 1, MEDIUM: 2, LARGE: 3 };

// ───── The rules (pure; unit-tested on every combination) ─────
/** Three-valued: true, false or null (unknown). */
export type Tri = boolean | null;
/** Two or more of the three conditions (DEC-066): decided only when two known conditions settle it. */
export function conditionsMet(c: Tri[]): Tri {
  const yes = c.filter((x) => x === true).length, no = c.filter((x) => x === false).length;
  return yes >= 2 ? true : no >= 2 ? false : null;
}
export type StatusBasis = 'BOTH_YEARS' | 'CARRIED_FORWARD' | 'FIRST_YEAR';
/**
 * The two-consecutive-years rule for one class: when this year and the preceding year agree, this year's result is the status; when they
 * differ, the preceding status carries forward. `firstYear` means the company has no preceding financial year.
 */
export function twoYearStatus(met: Tri, priorMet: Tri, priorStatus: () => Tri, firstYear = false): { status: Tri; basis: StatusBasis | null } {
  if (firstYear) return { status: met, basis: met === null ? null : 'FIRST_YEAR' };
  if (met === null || priorMet === null) return { status: null, basis: null };
  if (met === priorMet) return { status: met, basis: 'BOTH_YEARS' };
  const s = priorStatus();
  return { status: s, basis: s === null ? null : 'CARRIED_FORWARD' };
}
/** Turnover within a limit for a year of `days` days, against the `days12` days of the twelve months from its start: exact, never rounded. */
export const turnoverWithin = (turnover: Money, limit: Money, days: number, days12: number) => turnover.times(days12).lessThanOrEqualTo(limit.times(days));

type SetRow = Awaited<ReturnType<Tx['sizeThresholdSet']['findUniqueOrThrow']>>;
type Ctx = { organisationId: string; companyId: string; actor: RuleActor };
interface Source { url: string; provision: string; retrievedOn: string }
interface SetInput { label: string; effectiveFrom: string; effectiveTo?: string | null; priorYearOnFirst: boolean; limits: ThresholdLimits; source: Source; notes?: string | null }

const limitsOf = (s: SetRow): ThresholdLimits => ({
  MICRO: { turnover: s.microTurnover.toFixed(2), balanceSheetTotal: s.microBalanceSheetTotal.toFixed(2), employees: s.microEmployees },
  SMALL: { turnover: s.smallTurnover.toFixed(2), balanceSheetTotal: s.smallBalanceSheetTotal.toFixed(2), employees: s.smallEmployees },
  MEDIUM: { turnover: s.mediumTurnover.toFixed(2), balanceSheetTotal: s.mediumBalanceSheetTotal.toFixed(2), employees: s.mediumEmployees },
});
const limitColumns = (l: ThresholdLimits) => ({
  microTurnover: money(l.MICRO.turnover), microBalanceSheetTotal: money(l.MICRO.balanceSheetTotal), microEmployees: l.MICRO.employees,
  smallTurnover: money(l.SMALL.turnover), smallBalanceSheetTotal: money(l.SMALL.balanceSheetTotal), smallEmployees: l.SMALL.employees,
  mediumTurnover: money(l.MEDIUM.turnover), mediumBalanceSheetTotal: money(l.MEDIUM.balanceSheetTotal), mediumEmployees: l.MEDIUM.employees,
});
export const thresholdSetView = (s: SetRow) => ({
  id: s.id, label: s.label, effectiveFrom: isoDay(s.effectiveFrom), effectiveTo: s.effectiveTo ? isoDay(s.effectiveTo) : null, priorYearOnFirst: s.priorYearOnFirst, limits: limitsOf(s),
  source: { url: s.sourceUrl, provision: s.sourceReference, retrievedOn: isoDay(s.sourceRetrievedOn) }, notes: s.notes, status: s.status, copiedFromId: s.copiedFromId,
  createdByUserId: s.createdByUserId, createdAt: s.createdAt, verifiedByUserId: s.verifiedByUserId, verifiedAt: s.verifiedAt, verificationNotes: s.verificationNotes, supersededById: s.supersededById,
});
const dbMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class SizeThresholdService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: RuleActor, permission: string, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can change size thresholds', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async set(tx: Tx, id: string) {
    const s = await tx.sizeThresholdSet.findFirst({ where: { id } });
    if (!s) throw notFound('Threshold set not found', 'threshold_set_not_found');
    return s;
  }
  private mapDb(e: unknown): never {
    if (dbMessage(e).includes('overlaps another current threshold set')) throw conflict('These dates overlap another current threshold set; supersede it or end it first', 'threshold_set_overlap');
    throw e;
  }
  private log(tx: Tx, a: Ctx, action: string, id: string, before?: object, after?: object, reason?: string) {
    return this.audit(tx, { action, organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'size_threshold_set', entityId: id,
      before: before as Record<string, unknown> | undefined, after: after as Record<string, unknown> | undefined, ...(reason ? { reason } : {}) });
  }

  async list(tx: Tx) { return { items: (await tx.sizeThresholdSet.findMany({ orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] })).map(thresholdSetView) }; }
  async get(tx: Tx, id: string) { return thresholdSetView(await this.set(tx, id)); }
  async create(tx: Tx, a: Ctx & SetInput) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    let s: SetRow;
    try {
      s = await tx.sizeThresholdSet.create({ data: { organisationId: a.organisationId, label: a.label, effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null,
        priorYearOnFirst: a.priorYearOnFirst, ...limitColumns(a.limits), sourceUrl: a.source.url, sourceReference: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn),
        notes: a.notes ?? null, createdByUserId: a.actor.userId } });
    } catch (e) { this.mapDb(e); }
    await this.log(tx, a, 'accounts.threshold_set_created', s.id, undefined, thresholdSetView(s));
    return thresholdSetView(s);
  }
  async update(tx: Tx, a: Ctx & { id: string } & Partial<Omit<SetInput, 'priorYearOnFirst'>> & { priorYearOnFirst?: boolean }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    const before = await this.set(tx, a.id);
    if (before.status !== 'UNVERIFIED') throw conflict(`The threshold set is ${before.status.toLowerCase()} and cannot change; supersede it with a new set`, 'threshold_set_not_editable');
    const from = a.effectiveFrom ?? isoDay(before.effectiveFrom), to = a.effectiveTo === undefined ? (before.effectiveTo ? isoDay(before.effectiveTo) : null) : a.effectiveTo;
    if (to && to < from) throw unprocessable('effectiveTo cannot precede effectiveFrom', 'invalid_date');
    let after: SetRow;
    try {
      after = await tx.sizeThresholdSet.update({ where: { id: a.id }, data: {
        ...(a.label !== undefined ? { label: a.label } : {}), effectiveFrom: toDate(from), effectiveTo: to ? toDate(to) : null,
        ...(a.priorYearOnFirst !== undefined ? { priorYearOnFirst: a.priorYearOnFirst } : {}), ...(a.limits ? limitColumns(a.limits) : {}),
        ...(a.source ? { sourceUrl: a.source.url, sourceReference: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn) } : {}),
        ...(a.notes !== undefined ? { notes: a.notes } : {}) } });
    } catch (e) { this.mapDb(e); }
    await this.log(tx, a, 'accounts.threshold_set_changed', a.id, thresholdSetView(before), thresholdSetView(after));
    return thresholdSetView(after);
  }
  async verify(tx: Tx, a: Ctx & { id: string; notes: string }) {
    await this.need(a.actor, 'accounts:rule-verify', a.companyId);
    const s = await this.set(tx, a.id);
    if (s.status === 'VERIFIED') throw conflict('This threshold set is already verified', 'already_verified');
    if (s.status === 'SUPERSEDED') throw conflict('A superseded threshold set cannot be verified', 'threshold_set_superseded');
    if (s.createdByUserId === a.actor.userId) throw forbidden('A threshold set must be verified by someone other than its author', 'self_verification_not_allowed');
    const after = await tx.sizeThresholdSet.update({ where: { id: a.id }, data: { status: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes } });
    await this.log(tx, a, 'accounts.threshold_set_verified', a.id, { status: s.status }, { status: after.status, verifiedByUserId: after.verifiedByUserId, verificationNotes: after.verificationNotes, limits: limitsOf(after) });
    return thresholdSetView(after);
  }
  /** A change to a verified set: a new UNVERIFIED set, and the old one marked SUPERSEDED, in one transaction. */
  async supersede(tx: Tx, a: Ctx & SetInput & { id: string; reason: string }) {
    await this.need(a.actor, 'accounts:rules-manage', a.companyId);
    const old = await this.set(tx, a.id);
    if (old.status === 'UNVERIFIED') throw conflict('An unverified threshold set is edited, not superseded', 'threshold_set_unverified');
    if (old.status === 'SUPERSEDED') throw conflict('This threshold set was already superseded', 'threshold_set_superseded');
    const id = uuidv7();
    await tx.sizeThresholdSet.update({ where: { id: old.id }, data: { status: 'SUPERSEDED', supersededById: id } });
    let s: SetRow;
    try {
      s = await tx.sizeThresholdSet.create({ data: { id, organisationId: a.organisationId, label: a.label, effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null,
        priorYearOnFirst: a.priorYearOnFirst, ...limitColumns(a.limits), sourceUrl: a.source.url, sourceReference: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn),
        notes: a.notes ?? null, copiedFromId: old.id, createdByUserId: a.actor.userId } });
    } catch (e) { this.mapDb(e); }
    await this.log(tx, a, 'accounts.threshold_set_superseded', old.id, { status: old.status }, { status: 'SUPERSEDED', supersededById: id, newSet: thresholdSetView(s) }, a.reason);
    return thresholdSetView(s);
  }
}

// ───── The test ─────
type Measure = 'turnover' | 'balanceSheetTotal' | 'employees';
interface Figures { turnover: Money | null; balanceSheetTotal: Money | null; employees: number | null }
interface ClassResult { class: SizeClass; limits: { turnover: string; balanceSheetTotal: string; employees: number } | null; conditions: Record<Measure, Tri>; met: Tri; priorMet: Tri; status: Tri; basis: StatusBasis | null }
interface YearTest {
  start: string; end: string; days: number; daysInTwelveMonths: number; twelveMonths: boolean; entitySize: EntitySize;
  thresholdSet: { id: string; label: string; status: string } | null; priorTestedAgainst: { id: string; label: string; status: string } | null;
  prior: { source: 'PLATFORM'; start: string; end: string } | { source: 'FACTS'; met: string | null; status: string | null };
  figures: { turnover: string | null; balanceSheetTotal: string | null; employees: number | null };
  classes: ClassResult[];
}
type FwRow = Awaited<ReturnType<Tx['companyReportingFramework']['findUniqueOrThrow']>>;

export class SizeTestService {
  constructor(private readonly statutory: StatutoryReportService) {}

  /** The size test of the framework year starting `yearStart` (v2-plan 5f.2), with the preceding years it needed. */
  async test(tx: Tx, companyId: string, q: { yearStart: string }) {
    const co = await tx.company.findFirst({ where: { id: companyId }, select: { id: true, name: true, baseCurrency: true } });
    if (!co) throw notFound('Company not found');
    const frameworks = await tx.companyReportingFramework.findMany({ where: { companyId }, orderBy: { yearStart: 'asc' } });
    const asked = frameworks.find((f) => isoDay(f.yearStart) === q.yearStart);
    if (!asked) throw notFound(`No reporting framework is set for the year starting ${q.yearStart}`, 'framework_not_set');
    const sets = await tx.sizeThresholdSet.findMany({ where: { status: { not: 'SUPERSEDED' } } });
    const governing = (start: string) => sets.find((s) => isoDay(s.effectiveFrom) <= start && (!s.effectiveTo || start <= isoDay(s.effectiveTo))) ?? null;
    const byEnd = new Map(frameworks.map((f) => [isoDay(f.yearEnd), f]));
    const problems: string[] = [];
    const used = new Set<SetRow>();
    const problem = (y: string, m: string) => { const t = `Year ${y}: ${m}`; if (!problems.includes(t)) problems.push(t); };

    // figures of a framework year, from its own statutory statements
    const figureCache = new Map<string, Figures>();
    const figures = async (fw: FwRow): Promise<Figures> => {
      const y = isoDay(fw.yearStart);
      const hit = figureCache.get(y); if (hit) return hit;
      const pv = await this.statutory.preview(tx, companyId, { yearStart: y, compare: false });
      const version = await tx.reportingStandardVersion.findFirstOrThrow({ where: { id: fw.versionId } });
      const lines = await tx.statutoryLine.findMany({ where: { versionId: fw.versionId, removed: false } });
      const amount = (k: string) => [...pv.statements.profitAndLoss, ...pv.statements.balanceSheet].find((l) => l.key === k)?.amount ?? null;
      let turnover: Money | null = null;
      if (!version.turnoverLineKey) problem(y, `the standard version ${version.label} names no turnover line`);
      else { const v = amount(version.turnoverLineKey); if (v === null) problem(y, `the turnover line ${version.turnoverLineKey} has no value`); else turnover = money(v); }
      let total: Money | null = money(0);
      for (const l of lines.filter((x) => x.statement === 'BS' && x.kind === 'ACCOUNTS' && x.naturalSide === 'DEBIT')) {
        const v = amount(l.key); if (v === null) { total = null; break; } total = total!.plus(v);
      }
      if (total === null) problem(y, 'the balance-sheet total cannot be computed');
      if (pv.unplacedAccounts.length) problem(y, `${pv.unplacedAccounts.length} account(s) are not placed on a line of the version, so turnover or the balance-sheet total may be incomplete`);
      const fact = await this.fact(tx, fw.id, 'employees.average');
      if (fact === null) problem(y, 'missing fact employees.average');
      const f = { turnover, balanceSheetTotal: total, employees: fact === null ? null : Number(fact) };
      figureCache.set(y, f);
      return f;
    };
    const length = (fw: FwRow) => { const s = isoDay(fw.yearStart), e = isoDay(fw.yearEnd); return { days: daysBetween(s, e), days12: daysBetween(s, addDays(addYear(s), -1)) }; };
    const conditions = (f: Figures, set: SetRow, c: SizeClass, fw: FwRow) => {
      const l = limitsOf(set)[c], { days, days12 } = length(fw);
      const cond: Record<Measure, Tri> = {
        turnover: f.turnover === null ? null : turnoverWithin(f.turnover, money(l.turnover), days, days12),
        balanceSheetTotal: f.balanceSheetTotal === null ? null : f.balanceSheetTotal.lessThanOrEqualTo(money(l.balanceSheetTotal)),
        employees: f.employees === null ? null : f.employees <= l.employees,
      };
      const shown = { turnover: money(l.turnover).times(days).div(days12).toFixed(2), balanceSheetTotal: l.balanceSheetTotal, employees: l.employees };
      return { cond, shown, met: conditionsMet(Object.values(cond)) };
    };

    const tests = new Map<string, YearTest>();
    const chain = new Map<string, string[]>();
    const run = async (fw: FwRow): Promise<YearTest> => {
      const y = isoDay(fw.yearStart);
      const done = tests.get(y); if (done) return done;
      const { days, days12 } = length(fw);
      const set = governing(y);
      if (!set) problem(y, 'no current size threshold set governs a year beginning on this date');
      else used.add(set);
      const prev = byEnd.get(addDays(y, -1)) ?? null;
      const prevSet = prev ? (set && set.priorYearOnFirst && governing(isoDay(prev.yearStart)) !== set ? set : governing(isoDay(prev.yearStart))) : null;
      if (prev && !prevSet) problem(isoDay(prev.yearStart), 'no current size threshold set governs a year beginning on this date');
      if (prevSet) used.add(prevSet);
      const f = await figures(fw);
      const pf = prev ? await figures(prev) : null;
      let priorFacts: { met: string | null; status: string | null } | null = null;
      if (!prev) {
        priorFacts = { met: await this.fact(tx, fw.id, 'size.priorMet'), status: await this.fact(tx, fw.id, 'size.priorStatus') };
      }
      const firstYear = priorFacts?.status === 'FIRST_YEAR';
      const classes: ClassResult[] = [];
      const deps: string[] = [];
      for (const c of SIZE_CLASSES) {
        const own = set ? conditions(f, set, c, fw) : null;
        const met: Tri = own ? own.met : null;
        let priorMet: Tri = null;
        let priorStatus: () => Tri;
        if (prev) {
          priorMet = prevSet && pf ? conditions(pf, prevSet, c, prev).met : null;
          priorStatus = () => null;
        } else {
          if (!firstYear) {
            if (priorFacts!.met === null) problem(y, 'missing fact size.priorMet (no framework year on the platform precedes it)');
            else priorMet = ORDER[c]! >= ORDER[priorFacts!.met]!;
          }
          priorStatus = () => {
            if (priorFacts!.status === null) { problem(y, 'missing fact size.priorStatus (no framework year on the platform precedes it)'); return null; }
            return ORDER[c]! >= ORDER[priorFacts!.status]!;
          };
        }
        let carried: Tri | undefined;
        if (prev && met !== null && priorMet !== null && met !== priorMet) {
          const pt = await run(prev);
          carried = pt.classes.find((x) => x.class === c)!.status;
          if (!deps.includes(isoDay(prev.yearStart))) deps.push(isoDay(prev.yearStart));
        }
        if (!prev && !firstYear && met !== null && priorMet === null) priorStatus();   // name every missing fact, even when the first is already missing
        const r = twoYearStatus(met, priorMet, prev ? () => carried ?? null : priorStatus, firstYear);
        classes.push({ class: c, limits: own?.shown ?? null, conditions: own?.cond ?? { turnover: null, balanceSheetTotal: null, employees: null },
          met, priorMet: firstYear ? null : priorMet, status: r.status, basis: r.basis });
      }
      const view = (s: SetRow | null) => (s ? { id: s.id, label: s.label, status: s.status } : null);
      const t: YearTest = {
        start: y, end: isoDay(fw.yearEnd), days, daysInTwelveMonths: days12, twelveMonths: days === days12, entitySize: fw.entitySize as EntitySize,
        thresholdSet: view(set), priorTestedAgainst: view(prevSet),
        prior: prev ? { source: 'PLATFORM', start: isoDay(prev.yearStart), end: isoDay(prev.yearEnd) } : { source: 'FACTS', met: priorFacts!.met, status: priorFacts!.status },
        figures: { turnover: f.turnover?.toFixed(2) ?? null, balanceSheetTotal: f.balanceSheetTotal?.toFixed(2) ?? null, employees: f.employees },
        classes,
      };
      tests.set(y, t);
      chain.set(y, [y, ...deps.flatMap((d) => chain.get(d) ?? [d])]);
      return t;
    };

    const t = await run(asked);
    const years = [...new Set(chain.get(q.yearStart)!)].map((y) => tests.get(y)!);
    const statuses = t.classes.map((c) => c.status);
    const first = statuses.findIndex((s) => s !== false);
    const qualifiesAs: EntitySize | 'UNKNOWN' = first === -1 ? 'LARGE' : statuses[first] === true ? SIZE_CLASSES[first]! : 'UNKNOWN';
    const chosen = asked.entitySize as EntitySize;
    const fits = qualifiesAs === 'UNKNOWN' ? null : ORDER[chosen]! >= ORDER[qualifiesAs]!;
    const verified = used.size > 0 && [...used].every((s) => s.status === 'VERIFIED') && !problems.some((p) => p.includes('no current size threshold set'));
    const notices = [
      ...(verified ? [] : ['PREVIEW ONLY: a size threshold set used here is missing or not verified by a second person holding accounts:rule-verify (DEC-052).']),
      ...(fits === false ? [`The entity size chosen for the year (${chosen}) is smaller than the class the company qualifies as (${qualifiesAs}): the year cannot use the ${chosen} regime.`] : []),
      ...(fits === true && qualifiesAs !== 'UNKNOWN' && ORDER[chosen]! > ORDER[qualifiesAs]! ? [`The entity size chosen for the year (${chosen}) is larger than needed: the company qualifies as ${qualifiesAs}. Fuller accounts may be prepared.`] : []),
      'This test covers the qualifying conditions only. Whether the company is excluded (a public company, banking, insurance and the other excluded companies, the micro-entity exclusions, or membership of a group) is not tested.',
    ];
    return { companyId, companyName: co.name, currency: co.baseCurrency, year: { start: q.yearStart, end: isoDay(asked.yearEnd) }, chosen, qualifiesAs, fits, verified, years, problems, notices };
  }

  private async fact(tx: Tx, frameworkId: string, key: string) {
    return (await tx.accountsFact.findFirst({ where: { frameworkId, key }, orderBy: [{ setAt: 'desc' }, { id: 'desc' }] }))?.value ?? null;
  }
}
