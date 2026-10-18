import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, PeriodService, PostingService, YearEndService, type PostingActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V2-M3a through the services: the five posting-rule categories of the nine year-end journal sources (DEC-047, DEC-059): positive, negative, the
 * mirror, no VAT, and a closed period. Figures by hand: a 1,200.00 prepayment over 12 months releases 100.00 a month.
 */
let db: Database;
let org: string, user: string, co: string;
const acc: Record<string, string> = {};
const posting = new PostingService();
const ye = new YearEndService(posting);
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const all = async () => true;
const me = (deny: string[] = []): PostingActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const base = (actor = me()) => ({ organisationId: org, companyId: co, actor });
const rejects = (p: Promise<unknown>, c: string) => expect(p).rejects.toMatchObject({ code: c });
const lines = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit::numeric(19,2)||'/'||l.credit::numeric(19,2), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);
const journals = () => sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`);
const accrual = (date: string, o: { pl?: string; bal?: string; kind?: 'ACCRUAL' | 'ACCRUED_INCOME'; actor?: PostingActor } = {}) =>
  t((tx) => ye.createItem(tx, { ...base(o.actor), kind: o.kind ?? 'ACCRUAL', date, description: `Synthetic accrual ${date}`, amount: '300.00', plAccountId: acc[o.pl ?? '6110']!, balanceAccountId: acc[o.bal ?? '2110']!, evidenceDocumentIds: [] }));
const prepayment = (date: string, start: string, end: string) =>
  t((tx) => ye.createItem(tx, { ...base(), kind: 'PREPAYMENT', date, description: `Synthetic prepayment ${start}`, amount: '1200.00', plAccountId: acc['6200']!, balanceAccountId: acc['1120']!, periodStart: start, periodEnd: end, convention: 'MONTHLY', setup: { kind: 'POSTED' }, evidenceDocumentIds: [] }));
const period = (start: string) => sql(`SELECT id FROM accounting_period WHERE company_id='${co}' AND start_date='${start}'`);
let provision: string;

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('ye-${org}@t.test','YE') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Year end')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','YE Co') RETURNING id`).split('\n')[0]!;
  for (const y of [2025, 2026, 2027]) sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','${y}-01-01','${y}-12-31')`);
  const accounts = new AccountService();
  for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  acc['2160'] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: co, userId: user, input: { code: '2160', name: 'Provisions', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY_OTHER', isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: 'BS.CREDITORS_WITHIN_ONE_YEAR', activeFrom: null, activeTo: null } }))).id;
});
afterAll(() => db.close());

describe('ACCRUAL, ACCRUAL_AUTO_REVERSAL and ACCRUAL_CANCELLATION', () => {
  it('an accrual posts Dr expense / Cr accruals and its reversal on the next day; accrued income the other way round', async () => {
    const a = await accrual('2027-03-31');
    expect(lines(a.accrualJournalId!)).toBe('6110:300.00/0.00 ; 2110:0.00/300.00');
    expect(lines(a.autoReversalJournalId!)).toBe('6110:0.00/300.00 ; 2110:300.00/0.00');            // the mirror keeps the line order
    expect(sql(`SELECT journal_date::text FROM journal WHERE id='${a.autoReversalJournalId}'`)).toBe('2027-04-01');
    const i = await accrual('2027-03-31', { kind: 'ACCRUED_INCOME', pl: '4900', bal: '1110' });
    expect(lines(i.accrualJournalId!)).toBe('1110:300.00/0.00 ; 4900:0.00/300.00');
  });
  it('refuses accounts of the wrong type, control accounts, a missing next period, a person without accounts:prepare and an AI actor; nothing is written', async () => {
    const before = journals();
    await rejects(accrual('2027-03-31', { pl: '4000' }), 'invalid_item_account');
    await rejects(accrual('2027-03-31', { bal: '2100' }), 'control_account_restricted');
    await rejects(accrual('2027-12-31'), 'next_period_missing');
    await rejects(accrual('2027-03-31', { actor: me(['accounts:prepare']) }), 'permission_denied');
    await rejects(accrual('2027-03-31', { actor: { ...me(), kind: 'AI' } }), 'ai_cannot_post');
    expect(journals()).toBe(before);
  });
  it('ACCRUAL_CANCELLATION mirrors the accrual and its reversal at their own dates; a second cancellation is refused', async () => {
    const a = await accrual('2027-05-31');
    const c = await t((tx) => ye.cancelItem(tx, { ...base(), id: a.id, reason: 'Invoice received before the close' }));
    expect(c.status).toBe('CANCELLED');
    expect(c.cancellationJournalIds.map((j) => lines(j))).toEqual(['6110:0.00/300.00 ; 2110:300.00/0.00', '6110:300.00/0.00 ; 2110:0.00/300.00']);
    expect(sql(`SELECT string_agg(journal_date::text||':'||source_type, ',' ORDER BY journal_date) FROM journal WHERE source_id='${a.id}' AND source_type='ACCRUAL_CANCELLATION'`)).toBe('2027-05-31:ACCRUAL_CANCELLATION,2027-06-01:ACCRUAL_CANCELLATION');
    await rejects(t((tx) => ye.cancelItem(tx, { ...base(), id: a.id, reason: 'Again' })), 'item_cancelled');
    expect(() => sql(`UPDATE year_end_item SET amount = 1 WHERE id='${a.id}'`)).toThrow(/never edited/);
  });
});

describe('ADJUSTMENT_SETUP, ADJUSTMENT_RELEASE and their reversals', () => {
  let runId: string, itemId: string;
  it('a posted set-up reclassifies from the P&L account; a release run releases by schedule; nothing to release is refused', async () => {
    const p = await prepayment('2027-01-01', '2027-01-01', '2027-12-31');
    itemId = p.id;
    expect(lines(p.setupJournalId!)).toBe('1120:1200.00/0.00 ; 6200:0.00/1200.00');
    const r = await t((tx) => ye.postRun(tx, { ...base(), asAt: '2027-02-28' }));
    runId = r.id;
    expect(r).toMatchObject({ total: '200.00', lines: [expect.objectContaining({ itemId, amount: '200.00', releasedAfter: '200.00' })] });
    expect(lines(r.journalId)).toBe('6200:200.00/0.00 ; 1120:0.00/200.00');
    await rejects(t((tx) => ye.postRun(tx, { ...base(), asAt: '2027-03-15' })), 'nothing_to_release');
    await rejects(t((tx) => ye.postRun(tx, { ...base(), asAt: '2027-02-28' })), 'run_not_later');
  });
  it('ADJUSTMENT_RELEASE_REVERSAL mirrors the latest live run only, once; the ledger cannot reverse it directly', async () => {
    const r2 = await t((tx) => ye.postRun(tx, { ...base(), asAt: '2027-03-31' }));
    await rejects(t((tx) => ye.reverseRun(tx, { ...base(), id: runId, reason: 'Not the latest' })), 'not_latest_run');
    const rev = await t((tx) => ye.reverseRun(tx, { ...base(), id: r2.id, reason: 'Re-run' }));
    expect(lines(rev.reversalJournalId!)).toBe('6200:0.00/100.00 ; 1120:100.00/0.00');
    await rejects(t((tx) => ye.reverseRun(tx, { ...base(), id: r2.id, reason: 'Again' })), 'run_reversed');
    await rejects(t((tx) => posting.reverse(tx, { organisationId: org, companyId: co, journalId: r2.journalId, reason: 'Bypass', actor: me() })), 'subledger_journal');
  });
  it('ADJUSTMENT_SETUP_REVERSAL mirrors a set-up nothing was released from; a released schedule and a second cancellation are refused', async () => {
    await rejects(t((tx) => ye.cancelItem(tx, { ...base(), id: itemId, reason: 'Released already' })), 'item_released');
    const p = await prepayment('2027-06-01', '2027-06-01', '2028-05-31');
    const c = await t((tx) => ye.cancelItem(tx, { ...base(), id: p.id, reason: 'Entered twice' }));
    expect(c.cancellationJournalIds.map((j) => lines(j))).toEqual(['1120:0.00/1200.00 ; 6200:1200.00/0.00']);
    await rejects(t((tx) => ye.cancelItem(tx, { ...base(), id: p.id, reason: 'Again' })), 'item_cancelled');
  });
});

describe('PROVISION_MOVEMENT and its reversal', () => {
  it('made, used and released post their pairs; never below zero, in date order, never against a control account', async () => {
    provision = (await t((tx) => ye.createProvision(tx, { ...base(), name: 'Dilapidations', accountId: acc['2160']!, expenseAccountId: acc['6700']!, basis: 'Surveyor estimate (synthetic)', evidenceDocumentIds: [] }))).id;
    const mk = (kind: 'MADE' | 'USED' | 'RELEASED', date: string, amount: string, offset?: string) => t((tx) => ye.addMovement(tx, { ...base(), provisionId: provision, kind, date, amount, ...(offset ? { offsetAccountId: acc[offset] } : {}), reason: `Synthetic ${kind}` }));
    const p = await mk('MADE', '2027-06-30', '500.00');
    expect(lines(p.movements[0]!.journalId)).toBe('6700:500.00/0.00 ; 2160:0.00/500.00');
    const u = await mk('USED', '2027-07-31', '200.00', '6700');
    expect(lines(u.movements[1]!.journalId)).toBe('2160:200.00/0.00 ; 6700:0.00/200.00');
    await rejects(mk('RELEASED', '2027-08-31', '300.01'), 'provision_exceeded');
    await rejects(mk('MADE', '2027-07-01', '1.00'), 'invalid_date');
    await rejects(mk('USED', '2027-08-31', '1.00', '1200'), 'control_account_restricted');
    const r = await mk('RELEASED', '2027-08-31', '100.00');
    expect(r.balance).toBe('200.00');
    expect(lines(r.movements[2]!.journalId)).toBe('2160:100.00/0.00 ; 6700:0.00/100.00');
    expect(() => sql(`UPDATE provision SET basis='x' WHERE id='${provision}'`)).toThrow(/append-only/);
  });
  it('PROVISION_MOVEMENT_REVERSAL mirrors the latest live movement only, once', async () => {
    const p = await t((tx) => ye.getProvision(tx, co, provision));
    await rejects(t((tx) => ye.reverseMovement(tx, { ...base(), id: p.movements[0]!.id, reason: 'Not the latest' })), 'not_latest_movement');
    const r = await t((tx) => ye.reverseMovement(tx, { ...base(), id: p.movements[2]!.id, reason: 'Released in error' }));
    expect(r.balance).toBe('300.00');
    expect(lines(r.movements[2]!.reversalJournalId!)).toBe('2160:0.00/100.00 ; 6700:100.00/0.00');
    await rejects(t((tx) => ye.reverseMovement(tx, { ...base(), id: p.movements[2]!.id, reason: 'Again' })), 'movement_reversed');
  });
});

describe('no VAT and closed periods', () => {
  it('a year-end source refuses a VAT code (none of them carries VAT)', async () => {
    const before = journals();
    for (const s of ['ACCRUAL', 'ACCRUAL_AUTO_REVERSAL', 'ACCRUAL_CANCELLATION', 'ADJUSTMENT_SETUP', 'ADJUSTMENT_SETUP_REVERSAL', 'ADJUSTMENT_RELEASE', 'ADJUSTMENT_RELEASE_REVERSAL', 'PROVISION_MOVEMENT', 'PROVISION_MOVEMENT_REVERSAL']) {
      const id = uuidv7();
      await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2027-06-01', sourceType: s, sourceId: id, description: `VAT on ${s}`, idempotencyKey: `vat-${id}`, actor: me(),
        lines: [{ accountId: acc['6110']!, debit: '10.00', credit: '0' }, { accountId: acc['2110']!, debit: '0', credit: '10.00', taxCodeId: uuidv7() }] })), 'vat_not_applicable');
    }
    expect(journals()).toBe(before);
  });
  it('after 2026 is closed, every year-end posting dated in it is refused: accruals and their reversals and cancellations, set-ups and their cancellations, provision movements and their reversals; nothing is written', async () => {
    const acc26 = await accrual('2026-03-31');
    const unreleased = await prepayment('2026-05-01', '2026-11-01', '2027-10-31');
    const prov = await t((tx) => ye.createProvision(tx, { ...base(), name: 'Closed-year provision', accountId: acc['2160']!, expenseAccountId: acc['6700']!, basis: 'Synthetic basis', evidenceDocumentIds: [] }));
    const made = await t((tx) => ye.addMovement(tx, { ...base(), provisionId: prov.id, kind: 'MADE', date: '2026-06-30', amount: '50.00', reason: 'Synthetic made' }));
    await t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: co, periodId: period('2026-01-01'), action: 'close', userId: user, can: all, acknowledgeDraftDocuments: true, acknowledgeUnreconciledBank: true }));
    const before = journals();
    await rejects(accrual('2026-09-30'), 'period_closed');                                  // ACCRUAL
    await rejects(accrual('2025-12-31'), 'period_closed');                                  // its ACCRUAL_AUTO_REVERSAL would land on 1.1.2026
    await rejects(t((tx) => ye.cancelItem(tx, { ...base(), id: acc26.id, reason: 'Back-dated' })), 'period_closed');      // ACCRUAL_CANCELLATION
    await rejects(prepayment('2026-12-01', '2026-12-01', '2027-11-30'), 'period_closed');   // ADJUSTMENT_SETUP
    await rejects(t((tx) => ye.cancelItem(tx, { ...base(), id: unreleased.id, reason: 'Back-dated' })), 'period_closed'); // ADJUSTMENT_SETUP_REVERSAL
    // release runs and their reversals: see the next test (this company already has later runs)
    await rejects(t((tx) => ye.addMovement(tx, { ...base(), provisionId: prov.id, kind: 'MADE', date: '2026-12-31', amount: '5.00', reason: 'Back-dated' })), 'period_closed'); // PROVISION_MOVEMENT
    await rejects(t((tx) => ye.reverseMovement(tx, { ...base(), id: made.movements[0]!.id, reason: 'Back-dated' })), 'period_closed');  // PROVISION_MOVEMENT_REVERSAL
    expect(journals()).toBe(before);
    expect(sql(`SELECT count(*) FROM year_end_item WHERE description LIKE 'Synthetic accrual 2026-09-30%' OR description LIKE 'Synthetic accrual 2025-12-31%'`)).toBe('0');
  });
  it('a release run and its reversal dated in a closed period are refused (a company with no later runs)', async () => {
    const co2 = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','YE Lock Co') RETURNING id`).split('\n')[0]!;
    for (const y of [2026, 2027]) sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co2}','${y}-01-01','${y}-12-31')`);
    const a2: Record<string, string> = {};
    for (const a of (await t((tx) => new AccountService().initialiseDefault(tx, { organisationId: org, companyId: co2, userId: user }))).items) a2[a.code] = a.id;
    const b2 = { organisationId: org, companyId: co2, actor: me() };
    await t((tx) => ye.createItem(tx, { ...b2, kind: 'PREPAYMENT', date: '2026-01-01', description: 'Lock prepayment', amount: '1200.00', plAccountId: a2['6200']!, balanceAccountId: a2['1120']!, periodStart: '2026-01-01', periodEnd: '2026-12-31', convention: 'MONTHLY', setup: { kind: 'POSTED' }, evidenceDocumentIds: [] }));
    const r = await t((tx) => ye.postRun(tx, { ...b2, asAt: '2026-06-30' }));
    await t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: co2, periodId: sql(`SELECT id FROM accounting_period WHERE company_id='${co2}' AND start_date='2026-01-01'`), action: 'close', userId: user, can: all, acknowledgeDraftDocuments: true, acknowledgeUnreconciledBank: true }));
    await rejects(t((tx) => ye.postRun(tx, { ...b2, asAt: '2026-12-31' })), 'period_closed');      // ADJUSTMENT_RELEASE
    await rejects(t((tx) => ye.reverseRun(tx, { ...b2, id: r.id, reason: 'Back-dated' })), 'period_closed');  // ADJUSTMENT_RELEASE_REVERSAL
  });
});
