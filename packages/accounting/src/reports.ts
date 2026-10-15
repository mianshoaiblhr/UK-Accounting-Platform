import { MONETARY_SUBTYPES, REPORT_LINES, REPORT_MAPPING_VERSION } from '@uk/contracts';
import { notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { RateService, convert } from './fx';
import { ZERO, fmt, money, type Money } from './money';

/**
 * Financial statements and the FX report (M8; DEC-043, DEC-045). Every figure comes from `journal_line` summed by account and mapped through the
 * versioned reporting-line registry (ADR-48); nothing here reads a source-document table (architecture-tested, V1-ARC-02). Each statement carries its
 * reconciliation to the trial balance, and every line lists the accounts and the general-ledger range that make it up (drill-down, V1-RPT-02).
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const MIN_DAY = '0001-01-01';

type Side = 'credit' | 'debit';
interface Bal { accountId: string; code: string; name: string; type: string; mapping: string; d: Money; c: Money }
interface ProfitLoss { lines: Record<string, Money>; accounts: Record<string, { id: string; code: string; name: string; amount: Money }[]> }

/** Profit-and-loss layout: line keys in order, with the subtotals they feed. */
const PL_LAYOUT: { key: string; side: Side }[] = [
  { key: 'PL.TURNOVER', side: 'credit' }, { key: 'PL.COST_OF_SALES', side: 'debit' }, { key: 'PL.ADMIN_EXPENSES', side: 'debit' }, { key: 'PL.DEPRECIATION', side: 'debit' },
  { key: 'PL.OTHER_EXPENSES', side: 'debit' }, { key: 'PL.OTHER_INCOME', side: 'credit' }, { key: 'PL.INTEREST_RECEIVABLE', side: 'credit' }, { key: 'PL.INTEREST_PAYABLE', side: 'debit' },
  { key: 'PL.TAXATION', side: 'debit' },
];
const BS_ASSETS = ['BS.FIXED_ASSETS.INTANGIBLE', 'BS.FIXED_ASSETS.TANGIBLE', 'BS.CURRENT_ASSETS.STOCK', 'BS.CURRENT_ASSETS.DEBTORS', 'BS.CURRENT_ASSETS.CASH'];

export class ReportService {
  private readonly rates = new RateService();

  private async company(tx: Tx, companyId: string) {
    const c = await tx.company.findFirst({ where: { id: companyId }, select: { id: true, name: true, baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    const minor = (await tx.currency.findUnique({ where: { code: c.baseCurrency } }))?.minorUnits ?? 2;
    return { ...c, minor };
  }

  /** Debits and credits per account for journals dated in [from, to] (journal lines only). */
  private async balances(tx: Tx, companyId: string, from: string, to: string): Promise<Bal[]> {
    const rows = await tx.$queryRaw<{ account_id: string; code: string; name: string; type: string; reporting_mapping: string; d: string; c: string }[]>`
      SELECT l.account_id, a.code, a.name, a.type::text AS type, a.reporting_mapping, sum(l.debit)::text AS d, sum(l.credit)::text AS c
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date >= ${from}::date AND j.journal_date <= ${to}::date
       GROUP BY l.account_id, a.code, a.name, a.type, a.reporting_mapping ORDER BY a.code`;
    return rows.map((r) => ({ accountId: r.account_id, code: r.code, name: r.name, type: r.type, mapping: r.reporting_mapping, d: money(r.d), c: money(r.c) }));
  }

  private profitLoss(bals: Bal[]): ProfitLoss {
    const lines: Record<string, Money> = Object.fromEntries(PL_LAYOUT.map((l) => [l.key, ZERO]));
    const accounts: ProfitLoss['accounts'] = Object.fromEntries(PL_LAYOUT.map((l) => [l.key, []]));
    for (const b of bals) {
      const layout = PL_LAYOUT.find((l) => l.key === b.mapping);
      if (!layout || REPORT_LINES[b.mapping]?.statement !== 'PL') continue;
      const amount = layout.side === 'credit' ? b.c.minus(b.d) : b.d.minus(b.c);
      if (amount.isZero()) continue;
      lines[b.mapping] = lines[b.mapping]!.plus(amount);
      accounts[b.mapping]!.push({ id: b.accountId, code: b.code, name: b.name, amount });
    }
    return { lines, accounts };
  }
  private plTotals(p: ProfitLoss) {
    const v = (k: string) => p.lines[k] ?? ZERO;
    const grossProfit = v('PL.TURNOVER').minus(v('PL.COST_OF_SALES'));
    const operatingProfit = grossProfit.minus(v('PL.ADMIN_EXPENSES')).minus(v('PL.DEPRECIATION')).minus(v('PL.OTHER_EXPENSES')).plus(v('PL.OTHER_INCOME'));
    const profitBeforeTax = operatingProfit.plus(v('PL.INTEREST_RECEIVABLE')).minus(v('PL.INTEREST_PAYABLE'));
    return { grossProfit, operatingProfit, profitBeforeTax, profitForPeriod: profitBeforeTax.minus(v('PL.TAXATION')) };
  }
  /** The net of every income and expense account for the range, straight from the lines: the P&L must equal it to the cent. */
  private plNet(bals: Bal[]) { return bals.filter((b) => b.type === 'INCOME' || b.type === 'EXPENSE').reduce((t, b) => t.plus(b.c).minus(b.d), ZERO); }

  async profitAndLoss(tx: Tx, companyId: string, q: { from: string; to: string; compareFrom?: string; compareTo?: string; includeEmpty?: boolean }) {
    if (q.to < q.from) throw unprocessable('to cannot precede from', 'invalid_date');
    if ((q.compareFrom === undefined) !== (q.compareTo === undefined)) throw unprocessable('Give both compareFrom and compareTo', 'invalid_date');
    const co = await this.company(tx, companyId);
    const run = async (from: string, to: string) => {
      const bals = await this.balances(tx, companyId, from, to);
      const p = this.profitLoss(bals);
      return { from, to, p, t: this.plTotals(p), net: this.plNet(bals) };
    };
    const cur = await run(q.from, q.to);
    const cmp = q.compareFrom ? await run(q.compareFrom, q.compareTo!) : null;
    const f = (m: Money | undefined) => fmt(m ?? ZERO, co.minor);
    const line = (key: string) => ({ key, name: REPORT_LINES[key]!.name, amount: f(cur.p.lines[key]), ...(cmp ? { comparative: f(cmp.p.lines[key]) } : {}),
      accounts: cur.p.accounts[key]!.map((a) => ({ accountId: a.id, code: a.code, name: a.name, amount: f(a.amount), drilldown: { accountId: a.id, from: q.from, to: q.to } })) });
    const total = (name: string, k: keyof ReturnType<ReportService['plTotals']>) => ({ key: `TOTAL.${k}`, name, total: true, amount: f(cur.t[k]), ...(cmp ? { comparative: f(cmp.t[k]) } : {}) });
    const keep = (l: { amount: string; comparative?: string; total?: boolean }) => q.includeEmpty || l.total || !money(l.amount).isZero() || (l.comparative !== undefined && !money(l.comparative).isZero());
    const lines = [
      line('PL.TURNOVER'), line('PL.COST_OF_SALES'), total('Gross profit', 'grossProfit'),
      line('PL.ADMIN_EXPENSES'), line('PL.DEPRECIATION'), line('PL.OTHER_EXPENSES'), line('PL.OTHER_INCOME'), total('Operating profit', 'operatingProfit'),
      line('PL.INTEREST_RECEIVABLE'), line('PL.INTEREST_PAYABLE'), total('Profit before taxation', 'profitBeforeTax'),
      line('PL.TAXATION'), total('Profit for the period', 'profitForPeriod'),
    ].filter(keep);
    return {
      companyId, companyName: co.name, currency: co.baseCurrency, from: q.from, to: q.to, comparative: cmp ? { from: cmp.from, to: cmp.to } : null, mappingVersion: REPORT_MAPPING_VERSION,
      lines, profitForPeriod: f(cur.t.profitForPeriod),
      reconciliation: { incomeLessExpensesFromLedger: f(cur.net), difference: f(cur.t.profitForPeriod.minus(cur.net)), reconciled: cur.t.profitForPeriod.equals(cur.net),
        ...(cmp ? { comparative: { incomeLessExpensesFromLedger: f(cmp.net), reconciled: cmp.t.profitForPeriod.equals(cmp.net) } } : {}) },
      notice: 'Management accounts from the ledger: exact amounts, no rounding, no notes. Statutory accounts (FRS 102/105) come in V2.',
    };
  }

  /** The financial year that contains the date: the accounting period covering it (else everything up to the date counts as this year). */
  private async yearStart(tx: Tx, companyId: string, asOf: string) {
    const p = await tx.accountingPeriod.findFirst({ where: { companyId, startDate: { lte: new Date(`${asOf}T00:00:00.000Z`) }, endDate: { gte: new Date(`${asOf}T00:00:00.000Z`) } }, select: { startDate: true } });
    return p ? isoDay(p.startDate) : MIN_DAY;
  }

  private async balanceSheetAt(tx: Tx, companyId: string, asOf: string) {
    const bals = await this.balances(tx, companyId, MIN_DAY, asOf);
    const yStart = await this.yearStart(tx, companyId, asOf);
    const ytd = yStart === MIN_DAY ? this.plNet(bals) : this.plNet(await this.balances(tx, companyId, yStart, asOf));
    const plCumulative = this.plNet(bals);
    const lines: Record<string, Money> = {}; const accounts: Record<string, { id: string; code: string; name: string; amount: Money }[]> = {};
    let tbDebit = ZERO, tbCredit = ZERO;
    for (const b of bals) {
      const net = b.d.minus(b.c);
      if (net.greaterThan(0)) tbDebit = tbDebit.plus(net); else tbCredit = tbCredit.plus(net.negated());
      if (REPORT_LINES[b.mapping]?.statement !== 'BS') continue;
      const amount = b.type === 'ASSET' ? net : net.negated();
      if (amount.isZero()) continue;
      lines[b.mapping] = (lines[b.mapping] ?? ZERO).plus(amount);
      (accounts[b.mapping] ??= []).push({ id: b.accountId, code: b.code, name: b.name, amount });
    }
    const v = (k: string) => lines[k] ?? ZERO;
    const fixed = v('BS.FIXED_ASSETS.INTANGIBLE').plus(v('BS.FIXED_ASSETS.TANGIBLE'));
    const current = v('BS.CURRENT_ASSETS.STOCK').plus(v('BS.CURRENT_ASSETS.DEBTORS')).plus(v('BS.CURRENT_ASSETS.CASH'));
    const within = v('BS.CREDITORS_WITHIN_ONE_YEAR'), after = v('BS.CREDITORS_AFTER_ONE_YEAR');
    const netCurrent = current.minus(within), totalLessCurrent = fixed.plus(netCurrent), netAssets = totalLessCurrent.minus(after);
    const share = v('BS.CAPITAL.SHARE_CAPITAL'), reserves = v('BS.CAPITAL.RESERVES');
    const broughtForward = plCumulative.minus(ytd);
    const equity = share.plus(reserves).plus(plCumulative);
    return { lines, accounts, fixed, current, within, after, netCurrent, totalLessCurrent, netAssets, share, reserves, broughtForward, ytd, plCumulative, equity, yearStart: yStart === MIN_DAY ? null : yStart, tbDebit, tbCredit };
  }

  async balanceSheet(tx: Tx, companyId: string, q: { asOf: string; compareAsOf?: string; includeEmpty?: boolean }) {
    const co = await this.company(tx, companyId);
    const cur = await this.balanceSheetAt(tx, companyId, q.asOf);
    const cmp = q.compareAsOf ? await this.balanceSheetAt(tx, companyId, q.compareAsOf) : null;
    const f = (m: Money | undefined) => fmt(m ?? ZERO, co.minor);
    const line = (key: string) => ({ key, name: REPORT_LINES[key]!.name, amount: f(cur.lines[key]), ...(cmp ? { comparative: f(cmp.lines[key]) } : {}),
      accounts: (cur.accounts[key] ?? []).map((a) => ({ accountId: a.id, code: a.code, name: a.name, amount: f(a.amount), drilldown: { accountId: a.id, from: null, to: q.asOf } })) });
    const total = (key: string, name: string, pick: (b: typeof cur) => Money) => ({ key, name, total: true, amount: f(pick(cur)), ...(cmp ? { comparative: f(pick(cmp)) } : {}) });
    const keep = (l: { amount: string; comparative?: string; total?: boolean }) => q.includeEmpty || l.total || !money(l.amount).isZero() || (l.comparative !== undefined && !money(l.comparative).isZero());
    const lines = [
      ...BS_ASSETS.slice(0, 2).map(line), total('TOTAL.FIXED_ASSETS', 'Fixed assets', (b) => b.fixed),
      ...BS_ASSETS.slice(2).map(line), total('TOTAL.CURRENT_ASSETS', 'Current assets', (b) => b.current),
      line('BS.CREDITORS_WITHIN_ONE_YEAR'), total('TOTAL.NET_CURRENT_ASSETS', 'Net current assets (liabilities)', (b) => b.netCurrent),
      total('TOTAL.ASSETS_LESS_CURRENT', 'Total assets less current liabilities', (b) => b.totalLessCurrent),
      line('BS.CREDITORS_AFTER_ONE_YEAR'), total('TOTAL.NET_ASSETS', 'Net assets', (b) => b.netAssets),
      line('BS.CAPITAL.SHARE_CAPITAL'), line('BS.CAPITAL.RESERVES'),
      { key: 'PL.BROUGHT_FORWARD', name: 'Profit and loss account brought forward', amount: f(cur.broughtForward), ...(cmp ? { comparative: f(cmp.broughtForward) } : {}) },
      { key: 'PL.YEAR_TO_DATE', name: 'Profit for the financial year to date', amount: f(cur.ytd), ...(cmp ? { comparative: f(cmp.ytd) } : {}), drilldown: { report: 'profit-and-loss', from: cur.yearStart, to: q.asOf } },
      total('TOTAL.EQUITY', 'Capital and reserves', (b) => b.equity),
    ].filter(keep);
    const proof = (b: typeof cur) => ({ netAssets: f(b.netAssets), capitalAndReserves: f(b.equity), difference: f(b.netAssets.minus(b.equity)), balanced: b.netAssets.equals(b.equity),
      trialBalance: { debit: f(b.tbDebit), credit: f(b.tbCredit), balanced: b.tbDebit.equals(b.tbCredit) } });
    return {
      companyId, companyName: co.name, currency: co.baseCurrency, asOf: q.asOf, compareAsOf: q.compareAsOf ?? null, financialYearStart: cur.yearStart, mappingVersion: REPORT_MAPPING_VERSION,
      lines, netAssets: f(cur.netAssets), reconciliation: { ...proof(cur), ...(cmp ? { comparative: proof(cmp) } : {}) },
      notice: 'Management accounts from the ledger: there is no year-end closing journal yet, so the profit and loss account is the P&L cumulated to the date (V2 adds statutory presentation).',
    };
  }

  // ───── FX report (DEC-045, V1-FX-09) ─────
  async fx(tx: Tx, companyId: string, q: { from: string; to: string }) {
    if (q.to < q.from) throw unprocessable('to cannot precede from', 'invalid_date');
    const co = await this.company(tx, companyId);
    const settings = await tx.companyFxSetting.findFirst({ where: { companyId } });
    const f = (m: Money) => fmt(m, co.minor);
    // exchange differences: what the FX accounts received in the range, by the journal that posted it (credit = gain)
    const fxAccounts = [settings?.realisedAccountId, settings?.unrealisedAccountId].filter((x): x is string => !!x);
    const diffs = fxAccounts.length === 0 ? [] : await tx.$queryRaw<{ journal_id: string; journal_number: number; journal_date: Date; source_type: string; account_id: string; gain: string; ccy: string | null }[]>`
      SELECT j.id AS journal_id, j.journal_number, j.journal_date, j.source_type, l.account_id, sum(l.credit - l.debit)::text AS gain,
             (SELECT min(coalesce(x.adjusts_currency, x.original_currency)) FROM journal_line x WHERE x.journal_id = j.id AND coalesce(x.adjusts_currency, x.original_currency) IS NOT NULL) AS ccy
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ANY(${fxAccounts}::uuid[]) AND j.journal_date >= ${q.from}::date AND j.journal_date <= ${q.to}::date
       GROUP BY j.id, j.journal_number, j.journal_date, j.source_type, l.account_id ORDER BY j.journal_date, j.journal_number`;
    const kind = (accountId: string) => (accountId === settings?.realisedAccountId ? 'REALISED' : 'UNREALISED');
    const byKind = (k: string) => diffs.filter((d) => kind(d.account_id) === k);
    const summary = (k: string) => {
      const items = byKind(k);
      const byCcy = new Map<string, Money>();
      for (const d of items) byCcy.set(d.ccy ?? '-', (byCcy.get(d.ccy ?? '-') ?? ZERO).plus(money(d.gain)));
      return { total: f(items.reduce((t, d) => t.plus(money(d.gain)), ZERO)), byCurrency: [...byCcy.entries()].sort().map(([currency, v]) => ({ currency, gain: f(v) })),
        journals: items.map((d) => ({ journalId: d.journal_id, journalNumber: d.journal_number, journalDate: isoDay(d.journal_date), sourceType: d.source_type, currency: d.ccy, gain: f(money(d.gain)) })) };
    };
    // open foreign-currency monetary balances at the end of the range, against the closing rate
    const subtypes = [...MONETARY_SUBTYPES];
    const open = await tx.$queryRaw<{ account_id: string; code: string; name: string; ccy: string; orig: string; carrying: string }[]>`
      SELECT l.account_id, a.code, a.name, coalesce(l.original_currency, l.adjusts_currency) AS ccy,
             coalesce(sum(l.original_debit - l.original_credit) FILTER (WHERE l.original_currency IS NOT NULL), 0)::text AS orig, sum(l.debit - l.credit)::text AS carrying
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date <= ${q.to}::date AND coalesce(l.original_currency, l.adjusts_currency) IS NOT NULL AND a.subtype = ANY(${subtypes}::text[])
       GROUP BY l.account_id, a.code, a.name, coalesce(l.original_currency, l.adjusts_currency) ORDER BY a.code, 4`;
    const rates = new Map<string, { id: string; rate: Money } | { error: string }>();
    for (const ccy of [...new Set(open.map((o) => o.ccy))]) {
      try { const r = await this.rates.lookup(tx, { companyId, from: ccy, to: co.baseCurrency, date: q.to }); rates.set(ccy, { id: r.id, rate: r.rate }); }
      catch (e) { rates.set(ccy, { error: (e as Error).message }); }
    }
    const balances = open.filter((o) => !(money(o.orig).isZero() && money(o.carrying).isZero())).map((o) => {
      const r = rates.get(o.ccy)!;
      const orig = money(o.orig), carrying = money(o.carrying);
      if ('error' in r) return { accountId: o.account_id, accountCode: o.code, accountName: o.name, currency: o.ccy, originalBalance: orig.toFixed(4), carryingAmount: f(carrying), closingRate: null, rateId: null, atClosingRate: null, unrevaluedDifference: null, rateError: r.error };
      const target = convert(orig, r.rate, co.minor);
      return { accountId: o.account_id, accountCode: o.code, accountName: o.name, currency: o.ccy, originalBalance: orig.toFixed(4), carryingAmount: f(carrying), closingRate: r.rate.toFixed(8), rateId: r.id,
        atClosingRate: f(target), unrevaluedDifference: f(target.minus(carrying)), rateError: null };
    });
    return { companyId, currency: co.baseCurrency, from: q.from, to: q.to, realised: summary('REALISED'), unrealised: summary('UNREALISED'),
      openBalances: balances, revaluedAtClosingRate: balances.every((b) => b.unrevaluedDifference !== null && money(b.unrevaluedDifference).isZero()),
      notice: `Gains are positive, losses negative. Open balances use the rate lookup rule of M3 as at ${q.to} (the latest earlier rate within the lookup window when none covers the day).` };
  }
}
