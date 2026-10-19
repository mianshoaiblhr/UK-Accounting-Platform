import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';
import { adminSql } from '../helpers/db';

/** V2-M3b through the public API (v2-plan 5b.4): the golden closes (DEC-054, DEC-060) to the cent, statements before and after, the refused posting, the reversal and the re-close, permissions and tenancy. Synthetic data. */
type Lines = [string, string, string][];
type Pl = { from?: string; to?: string; lines: Record<string, string>; grossProfit?: string; operatingProfit?: string; profitForPeriod: string; incomeLessExpensesFromLedger?: string };
type Bs = { asOf: string; lines: Record<string, string>; netAssets: string; equity: string; closedToRetainedEarnings?: string };
type Tb = { asOf: string; rows: Lines; totalDebit: string; totalCredit: string };
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m3b-close.json'), 'utf8')) as {
  periods: [string, string][]; seed: { ref: string; date: string; description: string; lines: Lines }[];
  accrual: { kind: string; description: string; amount: string; plAccount: string; balanceAccount: string; date: string };
  before: { profitAndLoss2026: Pl; profitAndLossAll: Pl; balanceSheets: Bs[]; trialBalance2026: Tb };
  closes: { preview2026First: { yearStart: string; yearEnd: string; profit: string; warnings: string[] }; close2025: Record<string, any>; close2026: Record<string, any> };
  after: { closedToRetainedEarnings: Record<string, string>; trialBalance2026: Tb; closeView2026: { status: string; yearIncomeLessExpensesIncludingClose: string };
    generalLedger4000: { from: string; to: string; all: { openingBalance: string; items: string[][] }; excludeClosing: { openingBalance: string; items: string[][] } };
    refusedPosting: { date: string; lines: Lines; code: string }; closeAgain2026: { code: string } };
  reopen: { reverse2026: { reason: string; journalDate: string; journal: Lines }; latePosting: { date: string; description: string; lines: Lines }; reclose2026: { profit: string; journal: Lines };
    profitAndLoss2026: Pl; balanceSheet2026: Bs };
};

let s: Stack;
let owner: TestUser, accountant: TestUser, reviewer: TestUser, bookkeeper: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {}, refs: Record<string, string> = {};
const closeIds: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const inOrder = (journalId: string) => adminSql(`SELECT string_agg(a.code || ':' || l.debit::numeric(19,2) || ':' || l.credit::numeric(19,2), ',' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.journal_id = '${journalId}'`);
const expected = (lines: Lines) => lines.map(([k, d, cr]) => `${k}:${d}:${cr}`).join(',');
const journal = (date: string, description: string, lines: Lines) => as(accountant, 'post', c('/journals'), { journalDate: date, description, lines: lines.map(([k, debit, credit]) => ({ accountId: acc[k], debit, credit })) });
const snapshot = async () => ({
  pl2026: ok(await as(reviewer, 'get', c(`/reports/profit-and-loss?from=2026-01-01&to=2026-12-31`))),
  plAll: ok(await as(reviewer, 'get', c(`/reports/profit-and-loss?from=2025-01-01&to=2027-06-30`))),
  bs: await Promise.all(G.before.balanceSheets.map(async (b) => ok(await as(reviewer, 'get', c(`/reports/balance-sheet?asOf=${b.asOf}`))))),
});
const checkPl = (r: any, x: Pl) => {
  const v = (k: string) => r.lines.find((l: { key: string }) => l.key === k)?.amount ?? '0.00';
  for (const [k, amount] of Object.entries(x.lines)) expect(v(k), k).toBe(amount);
  if (x.grossProfit) expect(v('TOTAL.grossProfit')).toBe(x.grossProfit);
  if (x.operatingProfit) expect(v('TOTAL.operatingProfit')).toBe(x.operatingProfit);
  expect(r.profitForPeriod).toBe(x.profitForPeriod);
  if (x.incomeLessExpensesFromLedger) expect(r.reconciliation).toMatchObject({ incomeLessExpensesFromLedger: x.incomeLessExpensesFromLedger, reconciled: true });
};
const checkBs = (r: any, x: Bs) => {
  const v = (k: string) => r.lines.find((l: { key: string }) => l.key === k)?.amount ?? '0.00';
  for (const [k, amount] of Object.entries(x.lines)) expect(v(k), `${x.asOf} ${k}`).toBe(amount);
  expect([r.netAssets, v('TOTAL.EQUITY'), r.reconciliation.balanced, r.reconciliation.trialBalance.balanced]).toEqual([x.netAssets, x.equity, true, true]);
  if (x.closedToRetainedEarnings) expect(r.reconciliation.closedToRetainedEarnings).toBe(x.closedToRetainedEarnings);
};
const checkTb = (r: any, x: Tb) => {
  expect(r.rows.map((row: { code: string; debit: string; credit: string }) => [row.code, row.debit, row.credit])).toEqual(x.rows);
  expect([r.totalDebit, r.totalCredit, r.balanced]).toEqual([x.totalDebit, x.totalCredit, true]);
};
let before: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Golden Close Ltd');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of G.periods) ok(await as(owner, 'post', c('/periods'), { startDate, endDate }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  for (const p of G.seed) refs[p.ref] = ok(await journal(p.date, p.description, p.lines), 201).id;
  const a = G.accrual;
  ok(await as(accountant, 'post', c('/year-end-items'), { kind: a.kind, description: a.description, amount: a.amount, plAccountId: acc[a.plAccount], balanceAccountId: acc[a.balanceAccount], date: a.date }), 201);
});
afterAll(() => s.stop());

describe('before any close (DEC-060)', () => {
  it('the P&L, balance sheets and trial balance are the hand-written figures', async () => {
    before = await snapshot();
    checkPl(before.pl2026, G.before.profitAndLoss2026);
    checkPl(before.plAll, G.before.profitAndLossAll);
    G.before.balanceSheets.forEach((b, i) => checkBs(before.bs[i], { ...b, closedToRetainedEarnings: '0.00' }));
    checkTb(ok(await as(reviewer, 'get', c('/reports/trial-balance?asOf=2026-12-31'))), G.before.trialBalance2026);
  });
});

describe('closing 2025 and 2026', () => {
  it('the preview warns while 2025 is open; each close posts the golden journal; only accounts:prepare may close', async () => {
    const pv = G.closes.preview2026First;
    const p = ok(await as(reviewer, 'get', c(`/year-end-closes/preview?yearStart=${pv.yearStart}&yearEnd=${pv.yearEnd}`)));
    expect(p).toMatchObject({ profit: pv.profit, warnings: pv.warnings, canPost: true });
    expect((await as(bookkeeper, 'post', c('/year-end-closes'), { yearStart: pv.yearStart, yearEnd: pv.yearEnd })).status).toBe(403);
    expect((await as(reviewer, 'post', c('/year-end-closes'), { yearStart: pv.yearStart, yearEnd: pv.yearEnd })).status).toBe(403);
    for (const key of ['close2025', 'close2026'] as const) {
      const x = G.closes[key];
      if (x.warnings) expect(ok(await as(reviewer, 'get', c(`/year-end-closes/preview?yearStart=${x.yearStart}&yearEnd=${x.yearEnd}`))).warnings).toEqual(x.warnings);
      const r = ok(await as(accountant, 'post', c('/year-end-closes'), { yearStart: x.yearStart, yearEnd: x.yearEnd }), 201);
      closeIds[key] = r.id;
      expect(r).toMatchObject({ status: 'POSTED', profit: x.profit, yearStart: x.yearStart, yearEnd: x.yearEnd });
      expect(inOrder(r.journalId)).toBe(expected(x.journal));
      expect(adminSql(`SELECT journal_date::text || ':' || source_type FROM journal WHERE id = '${r.journalId}'`)).toBe(`${x.journalDate}:YEAR_END_CLOSE`);
      refs[key === 'close2026' ? 'CLOSE2026' : 'CLOSE2025'] = r.journalId;
    }
    expect(ok(await as(reviewer, 'get', c('/year-end-closes'))).items.map((x: { yearStart: string }) => x.yearStart)).toEqual(['2026-01-01', '2025-01-01']);
  });
});

describe('after the closes', () => {
  it('the P&L and balance sheets are exactly as before; closedToRetainedEarnings and the trial balance show the close', async () => {
    const after = await snapshot();
    expect(after.pl2026).toEqual(before.pl2026);
    expect(after.plAll).toEqual(before.plAll);
    after.bs.forEach((b: any, i: number) => {
      // everything but the two ledger-wide figures is unchanged: the trial-balance proof (the whole ledger) and what the closes moved
      const lines = (x: any) => ({ ...x, reconciliation: { ...x.reconciliation, closedToRetainedEarnings: null, trialBalance: null } });
      expect(lines(b)).toEqual(lines(before.bs[i]));
      checkBs(b, { ...G.before.balanceSheets[i]!, closedToRetainedEarnings: G.after.closedToRetainedEarnings[b.asOf] });
    });
    checkTb(ok(await as(reviewer, 'get', c('/reports/trial-balance?asOf=2026-12-31'))), G.after.trialBalance2026);
    expect(ok(await as(reviewer, 'get', c(`/year-end-closes/${closeIds.close2026}`)))).toMatchObject(G.after.closeView2026);
  });
  it('the general ledger shows the close; excludeClosing, which every P&L drill-down carries, leaves it out', async () => {
    const g = G.after.generalLedger4000;
    const drill = before.pl2026.lines.find((l: { key: string }) => l.key === 'PL.TURNOVER').accounts[0].drilldown;
    expect(drill).toEqual({ accountId: acc['4000'], from: g.from, to: g.to, excludeClosing: true });
    for (const mode of ['all', 'excludeClosing'] as const) {
      const r = ok(await as(reviewer, 'get', c(`/ledger?accountId=${acc['4000']}&from=${g.from}&to=${g.to}${mode === 'excludeClosing' ? '&excludeClosing=true' : ''}`)));
      expect(r.excludeClosing).toBe(mode === 'excludeClosing');
      expect(r.openingBalance).toBe(g[mode].openingBalance);
      expect(r.items.map((i: { journalId: string; debit: string; credit: string; balance: string }) => [i.journalId, i.debit, i.credit, i.balance])).toEqual(g[mode].items.map(([ref, ...rest]) => [refs[ref!], ...rest]));
    }
  });
  it('income and expense cannot be posted into a closed year; the year cannot be closed twice; outsiders see nothing', async () => {
    const x = G.after.refusedPosting;
    expect((await journal(x.date, 'Late stationery invoice', x.lines)).body.code).toBe(x.code);
    expect((await as(accountant, 'post', c('/year-end-closes'), { yearStart: '2026-01-01', yearEnd: '2026-12-31' })).body.code).toBe(G.after.closeAgain2026.code);
    expect((await as(accountant, 'post', c('/year-end-closes'), { yearStart: '2026-12-31', yearEnd: '2026-01-01' })).status).toBe(422);
    expect((await as(outsider, 'get', c('/year-end-closes'))).status).toBe(404);
    expect((await as(outsider, 'get', c(`/year-end-closes/${closeIds.close2026}`))).status).toBe(404);
  });
});

describe('reopening 2026', () => {
  it('the close is reversed by its mirror; the late posting goes in; the re-close and the statements are the golden figures', async () => {
    const rv = G.reopen.reverse2026;
    expect((await as(reviewer, 'post', c(`/year-end-closes/${closeIds.close2026}/reverse`), { reason: rv.reason })).status).toBe(403);
    const r = ok(await as(accountant, 'post', c(`/year-end-closes/${closeIds.close2026}/reverse`), { reason: rv.reason }));
    expect(r).toMatchObject({ status: 'REVERSED', reversedReason: rv.reason });
    expect(inOrder(r.reversalJournalId)).toBe(expected(rv.journal));
    expect(adminSql(`SELECT journal_date::text || ':' || source_type FROM journal WHERE id = '${r.reversalJournalId}'`)).toBe(`${rv.journalDate}:YEAR_END_CLOSE_REVERSAL`);
    expect((await as(accountant, 'post', c(`/year-end-closes/${closeIds.close2026}/reverse`), { reason: rv.reason })).body.code).toBe('close_reversed');
    const lp = G.reopen.latePosting;
    ok(await journal(lp.date, lp.description, lp.lines), 201);
    const again = ok(await as(accountant, 'post', c('/year-end-closes'), { yearStart: '2026-01-01', yearEnd: '2026-12-31' }), 201);
    expect(again.profit).toBe(G.reopen.reclose2026.profit);
    expect(inOrder(again.journalId)).toBe(expected(G.reopen.reclose2026.journal));
    checkPl(ok(await as(reviewer, 'get', c('/reports/profit-and-loss?from=2026-01-01&to=2026-12-31'))), G.reopen.profitAndLoss2026);
    checkBs(ok(await as(reviewer, 'get', c('/reports/balance-sheet?asOf=2026-12-31'))), G.reopen.balanceSheet2026);
    // drill-down from the close journal to its source
    const d = ok(await as(reviewer, 'get', c(`/journals/${again.journalId}/source`)));
    expect([d.sourceResolver, d.source.entityType, d.source.id, d.source.profit]).toEqual(['resolved', 'year_end_close', again.id, '8215.44']);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE entity_type = 'year_end_close' AND entity_id IN ('${closeIds.close2026}', '${again.id}')`)).toBe('3');
  });
});
