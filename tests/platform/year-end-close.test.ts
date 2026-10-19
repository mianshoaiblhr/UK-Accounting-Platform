import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, LedgerQueries, PeriodService, PostingService, ReportService, YearEndCloseService, type PostingActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V2-M3b through the services: the five posting-rule categories of YEAR_END_CLOSE and YEAR_END_CLOSE_REVERSAL (DEC-047, DEC-060), the year rules,
 * the closed-year fence on every other posting, and statements that read the same before and after a close. Figures by hand in each test.
 */
let db: Database;
let org: string, user: string;
const acc: Record<string, Record<string, string>> = {};
const posting = new PostingService();
const closes = new YearEndCloseService(posting);
const reports = new ReportService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const all = async () => true;
const me = (deny: string[] = []): PostingActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string) => expect(p).rejects.toMatchObject({ code: c });
const lines = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit::numeric(19,2)||'/'||l.credit::numeric(19,2), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);
const journals = (co: string) => sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`);
const period = (co: string, start: string) => sql(`SELECT id FROM accounting_period WHERE company_id='${co}' AND start_date='${start}'`);
const transition = (co: string, start: string, action: 'close' | 'reopen' | 'lock' | 'unlock') =>
  t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: co, periodId: period(co, start), action, reason: 'Synthetic', userId: user, can: all, acknowledgeDraftDocuments: true, acknowledgeUnreconciledBank: true }));
const company = async (name: string, periods: [string, string][]) => {
  const co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','${name}') RETURNING id`).split('\n')[0]!;
  for (const [s, e] of periods) sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','${s}','${e}')`);
  acc[co] = {};
  for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[co]![a.code] = a.id;
  return co;
};
const manual = (co: string, date: string, dr: string, cr: string, amount: string) => t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: date, sourceType: 'MANUAL', description: `Synthetic ${dr}/${cr}`,
  idempotencyKey: `m-${uuidv7()}`, actor: me(), lines: [{ accountId: acc[co]![dr]!, debit: amount, credit: '0' }, { accountId: acc[co]![cr]!, debit: '0', credit: amount }] }));
const close = (co: string, yearStart: string, yearEnd: string, actor = me()) => t((tx) => closes.close(tx, { organisationId: org, companyId: co, actor, yearStart, yearEnd }));
const reverse = (co: string, id: string, actor = me()) => t((tx) => closes.reverse(tx, { organisationId: org, companyId: co, actor, id, reason: 'Late invoice (synthetic)' }));
const YEARS: [string, string][] = [['2025-01-01', '2025-12-31'], ['2026-01-01', '2026-12-31']];

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('yec-${org}@t.test','YEC') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Year-end close')`);
});
afterAll(() => db.close());

describe('YEAR_END_CLOSE', () => {
  it('closes a year: one journal dated the year end, income and expense to retained earnings in code order; a loss debits retained earnings', async () => {
    const co = await company('Close A', YEARS);
    await manual(co, '2025-03-31', '1110', '4000', '1000.00');
    await manual(co, '2025-04-30', '6100', '1110', '250.00');
    expect((await t((tx) => closes.preview(tx, co, { yearStart: '2025-01-01', yearEnd: '2025-12-31' })))).toMatchObject({ profit: '750.00', canPost: true, warnings: [], blockers: [] });
    const c = await close(co, '2025-01-01', '2025-12-31');
    expect(c).toMatchObject({ status: 'POSTED', profit: '750.00', yearIncomeLessExpensesIncludingClose: '0.00', retainedEarningsAccountId: acc[co]!['3200'] });
    expect(lines(c.journalId)).toBe('4000:1000.00/0.00 ; 6100:0.00/250.00 ; 3200:0.00/750.00');
    expect(sql(`SELECT journal_date::text||':'||source_type||':'||source_id FROM journal WHERE id='${c.journalId}'`)).toBe(`2025-12-31:YEAR_END_CLOSE:${c.id}`);
    // 2026 makes a loss of 400.00 - 100.00 = 300.00
    await manual(co, '2026-02-28', '6300', '1110', '400.00');
    await manual(co, '2026-03-31', '1110', '4000', '100.00');
    const p = await t((tx) => closes.preview(tx, co, { yearStart: '2026-01-01', yearEnd: '2026-12-31' }));
    expect(p.warnings).toEqual([]);                                     // 2025 is closed
    const l = await close(co, '2026-01-01', '2026-12-31');
    expect(l.profit).toBe('-300.00');
    expect(lines(l.journalId)).toBe('4000:100.00/0.00 ; 6300:0.00/400.00 ; 3200:300.00/0.00');
    expect(sql(`SELECT action FROM audit_event WHERE entity_type='year_end_close' AND entity_id='${l.id}'`)).toBe('year_end.year_closed');
    expect((await t((tx) => closes.list(tx, co, {}))).items.map((x) => x.yearStart)).toEqual(['2026-01-01', '2025-01-01']);
  });

  it('refuses a year that is not aligned to periods, has a gap, runs over 18 months, overlaps a live close or has nothing to close, and anyone without accounts:prepare or an AI; nothing is written', async () => {
    const co = await company('Close B', [['2026-01-01', '2026-06-30'], ['2026-07-01', '2026-12-31'], ['2027-01-01', '2027-06-30'], ['2027-08-01', '2027-12-31']]);
    await manual(co, '2026-05-31', '1110', '4000', '500.00');
    await manual(co, '2026-09-30', '6700', '1110', '200.00');
    const before = journals(co);
    await rejects(close(co, '2026-01-01', '2026-11-30'), 'year_not_aligned');
    await rejects(close(co, '2027-01-01', '2027-12-31'), 'year_not_aligned');                // July 2027 has no period
    await rejects(close(co, '2026-01-01', '2027-12-31'), 'year_too_long');
    await rejects(close(co, '2027-01-01', '2027-06-30'), 'nothing_to_close');
    await rejects(close(co, '2026-01-01', '2026-12-31', me(['accounts:prepare'])), 'permission_denied');
    await rejects(close(co, '2026-01-01', '2026-12-31', { ...me(), kind: 'AI' }), 'ai_cannot_post');
    expect(journals(co)).toBe(before);
    // a year of two periods closes; 18 months is the longest year (2026-01-01 to 2027-06-30 would be allowed)
    expect((await t((tx) => closes.preview(tx, co, { yearStart: '2026-01-01', yearEnd: '2027-06-30' }))).blockers).toEqual([]);
    const c = await close(co, '2026-01-01', '2026-12-31');
    expect(lines(c.journalId)).toBe('4000:500.00/0.00 ; 6700:0.00/200.00 ; 3200:0.00/300.00');
    await rejects(close(co, '2026-01-01', '2026-12-31'), 'year_already_closed');
    await rejects(close(co, '2026-07-01', '2027-06-30'), 'year_overlaps_close');
    const p = await t((tx) => closes.preview(tx, co, { yearStart: '2026-07-01', yearEnd: '2027-06-30' }));
    expect(p.canPost).toBe(false);
    expect(p.blockers.map((b) => b.code)).toEqual(['year_overlaps_close']);
  });

  it('YEAR_END_CLOSE is corrected only by its mirror: the ledger cannot reverse it directly', async () => {
    const co = await company('Close C', YEARS);
    await manual(co, '2025-06-30', '1110', '4100', '80.00');
    const c = await close(co, '2025-01-01', '2025-12-31');
    await rejects(t((tx) => posting.reverse(tx, { organisationId: org, companyId: co, journalId: c.journalId, reason: 'Trying the ledger reversal', actor: me() })), 'subledger_journal');
  });

  it('while a close is live nothing posts income or expense into its year, journal requests included; balance-sheet postings still post', async () => {
    const co = await company('Close D', YEARS);
    await manual(co, '2025-06-30', '1110', '4000', '300.00');
    await close(co, '2025-01-01', '2025-12-31');
    const before = journals(co);
    await rejects(manual(co, '2025-11-30', '6310', '1110', '20.00'), 'year_closed');
    await rejects(t((tx) => posting.validateForRequest(tx, { organisationId: org, companyId: co, journalDate: '2025-11-30', sourceType: 'CONTROL_ADJUSTMENT', description: 'Synthetic',
      lines: [{ accountId: acc[co]!['1100']!, debit: '5.00', credit: '0' }, { accountId: acc[co]!['4000']!, debit: '0', credit: '5.00' }] })), 'year_closed');
    expect(journals(co)).toBe(before);
    await manual(co, '2025-11-30', '1120', '1110', '20.00');                                  // no income or expense line
    await manual(co, '2026-01-15', '6310', '1110', '20.00');                                  // the next year is open
    // the database refuses it again if the service is bypassed (tests/db/year-end-close.test.ts)
  });

  it('a closing source refuses a VAT code (neither carries VAT)', async () => {
    const co = await company('Close E', YEARS);
    for (const s of ['YEAR_END_CLOSE', 'YEAR_END_CLOSE_REVERSAL']) {
      await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2025-12-31', sourceType: s, sourceId: uuidv7(), description: `VAT on ${s}`, idempotencyKey: `v-${uuidv7()}`, actor: me(),
        lines: [{ accountId: acc[co]!['4000']!, debit: '10.00', credit: '0' }, { accountId: acc[co]!['3200']!, debit: '0', credit: '10.00', taxCodeId: uuidv7() }] })), 'vat_not_applicable');
    }
    expect(journals(co)).toBe('0');
  });

  it('a close and its reversal dated in a closed or locked period are refused; nothing is written', async () => {
    const co = await company('Close F', YEARS);
    await manual(co, '2025-06-30', '1110', '4000', '60.00');
    await transition(co, '2025-01-01', 'close');
    await rejects(close(co, '2025-01-01', '2025-12-31'), 'period_closed');
    await transition(co, '2025-01-01', 'reopen');
    const c = await close(co, '2025-01-01', '2025-12-31');
    await transition(co, '2025-01-01', 'close');
    await transition(co, '2025-01-01', 'lock');
    const before = journals(co);
    await rejects(reverse(co, c.id), 'period_locked');
    expect(journals(co)).toBe(before);
    expect((await t((tx) => closes.get(tx, co, c.id))).status).toBe('POSTED');
  });
});

describe('YEAR_END_CLOSE_REVERSAL', () => {
  it('reversing a close posts its mirror at the year end and opens the year to income and expense again; closing again closes what is there now', async () => {
    const co = await company('Close G', YEARS);
    await manual(co, '2025-05-31', '1110', '4000', '900.00');
    await manual(co, '2025-07-31', '6100', '1110', '400.00');
    const c = await close(co, '2025-01-01', '2025-12-31');
    const r = await reverse(co, c.id);
    expect(r).toMatchObject({ status: 'REVERSED', reversedReason: 'Late invoice (synthetic)', yearIncomeLessExpensesIncludingClose: '500.00' });
    expect(lines(r.reversalJournalId!)).toBe('4000:0.00/900.00 ; 6100:400.00/0.00 ; 3200:500.00/0.00');
    expect(sql(`SELECT journal_date::text||':'||source_type FROM journal WHERE id='${r.reversalJournalId}'`)).toBe('2025-12-31:YEAR_END_CLOSE_REVERSAL');
    await manual(co, '2025-12-20', '6310', '1110', '50.00');                                   // the late invoice now posts
    const again = await close(co, '2025-01-01', '2025-12-31');
    expect(lines(again.journalId)).toBe('4000:900.00/0.00 ; 6100:0.00/400.00 ; 6310:0.00/50.00 ; 3200:0.00/450.00');
    expect(again.profit).toBe('450.00');
  });

  it('a reversed close cannot be reversed again; a closing source reaches no control account but retained earnings; the mirror is final', async () => {
    const co = await company('Close H', YEARS);
    await manual(co, '2025-05-31', '1110', '4000', '70.00');
    const c = await close(co, '2025-01-01', '2025-12-31');
    const r = await reverse(co, c.id);
    await rejects(reverse(co, c.id), 'close_reversed');
    await rejects(t((tx) => posting.reverse(tx, { organisationId: org, companyId: co, journalId: r.reversalJournalId!, reason: 'Undo the mirror', actor: me() })), 'subledger_journal');
    for (const s of ['YEAR_END_CLOSE', 'YEAR_END_CLOSE_REVERSAL']) {
      await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2025-12-31', sourceType: s, sourceId: uuidv7(), description: `${s} to trade debtors`, idempotencyKey: `ck-${uuidv7()}`, actor: me(),
        lines: [{ accountId: acc[co]!['4000']!, debit: '10.00', credit: '0' }, { accountId: acc[co]!['1100']!, debit: '0', credit: '10.00' }] })), 'control_account_restricted');
    }
  });
});

describe('a close and concurrent postings (DEC-060 lock order)', () => {
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('a posting still open when the close starts is waited for and closed with the year; one that starts during the close is refused after it', async () => {
    const co = await company('Close J', YEARS);
    await manual(co, '2025-03-31', '1110', '4000', '100.00');
    // 1. a posting holds its transaction open; the close waits for it and then closes its amount too
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const open = t(async (tx) => { await posting.post(tx, { organisationId: org, companyId: co, journalDate: '2025-06-30', sourceType: 'MANUAL', description: 'Open while the close starts', idempotencyKey: `race-${uuidv7()}`, actor: me(),
      lines: [{ accountId: acc[co]!['1110']!, debit: '25.00', credit: '0' }, { accountId: acc[co]!['4000']!, debit: '0', credit: '25.00' }] }); await gate; });
    await later(300);
    const closing = close(co, '2025-01-01', '2025-12-31');
    await later(300);
    release();
    await open;
    const c = await closing;
    expect(c.profit).toBe('125.00');
    expect(lines(c.journalId)).toBe('4000:125.00/0.00 ; 3200:0.00/125.00');
    // 2. the reversal holds the close lock; a posting that starts meanwhile waits, then posts into the reopened year
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => { release2 = r; });
    const reversing = t(async (tx) => { const r = await closes.reverse(tx, { organisationId: org, companyId: co, actor: me(), id: c.id, reason: 'Race (synthetic)' }); await gate2; return r; });
    await later(300);
    const waiting = manual(co, '2025-07-31', '6310', '1110', '5.00');
    await later(300);
    expect(journals(co)).toBe('3');                                  // the reversal is not committed and the posting has not landed
    release2();
    await reversing;
    await waiting;
    // 3. the close holds its lock; a posting into the year that starts meanwhile is refused once the close commits
    let release3!: () => void;
    const gate3 = new Promise<void>((r) => { release3 = r; });
    const closing3 = t(async (tx) => { const r = await closes.close(tx, { organisationId: org, companyId: co, actor: me(), yearStart: '2025-01-01', yearEnd: '2025-12-31' }); await gate3; return r; });
    await later(300);
    const refused = manual(co, '2025-08-31', '6310', '1110', '7.00');
    await later(300);
    release3();
    expect((await closing3).profit).toBe('120.00');                 // 125.00 - 5.00
    await rejects(refused, 'year_closed');
  });
});

describe('statements around a close (DEC-060)', () => {
  it('the P&L, the balance sheet and the FX report read the same before and after a close; the trial balance and closedToRetainedEarnings do not', async () => {
    const co = await company('Close I', YEARS);
    sql(`INSERT INTO company_fx_setting(organisation_id, company_id, unrealised_account_id) VALUES ('${org}','${co}','${acc[co]!['4100']}')`);
    await manual(co, '2025-03-31', '1110', '4000', '2000.00');
    await manual(co, '2025-04-30', '6200', '1110', '600.00');
    // an exchange difference on the unrealised FX account (synthetic revaluation journal)
    await t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2025-12-31', sourceType: 'FX_REVALUATION', sourceId: uuidv7(), description: 'Synthetic revaluation', idempotencyKey: `fx-${uuidv7()}`, actor: me(),
      lines: [{ accountId: acc[co]!['1110']!, debit: '15.00', credit: '0' }, { accountId: acc[co]!['4100']!, debit: '0', credit: '15.00' }] }));
    const snap = async () => ({
      pl: await t((tx) => reports.profitAndLoss(tx, co, { from: '2025-01-01', to: '2025-12-31' })),
      bs: await t((tx) => reports.balanceSheet(tx, co, { asOf: '2025-12-31' })),
      fx: await t((tx) => reports.fx(tx, co, { from: '2025-01-01', to: '2025-12-31' })),
    });
    const before = await snap();
    expect(before.pl.profitForPeriod).toBe('1415.00');                                       // 2,000.00 - 600.00 + 15.00
    expect(before.bs.reconciliation.closedToRetainedEarnings).toBe('0.00');
    await close(co, '2025-01-01', '2025-12-31');
    const after = await snap();
    expect(after.pl).toEqual(before.pl);
    expect(after.fx).toEqual(before.fx);
    expect(after.fx.unrealised.journals.map((j) => j.sourceType)).toEqual(['FX_REVALUATION']);
    // everything but the two ledger-wide figures is unchanged: the trial-balance proof (the whole ledger) and what the closes moved
    const lines = (b: typeof before.bs) => ({ ...b, reconciliation: { ...b.reconciliation, closedToRetainedEarnings: '-', trialBalance: '-' } });
    expect(lines(after.bs)).toEqual(lines(before.bs));
    expect(after.bs.reconciliation).toMatchObject({ balanced: true, closedToRetainedEarnings: '1415.00', trialBalance: { debit: '1415.00', credit: '1415.00', balanced: true } });
    expect(before.bs.reconciliation.trialBalance.debit).toBe('2015.00');                      // before the close: 1110 1,415.00 + 6200 600.00
    const tb = await t((tx) => new LedgerQueries().trialBalance(tx, co, { asOf: '2025-12-31' }));
    expect(tb.rows.filter((r) => r.code.startsWith('4') || r.code.startsWith('6')).every((r) => r.debit === '0.00' && r.credit === '0.00')).toBe(true);
  });
});
