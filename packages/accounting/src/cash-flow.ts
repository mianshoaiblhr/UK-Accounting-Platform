import { CASH_FLOW_CAPTIONS, CASH_TARGET, CLOSING_SOURCES } from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Tx } from '@uk/db';
import { ZERO, fmt, money, type Money } from './money';

/**
 * V2-M5c (DEC-067; v2-plan section 5g): the cash flow statement by the indirect method, from the ledger through the year's standard version
 * (its cash-flow classes, map and captions, verified with it). For every account other than cash: E is minus its net debit movement in the
 * year, C the same over journals with a cash line, N = E - C. The change in cash is the sum of E, so the statement always reconciles when every
 * account is placed. Closing journals are left out (DEC-060). It reads the ledger and the framework only and writes nothing.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const addYears = (s: string, n: number) => { const d = new Date(`${s}T00:00:00.000Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return isoDay(d); };
const SECTIONS = ['OPERATING', 'INVESTING', 'FINANCING'] as const;
type Section = (typeof SECTIONS)[number];
type Kind = 'PROFIT' | 'ADJUSTMENT' | 'MOVEMENT' | 'CASH' | 'INFLOW' | 'OUTFLOW' | 'UNCLASSIFIED';
export interface CashFlowAccount { id: string; code: string; name: string; type: string; subtype: string; mapping: string; target: string | null }
export interface CashFlowFlows { e: Money; c: Money; inflow: Money; outflow: Money }
const isPl = (type: string) => type === 'INCOME' || type === 'EXPENSE';

/** One cash-flow class as the computation needs it. */
export interface CashFlowClassDef { key: string; section: string; sort: number; name: string; adjustmentName: string | null; inflowName: string | null; outflowName: string | null }
/** A line of the statement: its key, section, kind, caption, and the amount per account (current period). */
export interface CashFlowLineDef { key: string; section: Section; kind: Kind; classKey: string | null; name: string }

/**
 * The lines of the statement and each account's contribution to them, for one period (pure: unit-tested on generated ledgers).
 * `flows` holds E, C and the gross parts of every non-cash account with a movement.
 */
export function cashFlowLines(classes: CashFlowClassDef[], accounts: Map<string, CashFlowAccount>, flows: Map<string, CashFlowFlows>, profitCaption: string): { defs: CashFlowLineDef[]; parts: Map<string, Map<string, Money>> } {
  const byKey = new Map(classes.map((c) => [c.key, c]));
  const order = (s: string) => SECTIONS.indexOf(s as Section);
  const sorted = [...classes].sort((a, b) => order(a.section) - order(b.section) || a.sort - b.sort || a.key.localeCompare(b.key));
  const defs: CashFlowLineDef[] = [{ key: 'PROFIT', section: 'OPERATING', kind: 'PROFIT', classKey: null, name: profitCaption }];
  for (const c of sorted.filter((x) => x.section !== 'OPERATING')) defs.push({ key: `ADJ:${c.key}`, section: 'OPERATING', kind: 'ADJUSTMENT', classKey: c.key, name: c.adjustmentName ?? c.name });
  for (const c of sorted.filter((x) => x.section === 'OPERATING')) defs.push({ key: c.key, section: 'OPERATING', kind: 'MOVEMENT', classKey: c.key, name: c.name });
  defs.push({ key: 'UNCLASSIFIED', section: 'OPERATING', kind: 'UNCLASSIFIED', classKey: null, name: 'Unclassified movements (accounts the cash-flow map does not place)' });
  for (const c of sorted.filter((x) => x.section !== 'OPERATING')) {
    if (c.inflowName && c.outflowName) {
      defs.push({ key: `${c.key}:IN`, section: c.section as Section, kind: 'INFLOW', classKey: c.key, name: c.inflowName });
      defs.push({ key: `${c.key}:OUT`, section: c.section as Section, kind: 'OUTFLOW', classKey: c.key, name: c.outflowName });
    } else defs.push({ key: c.key, section: c.section as Section, kind: 'CASH', classKey: c.key, name: c.name });
  }
  // each account's contribution, by line
  const parts = new Map<string, Map<string, Money>>(defs.map((d) => [d.key, new Map()]));
  const add = (line: string, account: string, v: Money) => { if (!v.isZero()) parts.get(line)!.set(account, (parts.get(line)!.get(account) ?? ZERO).plus(v)); };
  for (const [id, f] of flows) {
    const a = accounts.get(id)!;
    const cls = a.target ? byKey.get(a.target) : undefined;
    if (!cls) { add(isPl(a.type) ? 'PROFIT' : 'UNCLASSIFIED', id, f.e); continue; }
    if (cls.section === 'OPERATING') { add(cls.key, id, f.e); continue; }
    add(`ADJ:${cls.key}`, id, f.e.minus(f.c));
    if (cls.inflowName && cls.outflowName) { add(`${cls.key}:IN`, id, f.inflow); add(`${cls.key}:OUT`, id, f.outflow); }
    else add(cls.key, id, f.c);
  }
  return { defs, parts };
}

export class CashFlowService {
  /** E, C and the gross parts per non-cash account for journals dated in [from, to], closing journals left out; and the cash accounts' movement. */
  private async flows(tx: Tx, companyId: string, from: string, to: string, cashIds: string[]) {
    const skip = [...CLOSING_SOURCES];
    const rows = await tx.$queryRaw<{ account_id: string; net: string; cash_net: string; cash_cr: string; cash_dr: string }[]>`
      SELECT l.account_id, sum(l.debit - l.credit)::text AS net,
             sum(CASE WHEN cj.journal_id IS NOT NULL THEN l.debit - l.credit ELSE 0 END)::text AS cash_net,
             sum(CASE WHEN cj.journal_id IS NOT NULL THEN l.credit ELSE 0 END)::text AS cash_cr,
             sum(CASE WHEN cj.journal_id IS NOT NULL THEN l.debit ELSE 0 END)::text AS cash_dr
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
        LEFT JOIN (SELECT DISTINCT x.journal_id FROM journal_line x WHERE x.company_id = ${companyId}::uuid AND x.account_id = ANY(${cashIds}::uuid[])) cj ON cj.journal_id = l.journal_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date >= ${from}::date AND j.journal_date <= ${to}::date AND j.source_type <> ALL(${skip}::text[])
       GROUP BY 1 ORDER BY 1`;
    const cash = new Set(cashIds);
    const flows = new Map<string, CashFlowFlows>();
    let movement = ZERO;
    for (const r of rows) {
      if (cash.has(r.account_id)) { movement = movement.plus(r.net); continue; }
      const f = { e: money(r.net).negated(), c: money(r.cash_net).negated(), inflow: money(r.cash_cr), outflow: money(r.cash_dr).negated() };
      if (!f.e.isZero() || !f.c.isZero()) flows.set(r.account_id, f);
    }
    const [open] = await tx.$queryRaw<{ v: string | null }[]>`
      SELECT sum(l.debit - l.credit)::text AS v FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date < ${from}::date AND l.account_id = ANY(${cashIds}::uuid[])`;
    const opening = money(open?.v ?? '0');
    return { flows, movement, opening, closing: opening.plus(movement) };
  }

  /** The cash flow statement of the framework year starting `yearStart`, with the prior year alongside on the same version when asked. */
  async statement(tx: Tx, companyId: string, q: { yearStart: string; compare: boolean }) {
    const co = await tx.company.findFirst({ where: { id: companyId }, select: { id: true, name: true, baseCurrency: true } });
    if (!co) throw notFound('Company not found');
    const minor = (await tx.currency.findUnique({ where: { code: co.baseCurrency } }))?.minorUnits ?? 2;
    const fw = await tx.companyReportingFramework.findFirst({ where: { companyId, yearStart: new Date(`${q.yearStart}T00:00:00.000Z`) } });
    if (!fw) throw notFound(`No reporting framework is set for the year starting ${q.yearStart}`, 'framework_not_set');
    const version = await tx.reportingStandardVersion.findFirstOrThrow({ where: { id: fw.versionId } });
    const standard = await tx.reportingStandard.findFirstOrThrow({ where: { id: version.standardId } });
    const [classRows, mapRows, accountRows] = await Promise.all([
      tx.cashFlowClass.findMany({ where: { versionId: version.id, removed: false } }),
      tx.cashFlowMapEntry.findMany({ where: { versionId: version.id, removed: false } }),
      tx.account.findMany({ where: { companyId }, select: { id: true, code: true, name: true, type: true, subtype: true, reportingMapping: true }, orderBy: { code: 'asc' } }),
    ]);
    const problems: string[] = [];
    const storedCaptions = (version.cashFlowCaptions as Record<string, string> | null) ?? null;
    if (!storedCaptions) problems.push(`The standard version ${version.label} has no cash flow captions`);
    const caption = (k: (typeof CASH_FLOW_CAPTIONS)[number]) => storedCaptions?.[k] ?? `[caption: ${k}]`;
    // the most specific map entry places each account
    const specific = new Map(mapRows.filter((m) => m.accountSubtype).map((m) => [`${m.sourceLine}|${m.accountSubtype}`, m.target]));
    const generic = new Map(mapRows.filter((m) => !m.accountSubtype).map((m) => [m.sourceLine, m.target]));
    const accounts = new Map<string, CashFlowAccount>(accountRows.map((a) => [a.id, { id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, mapping: a.reportingMapping,
      target: specific.get(`${a.reportingMapping}|${a.subtype}`) ?? generic.get(a.reportingMapping) ?? null }]));
    const cashIds = [...accounts.values()].filter((a) => a.target === CASH_TARGET).map((a) => a.id);
    if (!cashIds.length) problems.push('No account is mapped to CASH by the version\'s cash-flow map');
    const known = new Set(classRows.map((c) => c.key));
    for (const a of accounts.values()) if (a.target && a.target !== CASH_TARGET && !known.has(a.target)) { problems.push(`Account ${a.code} ${a.name}: the map places it in ${a.target}, which is not a class of this version`); a.target = null; }

    const from = q.yearStart, to = isoDay(fw.yearEnd);
    const prior = q.compare ? await tx.companyReportingFramework.findFirst({ where: { companyId, yearEnd: new Date(`${addDays(from, -1)}T00:00:00.000Z`) } }) : null;
    const cmpRange = q.compare ? (prior ? { from: isoDay(prior.yearStart), to: isoDay(prior.yearEnd), framework: true } : { from: addYears(from, -1), to: addDays(from, -1), framework: false }) : null;
    const cur = await this.flows(tx, companyId, from, to, cashIds);
    const cmp = cmpRange ? await this.flows(tx, companyId, cmpRange.from, cmpRange.to, cashIds) : null;
    const classes = classRows.map((c) => ({ key: c.key, section: c.section, sort: c.sort, name: c.name, adjustmentName: c.adjustmentName, inflowName: c.inflowName, outflowName: c.outflowName }));
    const a = cashFlowLines(classes, accounts, cur.flows, caption('profit'));
    const b = cmp ? cashFlowLines(classes, accounts, cmp.flows, caption('profit')) : null;
    const sum = (m: Map<string, Money> | undefined) => [...(m ?? new Map<string, Money>()).values()].reduce((t, v) => t.plus(v), ZERO);
    const f = (m: Money) => fmt(m, minor);

    // unplaced balance-sheet accounts: shown as unclassified and reported
    const unplaced = [...accounts.values()].filter((x) => !isPl(x.type) && x.target === null && (cur.flows.has(x.id) || cmp?.flows.has(x.id)));
    for (const u of unplaced) problems.push(`Account ${u.code} ${u.name} (${u.mapping}${u.subtype ? `/${u.subtype}` : ''}) is not placed by the cash-flow map; its movement is shown as unclassified`);

    const sections = SECTIONS.map((section) => {
      const lines = a.defs.filter((d) => d.section === section).map((d) => {
        const amount = sum(a.parts.get(d.key)), comparative = b ? sum(b.parts.get(d.key)) : ZERO;
        return { d, amount, comparative };
      }).filter((l) => l.d.kind === 'PROFIT' || !l.amount.isZero() || !l.comparative.isZero());
      const total = lines.reduce((t, l) => t.plus(l.amount), ZERO), totalCmp = lines.reduce((t, l) => t.plus(l.comparative), ZERO);
      return {
        section,
        lines: lines.map(({ d, amount, comparative }) => ({
          key: d.key, kind: d.kind, classKey: d.classKey, name: d.name, amount: f(amount), ...(b ? { comparative: f(comparative) } : {}),
          accounts: [...a.parts.get(d.key)!.entries()].map(([id, v]) => ({ accountId: id, code: accounts.get(id)!.code, name: accounts.get(id)!.name, amount: f(v) })).sort((x, y) => x.code.localeCompare(y.code)),
        })),
        total: { name: caption(section === 'OPERATING' ? 'operating' : section === 'INVESTING' ? 'investing' : 'financing'), amount: f(total), ...(b ? { comparative: f(totalCmp) } : {}), raw: total, rawCmp: totalCmp },
      };
    });
    const statementNet = sections.reduce((t, s) => t.plus(s.total.raw), ZERO), statementNetCmp = sections.reduce((t, s) => t.plus(s.total.rawCmp), ZERO);
    const proof = (net: Money, p: typeof cur) => ({ cashMovement: f(p.movement), statementNetChange: f(net), difference: f(net.minus(p.movement)), reconciled: net.equals(p.movement),
      opening: f(p.opening), closing: f(p.closing) });
    const applies = version.cashFlowAppliesTo.includes(fw.entitySize);
    const verified = version.status !== 'UNVERIFIED';
    const notices = [
      ...(verified ? [] : ['PREVIEW ONLY: this standard version is not verified by a second person holding accounts:rule-verify (DEC-052); nothing filing-ready can be produced from it.']),
      ...(applies ? [] : [`The version's cash flow statement does not apply to the year's entity size (${fw.entitySize}); shown for review only.`]),
      ...(cmpRange && !cmpRange.framework ? ['No framework year ends the day before this year: the comparative is the twelve months before it, on this year\'s version.'] : []),
      'Indirect method, from the ledger only (DEC-067). Classification follows each account\'s V1 reporting line and subtype through the version\'s cash-flow map; year-end closing journals are left out (DEC-060).',
    ];
    const cashLine = (k: 'netChange' | 'opening' | 'closing', v: Money, w: Money | undefined) => ({ name: caption(k), amount: f(v), ...(w !== undefined ? { comparative: f(w) } : {}) });
    return {
      companyId, companyName: co.name, currency: co.baseCurrency,
      year: { start: from, end: to, entitySize: fw.entitySize, frameworkId: fw.id },
      comparative: cmpRange ? { start: cmpRange.from, end: cmpRange.to, fromFramework: cmpRange.framework } : null,
      standard: { id: standard.id, code: standard.code, name: standard.name },
      version: { id: version.id, label: version.label, status: version.status, cashFlowAppliesTo: version.cashFlowAppliesTo },
      verified, applies,
      sections: sections.map(({ total: { raw: _r, rawCmp: _c, ...total }, ...s }) => ({ ...s, total })),
      netChange: cashLine('netChange', statementNet, b ? statementNetCmp : undefined),
      opening: cashLine('opening', cur.opening, cmp?.opening),
      closing: cashLine('closing', cur.opening.plus(statementNet), cmp ? cmp.opening.plus(statementNetCmp) : undefined),
      proof: { ...proof(statementNet, cur), ...(cmp ? { comparative: proof(statementNetCmp, cmp) } : {}) },
      unplacedAccounts: unplaced.map((u) => ({ accountId: u.id, code: u.code, name: u.name, reportingLine: u.mapping, subtype: u.subtype })),
      problems, notices,
    };
  }
}
