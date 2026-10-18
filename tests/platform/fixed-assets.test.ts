import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, DepreciationService, FixedAssetService, PeriodService, PostingService, type PostingActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V2-M2 through the services: the five posting-rule categories of the six FIXED_ASSET_* journal sources (DEC-047, DEC-058): positive, negative,
 * the mirror reversal, no VAT, and a closed period. Every figure by hand on a 1,200.00 straight-line asset over 12 months (100.00 a month).
 */
let db: Database;
let org: string, user: string, co: string, office: string;
const acc: Record<string, string> = {};
const posting = new PostingService();
const assets = new FixedAssetService(posting);
const runs = new DepreciationService(posting);
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const all = async () => true;
const me = (deny: string[] = []): PostingActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const base = (actor = me()) => ({ organisationId: org, companyId: co, actor });
const rejects = (p: Promise<unknown>, c: string) => expect(p).rejects.toMatchObject({ code: c });
const lines = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit::numeric(19,2)||'/'||l.credit::numeric(19,2), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);
const journals = () => sql(`SELECT count(*) FROM journal WHERE company_id='${co}'`);
const add = (o: { description?: string; acquiredOn?: string; cost?: string; offset?: string } = {}) =>
  t((tx) => assets.addAsset(tx, { ...base(), classId: office, description: o.description ?? 'Synthetic desk', acquiredOn: o.acquiredOn ?? '2026-01-01', cost: o.cost ?? '1200.00',
    addition: { kind: 'POSTED', offsetAccountId: acc[o.offset ?? '2230']! }, tax: { category: 'UNDECIDED' } }));
const period = (start: string) => sql(`SELECT id FROM accounting_period WHERE company_id='${co}' AND start_date='${start}'`);

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('fa-${org}@t.test','FA') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Assets')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Assets Co') RETURNING id`).split('\n')[0]!;
  for (const [s, e] of [['2026-01-01', '2026-12-31'], ['2027-01-01', '2027-12-31']]) sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${co}','${s}','${e}')`);
  const accounts = new AccountService();
  for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: co, userId: user }))).items) acc[a.code] = a.id;
  acc['6950'] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: co, userId: user, input: { code: '6950', name: 'Disposals', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: 'PL.OTHER_EXPENSES', activeFrom: null, activeTo: null } }))).id;
  office = (await t((tx) => assets.createClass(tx, { ...base(), code: 'OFFICE', name: 'Office', costAccountId: acc['0030']!, depreciationAccountId: acc['0031']!, expenseAccountId: acc['6900']!, disposalAccountId: acc['6950']!,
    method: 'STRAIGHT_LINE', lifeMonths: 12, residualPercent: '0', convention: 'MONTHLY' }))).id;
});
afterAll(() => db.close());

describe('FIXED_ASSET_ADDITION and its reversal', () => {
  it('posts Dr cost / Cr the offset account, and the asset is numbered in the register', async () => {
    const a = await add();
    expect(lines(a.additionJournalId!)).toBe('0030:1200.00/0.00 ; 2230:0.00/1200.00');
    expect(sql(`SELECT source_type||':'||source_id FROM journal WHERE id='${a.additionJournalId}'`)).toBe(`FIXED_ASSET_ADDITION:${a.id}`);
    expect(a).toMatchObject({ number: 1, status: 'ACTIVE', carryingAmount: '1200.00' });
  });
  it('refuses a control offset, a class account as offset, a person without assets:manage and an AI actor; nothing is written', async () => {
    const before = journals();
    await rejects(add({ offset: '1200' }), 'control_account_restricted');
    await rejects(add({ offset: '0031' }), 'invalid_offset_account');
    await rejects(t((tx) => assets.addAsset(tx, { ...base(me(['assets:manage'])), classId: office, description: 'x', acquiredOn: '2026-01-01', cost: '1.00', addition: { kind: 'POSTED', offsetAccountId: acc['2230']! }, tax: { category: 'UNDECIDED' } })), 'permission_denied');
    await rejects(t((tx) => assets.addAsset(tx, { ...base({ ...me(), kind: 'AI' }), classId: office, description: 'x', acquiredOn: '2026-01-01', cost: '1.00', addition: { kind: 'POSTED', offsetAccountId: acc['2230']! }, tax: { category: 'UNDECIDED' } })), 'ai_cannot_post');
    expect(journals()).toBe(before);
  });
  it('FIXED_ASSET_ADDITION_REVERSAL mirrors the addition and voids the asset; a second reversal and a depreciated asset are refused', async () => {
    const a = await add({ description: 'Entered twice' });
    const v = await t((tx) => assets.reverseAddition(tx, { ...base(), id: a.id, reason: 'Entered twice' }));
    expect(v.status).toBe('VOID');
    expect(lines(v.additionReversalJournalId!)).toBe('0030:0.00/1200.00 ; 2230:1200.00/0.00');
    await rejects(t((tx) => assets.reverseAddition(tx, { ...base(), id: a.id, reason: 'Again' })), 'asset_not_active');
    expect(() => sql(`UPDATE fixed_asset SET status='ACTIVE' WHERE id='${a.id}'`)).toThrow(/void asset is final/);
  });
});

describe('FIXED_ASSET_DEPRECIATION and its reversal', () => {
  let runId: string;
  it('posts one pair of lines per class and one line per asset; a run that charges nothing is refused', async () => {
    const r = await t((tx) => runs.post(tx, { ...base(), asAt: '2026-03-31' }));
    runId = r.id;
    expect(r).toMatchObject({ total: '300.00', status: 'POSTED', lines: [expect.objectContaining({ number: 1, amount: '300.00', accumulatedAfter: '300.00' })] });
    expect(lines(r.journalId!)).toBe('6900:300.00/0.00 ; 0031:0.00/300.00');
    await rejects(t((tx) => runs.post(tx, { ...base(), asAt: '2026-04-15' })), 'nothing_to_depreciate');
    await rejects(t((tx) => runs.post(tx, { ...base(), asAt: '2026-03-31' })), 'run_not_later');
    await rejects(t((tx) => runs.post(tx, { ...base(me(['assets:manage'])), asAt: '2026-04-30' })), 'permission_denied');
  });
  it('FIXED_ASSET_DEPRECIATION_REVERSAL mirrors the latest live run only; a reversed run cannot be reversed again; the ledger cannot reverse it directly', async () => {
    const r2 = await t((tx) => runs.post(tx, { ...base(), asAt: '2026-04-30' }));
    await rejects(t((tx) => runs.reverse(tx, { ...base(), id: runId, reason: 'Not the latest' })), 'not_latest_run');
    const rev = await t((tx) => runs.reverse(tx, { ...base(), id: r2.id, reason: 'Re-run' }));
    expect(lines(rev.reversalJournalId!)).toBe('6900:0.00/100.00 ; 0031:100.00/0.00');
    await rejects(t((tx) => runs.reverse(tx, { ...base(), id: r2.id, reason: 'Again' })), 'run_reversed');
    await rejects(t((tx) => posting.reverse(tx, { organisationId: org, companyId: co, journalId: r2.journalId!, reason: 'Bypass', actor: me() })), 'subledger_journal');
    expect(() => sql(`UPDATE depreciation_run SET total = 1 WHERE id='${runId}'`)).toThrow(/never edited/);
  });
});

describe('FIXED_ASSET_DISPOSAL and its reversal', () => {
  it('posts the catch-up, removes cost and depreciation, and puts the carrying amount and proceeds on the disposal account; refuses a second disposal and a date before use', async () => {
    const a = await add({ description: 'Chair', acquiredOn: '2026-02-01' });
    await rejects(t((tx) => assets.dispose(tx, { ...base(), id: a.id, disposedOn: '2026-01-15', proceeds: '0', reason: 'Too early' })), 'invalid_date');
    const d = await t((tx) => assets.dispose(tx, { ...base(), id: a.id, disposedOn: '2026-05-20', proceeds: '1000.00', proceedsAccountId: acc['1110'], reason: 'Sold' }));
    // monthly convention, no charge in the disposal month: Feb, Mar, Apr = 3 x 100.00; the chair came after the 31.3 run, so all of it is catch-up
    expect(d).toMatchObject({ status: 'DISPOSED', disposalCatchUp: '300.00', accumulatedDepreciation: '300.00', carryingAmount: '900.00', gainOrLoss: '100.00' });
    expect(lines(d.disposalJournalId!)).toBe('6900:300.00/0.00 ; 0031:0.00/300.00 ; 0031:300.00/0.00 ; 6950:900.00/0.00 ; 0030:0.00/1200.00 ; 1110:1000.00/0.00 ; 6950:0.00/1000.00');
    await rejects(t((tx) => assets.dispose(tx, { ...base(), id: a.id, disposedOn: '2026-05-20', proceeds: '0', reason: 'Again' })), 'asset_not_active');
    expect(() => sql(`UPDATE fixed_asset SET proceeds = 1 WHERE id='${a.id}'`)).toThrow(/never edited/);
  });
  it('FIXED_ASSET_DISPOSAL_REVERSAL mirrors the disposal and restores the asset; refused once a later run is live', async () => {
    const a = (await t((tx) => assets.list(tx, co, { status: 'DISPOSED' }))).items[0]!;
    const back = await t((tx) => assets.reverseDisposal(tx, { ...base(), id: a.id, reason: 'Sale cancelled' }));
    expect(back).toMatchObject({ status: 'ACTIVE', accumulatedDepreciation: '0.00', carryingAmount: '1200.00' });
    expect(lines(sql(`SELECT id FROM journal WHERE source_type='FIXED_ASSET_DISPOSAL_REVERSAL' AND source_id='${a.id}'`))).toBe('6900:0.00/300.00 ; 0031:300.00/0.00 ; 0031:0.00/300.00 ; 6950:0.00/900.00 ; 0030:1200.00/0.00 ; 1110:0.00/1000.00 ; 6950:1000.00/0.00');
    await rejects(t((tx) => assets.reverseDisposal(tx, { ...base(), id: a.id, reason: 'Twice' })), 'asset_not_disposed');
    await t((tx) => assets.dispose(tx, { ...base(), id: a.id, disposedOn: '2026-05-20', proceeds: '0', reason: 'Scrapped' }));
    await t((tx) => runs.post(tx, { ...base(), asAt: '2026-05-31' }));
    await rejects(t((tx) => assets.reverseDisposal(tx, { ...base(), id: a.id, reason: 'Too late' })), 'later_run_exists');
  });
});

describe('no VAT and closed periods', () => {
  it('a register source refuses a VAT code (none of them carries VAT)', async () => {
    const before = journals();
    for (const s of ['FIXED_ASSET_ADDITION', 'FIXED_ASSET_ADDITION_REVERSAL', 'FIXED_ASSET_DEPRECIATION', 'FIXED_ASSET_DEPRECIATION_REVERSAL', 'FIXED_ASSET_DISPOSAL', 'FIXED_ASSET_DISPOSAL_REVERSAL']) {
      const id = uuidv7();
      await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2026-06-01', sourceType: s, sourceId: id, description: `VAT on ${s}`, idempotencyKey: `vat-${id}`, actor: me(),
        lines: [{ accountId: acc['0030']!, debit: '10.00', credit: '0' }, { accountId: acc['2230']!, debit: '0', credit: '10.00', taxCodeId: uuidv7() }] })), 'vat_not_applicable');
    }
    expect(journals()).toBe(before);
  });
  it('after 2026 is closed, every register posting dated in it is refused: additions, runs, disposals and the reversals of each; nothing is written', async () => {
    const live = await add({ description: 'Bought in 2026, kept' });
    const fresh = await add({ description: 'Bought in 2026, to reverse', acquiredOn: '2026-12-01' });
    const run = await t((tx) => runs.post(tx, { ...base(), asAt: '2026-06-30' }));
    const sold = (await t((tx) => assets.list(tx, co, { status: 'DISPOSED' }))).items[0]!;
    await t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: co, periodId: period('2026-01-01'), action: 'close', userId: user, can: all, acknowledgeDraftDocuments: true, acknowledgeUnreconciledBank: true }));
    const before = journals();
    await rejects(add({ description: 'Back-dated', acquiredOn: '2026-11-01' }), 'period_closed');
    await rejects(t((tx) => runs.post(tx, { ...base(), asAt: '2026-12-31' })), 'period_closed');
    await rejects(t((tx) => assets.dispose(tx, { ...base(), id: live.id, disposedOn: '2026-12-31', proceeds: '0', reason: 'Back-dated' })), 'period_closed');
    await rejects(t((tx) => assets.reverseAddition(tx, { ...base(), id: fresh.id, reason: 'Back-dated' })), 'period_closed');
    await rejects(t((tx) => runs.reverse(tx, { ...base(), id: run.id, reason: 'Back-dated' })), 'period_closed');
    // the May disposal was followed by later runs, which must be reversed first, and those reversals are refused in the closed period
    await rejects(t((tx) => assets.reverseDisposal(tx, { ...base(), id: sold.id, reason: 'Back-dated' })), 'later_run_exists');
    expect(journals()).toBe(before);
    expect(sql(`SELECT count(*) FROM fixed_asset WHERE description='Back-dated'`)).toBe('0');
    expect((await t((tx) => assets.get(tx, co, live.id))).status).toBe('ACTIVE');
  });
});
