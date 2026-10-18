import { COMPARISONS, type BoolExpr, type NumExpr } from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Tx } from '@uk/db';
import { ZERO, fmt, money, type Money } from './money';

/**
 * V2-M1 statutory preview (DEC-053, DEC-055; ADR-63). The statements of one financial year computed from `journal_line` through the company's
 * reporting framework: the standard version's lines, its map from V1 reporting lines, the company's account overrides. It reads the ledger and the
 * framework tables only, never a source document (architecture-tested), and writes nothing. Every figure is exact; nothing is rounded.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const MIN_DAY = '0001-01-01';
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const addYears = (s: string, n: number) => { const d = new Date(`${s}T00:00:00.000Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return isoDay(d); };

// ───── The expression interpreter (v2-plan 3.3): exact decimals, the closed grammar only ─────
export class ExpressionError extends Error {}
const obj = (e: unknown) => (typeof e === 'object' && e !== null && !Array.isArray(e) ? (e as Record<string, unknown>) : null);
export function evaluateValue(e: NumExpr, value: (key: string) => Money | undefined): Money {
  const o = obj(e);
  if (!o) throw new ExpressionError('a value must be an object');
  if ('line' in o) { const v = value(o.line as string); if (v === undefined) throw new ExpressionError(`line ${String(o.line)} has no value`); return v; }
  if ('const' in o) return money(o.const as string);
  if ('add' in o) return (o.add as NumExpr[]).reduce((t, x) => t.plus(evaluateValue(x, value)), ZERO);
  if ('sub' in o) { const [a, b] = o.sub as [NumExpr, NumExpr]; return evaluateValue(a, value).minus(evaluateValue(b, value)); }
  if ('neg' in o) return evaluateValue(o.neg as NumExpr, value).negated();
  throw new ExpressionError(`unknown construct ${Object.keys(o).join(', ')}`);
}
export function evaluateCondition(e: BoolExpr, value: (key: string) => Money | undefined): boolean {
  const o = obj(e);
  if (!o) throw new ExpressionError('a condition must be an object');
  if ('and' in o) return (o.and as BoolExpr[]).every((x) => evaluateCondition(x, value));
  if ('or' in o) return (o.or as BoolExpr[]).some((x) => evaluateCondition(x, value));
  const op = COMPARISONS.find((k) => k in o);
  if (!op) throw new ExpressionError(`unknown construct ${Object.keys(o).join(', ')}`);
  const [a, b] = o[op] as [NumExpr, NumExpr];
  const d = evaluateValue(a, value).minus(evaluateValue(b, value));
  const tol = money((o.tolerance as string | undefined) ?? '0');
  // the tolerance relaxes the comparison: eq |a-b| <= t; ge a-b >= -t; le a-b <= t; gt a-b > -t; lt a-b < t
  switch (op) {
    case 'eq': return d.abs().lessThanOrEqualTo(tol);
    case 'ge': return d.greaterThanOrEqualTo(tol.negated());
    case 'le': return d.lessThanOrEqualTo(tol);
    case 'gt': return d.greaterThan(tol.negated());
    case 'lt': return d.lessThan(tol);
  }
}

// ───── The computation ─────
type Term = { line: string; sign: number };
interface Line { key: string; statement: string; parentKey: string | null; sort: number; name: string; kind: string; naturalSide: string | null; formula: Term[] | null }
interface Bal { accountId: string; code: string; name: string; type: string; subtype: string; mapping: string; d: Money; c: Money }
interface Placed { accountId: string; code: string; name: string; amount: Money }
interface Unplaced { accountId: string; code: string; name: string; type: string; reportingLine: string; subtype: string; reason: 'unmapped' | 'statement_mismatch'; targetKey?: string; net: Money }
const isPl = (type: string) => type === 'INCOME' || type === 'EXPENSE';

export class StatutoryReportService {
  /** Debits and credits per account for journals dated in [from, to]. */
  private async balances(tx: Tx, companyId: string, from: string, to: string): Promise<Bal[]> {
    const rows = await tx.$queryRaw<{ account_id: string; code: string; name: string; type: string; subtype: string; reporting_mapping: string; d: string; c: string }[]>`
      SELECT l.account_id, a.code, a.name, a.type::text AS type, a.subtype, a.reporting_mapping, sum(l.debit)::text AS d, sum(l.credit)::text AS c
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date >= ${from}::date AND j.journal_date <= ${to}::date
       GROUP BY l.account_id, a.code, a.name, a.type, a.subtype, a.reporting_mapping ORDER BY a.code`;
    return rows.map((r) => ({ accountId: r.account_id, code: r.code, name: r.name, type: r.type, subtype: r.subtype, mapping: r.reporting_mapping, d: money(r.d), c: money(r.c) }));
  }

  /** One period: the P&L for [from, to] and the balance sheet at `to`. */
  private async compute(tx: Tx, companyId: string, from: string, to: string, lines: Line[], target: (b: Bal) => string | undefined) {
    const [year, cumulative] = await Promise.all([this.balances(tx, companyId, from, to), this.balances(tx, companyId, MIN_DAY, to)]);
    const byKey = new Map(lines.map((l) => [l.key, l]));
    const values = new Map<string, Money>();
    const accounts = new Map<string, Placed[]>();
    const unplaced: Unplaced[] = [];
    for (const l of lines) if (l.kind === 'ACCOUNTS') { values.set(l.key, ZERO); accounts.set(l.key, []); }
    // P&L accounts are taken over the year, balance-sheet accounts at its end
    const relevant = [...year.filter((b) => isPl(b.type)), ...cumulative.filter((b) => !isPl(b.type))];
    for (const b of relevant) {
      if (b.d.equals(b.c)) continue;
      const key = target(b);
      const line = key ? byKey.get(key) : undefined;
      const base = { accountId: b.accountId, code: b.code, name: b.name, type: b.type, reportingLine: b.mapping, subtype: b.subtype, net: b.d.minus(b.c) };
      if (!line || line.kind !== 'ACCOUNTS') { unplaced.push({ ...base, reason: 'unmapped', ...(key ? { targetKey: key } : {}) }); continue; }
      if ((line.statement === 'PL') !== isPl(b.type)) { unplaced.push({ ...base, reason: 'statement_mismatch', targetKey: key }); continue; }
      const amount = line.naturalSide === 'CREDIT' ? b.c.minus(b.d) : b.d.minus(b.c);
      values.set(line.key, values.get(line.key)!.plus(amount));
      accounts.get(line.key)!.push({ accountId: b.accountId, code: b.code, name: b.name, amount });
    }
    // the profit and loss of every year to the date, until the V2-M3 closing journal exists (DEC-055)
    const plCumulative = cumulative.filter((b) => isPl(b.type)).reduce((t, b) => t.plus(b.c).minus(b.d), ZERO);
    for (const l of lines) if (l.kind === 'RETAINED_PROFIT') values.set(l.key, l.naturalSide === 'DEBIT' ? plCumulative.negated() : plCumulative);
    // totals: signed sums of other lines, evaluated on demand; a cycle or a missing line leaves the total without a value and is reported
    const problems: string[] = [];
    const visiting = new Set<string>();
    const total = (key: string): Money | undefined => {
      if (values.has(key)) return values.get(key);
      const l = byKey.get(key);
      if (!l?.formula) return undefined;
      if (visiting.has(key)) { problems.push(`Totals form a cycle through ${key}`); return undefined; }
      visiting.add(key);
      let sum: Money | undefined = ZERO;
      for (const t of l.formula) { const v = total(t.line); if (v === undefined) { sum = undefined; break; } sum = sum.plus(t.sign === -1 ? v.negated() : v); }
      visiting.delete(key);
      if (sum === undefined) { problems.push(`Total ${key} cannot be computed`); return undefined; }
      values.set(key, sum);
      return sum;
    };
    for (const l of lines) if (l.kind === 'TOTAL') total(l.key);
    // proofs (DEC-055): the P&L lines against the ledger's profit; the balance sheet (with the retained profit) nets to zero
    const debitPositive = (l: Line) => (l.naturalSide === 'DEBIT' ? values.get(l.key)! : values.get(l.key)!.negated());
    const profitFromLedger = year.filter((b) => isPl(b.type)).reduce((t, b) => t.plus(b.c).minus(b.d), ZERO);
    const profitFromLines = lines.filter((l) => l.kind === 'ACCOUNTS' && l.statement === 'PL').reduce((t, l) => t.minus(debitPositive(l)), ZERO);
    const bsNet = lines.filter((l) => (l.kind === 'ACCOUNTS' && l.statement === 'BS') || l.kind === 'RETAINED_PROFIT').reduce((t, l) => t.plus(debitPositive(l)), ZERO);
    let tbDebit = ZERO, tbCredit = ZERO;
    for (const b of cumulative) { const n = b.d.minus(b.c); if (n.greaterThan(0)) tbDebit = tbDebit.plus(n); else tbCredit = tbCredit.minus(n); }
    return { values, accounts, unplaced, problems: [...new Set(problems)], profitFromLedger, profitFromLines, bsNet, tbDebit, tbCredit, plCumulative };
  }

  /** The statutory preview of one financial year (v2-plan 3.2), with the prior year alongside on the same version. */
  async preview(tx: Tx, companyId: string, q: { yearStart: string; compare: boolean }) {
    const co = await tx.company.findFirst({ where: { id: companyId }, select: { id: true, name: true, baseCurrency: true } });
    if (!co) throw notFound('Company not found');
    const minor = (await tx.currency.findUnique({ where: { code: co.baseCurrency } }))?.minorUnits ?? 2;
    const fw = await tx.companyReportingFramework.findFirst({ where: { companyId, yearStart: new Date(`${q.yearStart}T00:00:00.000Z`) } });
    if (!fw) throw notFound(`No reporting framework is set for the year starting ${q.yearStart}`, 'framework_not_set');
    const version = await tx.reportingStandardVersion.findFirstOrThrow({ where: { id: fw.versionId } });
    const standard = await tx.reportingStandard.findFirstOrThrow({ where: { id: version.standardId } });
    const [lineRows, mapRows, ruleRows, overrides] = await Promise.all([
      tx.statutoryLine.findMany({ where: { versionId: version.id, removed: false }, orderBy: [{ sort: 'asc' }, { key: 'asc' }] }),
      tx.statutoryMapEntry.findMany({ where: { versionId: version.id, removed: false } }),
      tx.validationRule.findMany({ where: { versionId: version.id, removed: false }, orderBy: { key: 'asc' } }),
      tx.statutoryAccountOverride.findMany({ where: { companyId, versionId: version.id, endedAt: null } }),
    ]);
    const lines: Line[] = lineRows.map((l) => ({ key: l.key, statement: l.statement, parentKey: l.parentKey, sort: l.sort, name: l.name, kind: l.kind, naturalSide: l.naturalSide, formula: (l.formula as Term[] | null) ?? null }));
    // exactly one line per account (DEC-055): the company's override, else the most specific map entry
    const override = new Map(overrides.map((o) => [o.accountId, o.targetKey]));
    const specific = new Map(mapRows.filter((m) => m.accountSubtype).map((m) => [`${m.sourceLine}|${m.accountSubtype}`, m.targetKey]));
    const generic = new Map(mapRows.filter((m) => !m.accountSubtype).map((m) => [m.sourceLine, m.targetKey]));
    const target = (b: Bal) => override.get(b.accountId) ?? specific.get(`${b.mapping}|${b.subtype}`) ?? generic.get(b.mapping);

    const from = q.yearStart, to = isoDay(fw.yearEnd);
    const prior = q.compare ? await tx.companyReportingFramework.findFirst({ where: { companyId, yearEnd: new Date(`${addDays(from, -1)}T00:00:00.000Z`) } }) : null;
    const cmpRange = q.compare ? (prior ? { from: isoDay(prior.yearStart), to: isoDay(prior.yearEnd), framework: true } : { from: addYears(from, -1), to: addDays(from, -1), framework: false }) : null;
    const cur = await this.compute(tx, companyId, from, to, lines, target);
    const cmp = cmpRange ? await this.compute(tx, companyId, cmpRange.from, cmpRange.to, lines, target) : null;
    const f = (m: Money | undefined) => (m === undefined ? null : fmt(m, minor));

    // statement order: each statement's lines as a tree by parent, siblings by sort then key
    const ordered: (Line & { depth: number })[] = [];
    const known = new Set(lines.map((l) => l.key));
    const children = (stmt: string, parent: string | null) => lines.filter((l) => l.statement === stmt && (parent === null ? !l.parentKey || !known.has(l.parentKey) : l.parentKey === parent));
    const seen = new Set<string>();
    const walk = (stmt: string, parent: string | null, depth: number) => { for (const l of children(stmt, parent)) { if (seen.has(l.key)) continue; seen.add(l.key); ordered.push({ ...l, depth }); walk(stmt, l.key, depth + 1); } };
    for (const stmt of ['PL', 'BS']) walk(stmt, null, 0);
    for (const l of lines) if (!seen.has(l.key)) ordered.push({ ...l, depth: 0 });          // lines caught in a parent cycle (unverifiable) still show
    const lineOut = (l: Line & { depth: number }) => ({
      key: l.key, name: l.name, statement: l.statement, kind: l.kind, parentKey: l.parentKey, depth: l.depth,
      amount: f(cur.values.get(l.key)), ...(cmp ? { comparative: f(cmp.values.get(l.key)) } : {}),
      ...(l.kind === 'ACCOUNTS' ? { accounts: cur.accounts.get(l.key)!.map((a) => ({ accountId: a.accountId, code: a.code, name: a.name, amount: f(a.amount)!,
        drilldown: { accountId: a.accountId, from: l.statement === 'PL' ? from : null, to } })) } : {}),
    });
    const unplacedOut = (u: Unplaced) => ({ accountId: u.accountId, code: u.code, name: u.name, type: u.type, reportingLine: u.reportingLine, subtype: u.subtype, reason: u.reason, targetKey: u.targetKey ?? null,
      net: f(u.net)!, drilldown: { accountId: u.accountId, from: isPl(u.type) ? from : null, to } });

    // validation rules of the entity size, on the current year's values
    const validations = ruleRows.filter((r) => r.appliesTo.includes(fw.entitySize)).map((r) => {
      try { return { key: r.key, description: r.description, severity: r.severity, passed: evaluateCondition(r.expression as BoolExpr, (k) => cur.values.get(k)), error: null }; }
      catch (e) { if (e instanceof ExpressionError) return { key: r.key, description: r.description, severity: r.severity, passed: false, error: e.message }; throw e; }
    });
    const proof = (c: typeof cur) => ({
      profitAndLoss: { profitFromLedger: f(c.profitFromLedger)!, profitFromLines: f(c.profitFromLines)!, difference: f(c.profitFromLedger.minus(c.profitFromLines))!, reconciled: c.profitFromLedger.equals(c.profitFromLines) },
      balanceSheet: { difference: f(c.bsNet)!, balanced: c.bsNet.isZero() },
      trialBalance: { debit: f(c.tbDebit)!, credit: f(c.tbCredit)!, balanced: c.tbDebit.equals(c.tbCredit) },
    });
    const verified = version.status !== 'UNVERIFIED';
    const notices = [
      ...(verified ? [] : ['PREVIEW ONLY: this standard version is not verified by a second person holding accounts:rule-verify (DEC-052); nothing filing-ready can be produced from it.']),
      ...(version.status === 'SUPERSEDED' ? ['This standard version has been superseded; the year still uses it until its framework is changed.'] : []),
      ...(cmpRange && !cmpRange.framework ? ['No framework year ends the day before this year: the comparative is the twelve months before it, on this year\'s version.'] : []),
      'Computed from the ledger only; there is no year-end closing journal yet, so retained profit is the profit and loss of every year to the year end (V2-M3).',
    ];
    return {
      companyId, companyName: co.name, currency: co.baseCurrency,
      year: { start: from, end: to, entitySize: fw.entitySize, frameworkId: fw.id },
      comparative: cmpRange ? { start: cmpRange.from, end: cmpRange.to, fromFramework: cmpRange.framework } : null,
      standard: { id: standard.id, code: standard.code, name: standard.name },
      version: { id: version.id, label: version.label, status: version.status, effectiveFrom: isoDay(version.effectiveFrom), effectiveTo: version.effectiveTo ? isoDay(version.effectiveTo) : null,
        source: { url: version.sourceUrl, provision: version.sourceReference, retrievedOn: isoDay(version.sourceRetrievedOn) } },
      verified,
      statements: { profitAndLoss: ordered.filter((l) => l.statement === 'PL').map(lineOut), balanceSheet: ordered.filter((l) => l.statement === 'BS').map(lineOut) },
      unplacedAccounts: cur.unplaced.map(unplacedOut),
      ...(cmp ? { comparativeUnplacedAccounts: cmp.unplaced.map(unplacedOut) } : {}),
      overridesApplied: overrides.length,
      validations, validationSummary: { errors: validations.filter((v) => !v.passed && v.severity === 'ERROR').length, warnings: validations.filter((v) => !v.passed && v.severity === 'WARNING').length },
      reconciliation: { ...proof(cur), ...(cmp ? { comparative: proof(cmp) } : {}) },
      problems: [...new Set([...cur.problems, ...(cmp?.problems ?? [])])],
      notices,
    };
  }
}
