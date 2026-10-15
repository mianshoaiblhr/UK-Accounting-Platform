import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, CashService, FxSettingsService, PostingService, SalesService, VatService, type CashActor, type CashLineInput } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M6c through the services: money in and out without a source document, VAT per line (output, input, exempt, zero, reverse charge), the overdrawn-bank
 * warning, the negative-cash refusal and its override (DEC-036, DEC-037) including a back-dated payment that overdraws a later day, the mirror reversal,
 * the VAT workpaper and the fences. Every figure is calculated by hand. ALL RATES ARE SYNTHETIC (12.5%).
 */
let db: Database;
let org: string, user: string, reviewer: string, co: string, coN: string;
const acc: Record<string, Record<string, string>> = {};
const code: Record<string, string> = {};
const cash = new CashService();
const vat = new VatService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const me = (deny: string[] = []): CashActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string, status?: number) => expect(p).rejects.toMatchObject({ code: c, ...(status ? { status } : {}) });
const src = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026, s.1 (test fixture, not a real rule)', retrievedOn: '2026-01-01' };
const linesOf = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit||':'||coalesce(l.vat_role,'-'), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);
const L = (account: string, amount: string, tax?: string, company = co): CashLineInput => ({ description: `Synthetic ${account}`, accountId: acc[company]![account]!, amount, ...(tax ? { taxCodeId: code[tax] } : {}) });
type Rec = Parameters<CashService['record']>[1];
const record = (o: Partial<Rec> & { direction: Rec['direction']; transactionDate: string; lines: CashLineInput[] }, company = co, bank = '1220') =>
  t((tx) => cash.record(tx, { organisationId: org, companyId: company, actor: me(), bankAccountId: acc[company]![bank]!, description: 'Synthetic cash transaction', amountsIncludeVat: false, ...o }));
const balance = (company: string, account: string) => sql(`SELECT coalesce(sum(debit - credit), 0) FROM journal_line WHERE company_id='${company}' AND account_id='${acc[company]![account]}'`);

async function defineCode(c: string, treatment: string, direction: string, rate: string, netBoxes: number[], vatBoxes: number[], reverseCharge = false) {
  const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: me(), code: c, name: `Synthetic ${c}`, treatment: treatment as never, direction: direction as never, reverseCharge }));
  code[c] = tc.id;
  const r = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: me(), taxCodeId: tc.id, rate, effectiveFrom: '2026-01-01', netBoxes, vatBoxes, source: src }));
  await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: { ...me(), userId: reviewer }, id: r.id, notes: 'Synthetic fixture checked against the test source' }));
}

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  const mk = (n: string) => sql(`INSERT INTO "user"(email, display_name) VALUES ('cash-${n}-${org}@t.test','${n}') RETURNING id`).split('\n')[0]!;
  user = mk('u'); reviewer = mk('r');
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Cash')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Cash Co') RETURNING id`).split('\n')[0]!;
  coN = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Cash Unregistered Co') RETURNING id`).split('\n')[0]!;
  const accounts = new AccountService();
  for (const c of [co, coN]) {
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','2026-01-01','2026-12-31')`);
    acc[c] = {};
    for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: user }))).items) acc[c]![a.code] = a.id;
    for (const [n, name] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) {
      acc[c]![n] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: user, input: { code: n, name, type: 'EXPENSE', subtype: 'OTHER_EXPENSE', isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: 'PL.OTHER_EXPENSES', activeFrom: null, activeTo: null } }))).id;
    }
    acc[c]!['1150'] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: user, input: { code: '1150', name: 'VAT recoverable', type: 'ASSET', subtype: 'CURRENT_ASSET_VAT', isControl: false, controlKind: null, taxTreatment: 'VAT_CONTROL', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS', activeFrom: null, activeTo: null } }))).id;
    await t((tx) => new FxSettingsService().set(tx, { organisationId: org, companyId: c, actor: me(), roundingAccountId: acc[c]!['7900']!, realisedAccountId: acc[c]!['7910']!, unrealisedAccountId: acc[c]!['7920']!, defaultSeries: {}, reason: 'FX accounts for the cash tests' }));
  }
  await defineCode('S', 'STANDARD', 'SALES', '12.5', [6], [1]);
  await defineCode('P', 'STANDARD', 'PURCHASES', '12.5', [7], [4]);
  await defineCode('RC', 'STANDARD', 'PURCHASES', '12.5', [7], [1, 4], true);
  await defineCode('Z', 'ZERO', 'BOTH', '0', [6, 7], []);
  await defineCode('E', 'EXEMPT', 'PURCHASES', '0', [7], []);
  await t((tx) => vat.setSettings(tx, { organisationId: org, companyId: co, actor: me(), registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', scheme: 'STANDARD',
    periodMonths: 3, anchorPeriodEnd: '2026-03-31', outputAccountId: acc[co]!['2200']!, inputAccountId: acc[co]!['1150']!, reason: 'Registered for VAT from 1 January (synthetic)' }));
});
afterAll(() => db.close());

describe('money in and out with VAT (V1-MOD-11)', () => {
  let t1: Awaited<ReturnType<typeof record>>, t2: Awaited<ReturnType<typeof record>>, t3: Awaited<ReturnType<typeof record>>;
  it('money in: Dr cash / Cr income / Cr output VAT, per line, exclusive amounts', async () => {
    // 200.00 standard: VAT 25.00; 30.00 zero rated: no VAT. Gross 255.00
    t1 = await record({ direction: 'RECEIPT', transactionDate: '2026-02-02', counterparty: 'Market stall takings', reference: 'TILL 1', lines: [L('4000', '200.00', 'S'), L('4100', '30.00', 'Z')] });
    expect(t1).toMatchObject({ direction: 'RECEIPT', net: '230.00', vat: '25.00', gross: '255.00', status: 'POSTED', balanceWarnings: [],
      lines: [{ lineNo: 1, amount: '200.00', net: '200.00', vat: '25.00', gross: '225.00' }, { lineNo: 2, amount: '30.00', net: '30.00', vat: '0.00', gross: '30.00' }] });
    expect(linesOf(t1.journalId)).toBe('1220:255.0000/0.0000:- ; 4000:0.0000/200.0000:NET ; 2200:0.0000/25.0000:VAT ; 4100:0.0000/30.0000:NET');
    expect(sql(`SELECT source_type FROM journal WHERE id='${t1.journalId}'`)).toBe('CASH_RECEIPT');
  });
  it('money out: Dr expense / Dr input VAT / Cr cash, VAT-inclusive amounts; exempt lines carry none', async () => {
    // 90.00 gross standard: VAT = 90 x 12.5/112.5 = 10.00, net 80.00; 15.00 exempt. Gross 105.00; cash 255.00 - 105.00 = 150.00
    t2 = await record({ direction: 'PAYMENT', transactionDate: '2026-02-05', counterparty: 'Stationery shop', amountsIncludeVat: true, lines: [L('6310', '90.00', 'P'), L('8000', '15.00', 'E')] });
    expect(t2).toMatchObject({ net: '95.00', vat: '10.00', gross: '105.00', lines: [{ amount: '90.00', net: '80.00', vat: '10.00' }, { amount: '15.00', net: '15.00', vat: '0.00' }] });
    expect(linesOf(t2.journalId)).toBe('1220:0.0000/105.0000:- ; 6310:80.0000/0.0000:NET ; 1150:10.0000/0.0000:VAT ; 8000:15.0000/0.0000:NET');
    expect(balance(co, '1220')).toBe('150.0000');
  });
  it('reverse charge from the bank: nothing added to what was paid, the pair is posted; an overdrawn bank is a warning, not a refusal', async () => {
    // 400.00 software from abroad: paid 400.00, RC output 50.00 / RC input 50.00. The bank held nothing: -400.00 on 6 February
    t3 = await record({ direction: 'PAYMENT', transactionDate: '2026-02-06', counterparty: 'Overseas software', lines: [L('6320', '400.00', 'RC')] }, co, '1200');
    expect(t3).toMatchObject({ net: '400.00', vat: '0.00', gross: '400.00', balanceWarnings: [{ accountCode: '1200', kind: 'BANK', lowestBalance: '-400.00', onDate: '2026-02-06', overridden: false }] });
    expect(linesOf(t3.journalId)).toBe('1200:0.0000/400.0000:- ; 6320:400.0000/0.0000:NET ; 2200:0.0000/50.0000:RC_OUTPUT ; 1150:50.0000/0.0000:RC_INPUT');
    expect(sql(`SELECT metadata->'balanceWarnings'->0->>'kind' FROM audit_event WHERE entity_id='${t3.id}' AND action='cash_transaction.recorded'`)).toBe('BANK');
  });
  it('the VAT workpaper takes each line on the side its direction fixes', async () => {
    // box 1: 25.00 + 50.00; box 4: 10.00 + 50.00; box 6: 200.00 + 30.00; box 7: 80.00 + 15.00 + 400.00
    const wp = await t((tx) => vat.workpaper(tx, co, { from: '2026-01-01', to: '2026-03-31' }));
    const box = (n: number) => wp.boxes.find((b) => b.box === n)!.amount;
    expect([box(1), box(3), box(4), box(5), box(6), box(7)]).toEqual(['75.00', '75.00', '60.00', '15.00', '230.00', '495.00']);
    expect(wp.reconciliation.difference).toBe('0.00');
  });

  it('cash in hand cannot go below zero without a reason, including a back-dated payment that overdraws a later day (DEC-036, DEC-037)', async () => {
    // on 3 February 255.00 - 200.00 = 55.00 is fine, but on 5 February 55.00 - 105.00 = -50.00
    await expect(record({ direction: 'PAYMENT', transactionDate: '2026-02-03', lines: [L('6400', '200.00')] }))
      .rejects.toMatchObject({ code: 'negative_cash', status: 422, details: { accountCode: '1220', lowestBalance: '-50.00', onDate: '2026-02-05' } });
    // 150.00 in the box; paying 200.00 on 10 February leaves -50.00
    await rejects(record({ direction: 'PAYMENT', transactionDate: '2026-02-10', lines: [L('6400', '200.00')] }), 'negative_cash', 422);
    const over = await record({ direction: 'PAYMENT', transactionDate: '2026-02-10', lines: [L('6400', '200.00')], negativeCashReason: 'Float topped up from the owner; the top-up is recorded next' });
    expect(over.balanceWarnings).toEqual([{ accountId: acc[co]!['1220'], accountCode: '1220', kind: 'CASH', lowestBalance: '-50.00', onDate: '2026-02-10', overridden: true }]);
    expect(sql(`SELECT negative_cash_reason FROM journal WHERE id='${over.journalId}'`)).toBe('Float topped up from the owner; the top-up is recorded next');
    expect(sql(`SELECT metadata->>'negativeCashOverride' FROM audit_event WHERE entity_id='${over.id}' AND action='cash_transaction.recorded'`)).toBe('true');
    expect(balance(co, '1220')).toBe('-50.0000');
    // money in is never refused, and brings the box back
    await record({ direction: 'RECEIPT', transactionDate: '2026-02-11', reference: 'TOP UP', lines: [L('4100', '80.00')] });
    expect(balance(co, '1220')).toBe('30.0000');
  });

  it('a reversal mirrors the posted journal line by line at the same VAT rate versions and tax point; once only; never through the ledger', async () => {
    await rejects(t((tx) => cash.reverse(tx, { organisationId: org, companyId: co, actor: me(), id: t2.id, reason: 'Entered twice', date: '2026-02-01' })), 'invalid_date');
    const r = await t((tx) => cash.reverse(tx, { organisationId: org, companyId: co, actor: me(), id: t2.id, reason: 'Entered twice', date: '2026-02-20' }));
    expect(r).toMatchObject({ status: 'REVERSED', reversedReason: 'Entered twice' });
    expect(linesOf(r.reversalJournalId!)).toBe('1220:105.0000/0.0000:- ; 6310:0.0000/80.0000:NET ; 1150:0.0000/10.0000:VAT ; 8000:0.0000/15.0000:NET');
    expect(sql(`SELECT string_agg(DISTINCT tax_point::text, ',') FROM journal_line WHERE journal_id='${r.reversalJournalId}' AND tax_point IS NOT NULL`)).toBe('2026-02-05');
    const wp = await t((tx) => vat.workpaper(tx, co, { from: '2026-01-01', to: '2026-03-31' }));
    expect([wp.boxes.find((b) => b.box === 4)!.amount, wp.boxes.find((b) => b.box === 7)!.amount]).toEqual(['50.00', '400.00']);
    await rejects(t((tx) => cash.reverse(tx, { organisationId: org, companyId: co, actor: me(), id: t2.id, reason: 'Again' })), 'cash_transaction_reversed', 409);
    await rejects(t((tx) => new PostingService().reverse(tx, { organisationId: org, companyId: co, journalId: t1.journalId, reason: 'Ledger route', actor: me() })), 'subledger_journal');
  });
  it('reversing money in that has since been spent takes the box below zero, so it needs a reason too', async () => {
    // box 30.00 + 105.00 (t2 reversed) = 135.00; reversing t1 (255.00) on 21 February leaves -120.00
    expect(balance(co, '1220')).toBe('135.0000');
    await rejects(t((tx) => cash.reverse(tx, { organisationId: org, companyId: co, actor: me(), id: t1.id, reason: 'Takings belonged to another company', date: '2026-02-21' })), 'negative_cash');
    const r = await t((tx) => cash.reverse(tx, { organisationId: org, companyId: co, actor: me(), id: t1.id, reason: 'Takings belonged to another company', date: '2026-02-21', negativeCashReason: 'The takings are being re-recorded in the right company' }));
    expect(r.balanceWarnings).toMatchObject([{ kind: 'CASH', lowestBalance: '-120.00', overridden: true }]);
  });
  it('lists by direction and status', async () => {
    const out = await t((tx) => cash.list(tx, co, { direction: 'PAYMENT', limit: 10 }));
    expect(out.items.map((x) => x.gross)).toEqual(['200.00', '400.00', '105.00']);
    expect((await t((tx) => cash.list(tx, co, { status: 'REVERSED', limit: 10 }))).items.map((x) => x.id).sort()).toEqual([t1.id, t2.id].sort());
  });
});

describe('fences', () => {
  it('lines go to non-control, non-bank, non-reserved accounts with a VAT code of the right direction', async () => {
    const pay = (lines: CashLineInput[], o: Partial<Rec> = {}) => record({ direction: 'PAYMENT', transactionDate: '2026-03-02', lines, ...o }, co, '1200');
    await rejects(pay([L('1210', '10.00')]), 'transfer_not_supported');
    await rejects(pay([L('2100', '10.00')]), 'control_account_restricted');
    await rejects(pay([L('1150', '10.00')]), 'system_account_restricted');
    await rejects(pay([L('7910', '10.00')]), 'system_account_restricted');
    await rejects(pay([L('6100', '10.00', 'S')]), 'tax_code_direction');
    await rejects(record({ direction: 'RECEIPT', transactionDate: '2026-03-02', lines: [L('4000', '10.00', 'P')] }), 'tax_code_direction');
    await rejects(record({ direction: 'RECEIPT', transactionDate: '2026-03-02', lines: [L('4000', '10.00', 'RC')] }), 'tax_code_direction');
    await rejects(pay([L('6100', '10.00', 'RC')], { amountsIncludeVat: true }), 'reverse_charge_inclusive_not_supported');
    await rejects(pay([L('6100', '10.00')], { taxPoint: '2026-03-01' }), 'vat_not_applicable');
    await rejects(pay([L('6100', '10.001')]), 'invalid_amount');
    await rejects(record({ direction: 'PAYMENT', transactionDate: '2026-03-02', lines: [L('6100', '10.00')] }, co, '6100'), 'not_a_bank_account');
    await rejects(pay([L('6100', '10.00')], { currency: 'EUR' }), 'foreign_currency_not_supported');
  });
  it('duplicates need a reason; people only, with cash:record; an unregistered company records without VAT codes only', async () => {
    const once = { direction: 'PAYMENT' as const, transactionDate: '2026-03-03', reference: 'PARKING 1', lines: [L('6410', '6.00')] };
    await record(once, co, '1200');
    await rejects(record(once, co, '1200'), 'possible_duplicate', 409);
    await rejects(record({ ...once, reference: 'PARKING 2' }, co, '1200'), 'possible_duplicate', 409);
    await record({ ...once, reference: 'PARKING 2', duplicateOverrideReason: 'Two parking tickets on the same day' }, co, '1200');
    await rejects(t((tx) => cash.record(tx, { organisationId: org, companyId: co, actor: me(['cash:record']), direction: 'PAYMENT', transactionDate: '2026-03-04', bankAccountId: acc[co]!['1200']!, description: 'x', amountsIncludeVat: false, lines: [L('6410', '1.00')] })), 'permission_denied', 403);
    await rejects(t((tx) => cash.record(tx, { organisationId: org, companyId: co, actor: { ...me(), kind: 'AI' } as CashActor, direction: 'PAYMENT', transactionDate: '2026-03-04', bankAccountId: acc[co]!['1200']!, description: 'x', amountsIncludeVat: false, lines: [L('6410', '1.00')] })), 'ai_cannot_post', 403);
    await rejects(record({ direction: 'RECEIPT', transactionDate: '2026-03-04', lines: [L('4000', '10.00', 'S', coN)] }, coN), 'not_vat_registered');
    const plain = await record({ direction: 'RECEIPT', transactionDate: '2026-03-04', lines: [L('4000', '10.00', undefined, coN)] }, coN);
    expect(linesOf(plain.journalId)).toBe('1220:10.0000/0.0000:- ; 4000:0.0000/10.0000:-');
  });
  it('a closed period refuses the posting; nothing is half-written', async () => {
    const before = sql(`SELECT count(*) FROM cash_transaction WHERE company_id='${coN}'`);
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date, status) VALUES ('${org}','${coN}','2025-01-01','2025-12-31','CLOSED')`);
    await rejects(record({ direction: 'RECEIPT', transactionDate: '2025-06-01', lines: [L('4000', '10.00', undefined, coN)] }, coN), 'period_closed');
    expect(sql(`SELECT count(*) FROM cash_transaction WHERE company_id='${coN}'`)).toBe(before);
  });
});

describe('the negative-cash control reaches every posting a person makes to cash in hand (DEC-037)', () => {
  it('a customer receipt into cash, reversed after the cash was spent, needs a reason', async () => {
    const sales = new SalesService();
    await t((tx) => sales.setSettings(tx, { organisationId: org, companyId: coN, actor: me(), receivablesAccountId: acc[coN]!['1100']!, invoicePrefix: 'INV-', creditNotePrefix: 'CN-', invoiceStart: 1, creditNoteStart: 1, requireSeparateApprover: false, reason: 'Sales settings for the cash tests' }));
    const c = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','Cash Customer','${user}') RETURNING id`).split('\n')[0]!;
    const role = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, created_by_user_id) VALUES ('${org}','${coN}','${c}','CUSTOMER','${user}') RETURNING id`).split('\n')[0]!;
    sql(`INSERT INTO customer_profile(role_id, organisation_id, company_id, payment_terms_days) VALUES ('${role}','${org}','${coN}',30)`);
    // the box holds 10.00; 40.00 received in cash, then 45.00 spent: 5.00 left
    const rc = await t((tx) => sales.recordReceipt(tx, { organisationId: org, companyId: coN, actor: me(), customerRoleId: role, receiptDate: '2026-04-01', amount: '40.00', bankAccountId: acc[coN]!['1220']!, allocations: [] }));
    await record({ direction: 'PAYMENT', transactionDate: '2026-04-02', lines: [L('6400', '45.00', undefined, coN)] }, coN);
    await rejects(t((tx) => sales.reverseReceipt(tx, { organisationId: org, companyId: coN, actor: me(), id: rc.id, reason: 'Cheque bounced' })), 'negative_cash');
    await t((tx) => sales.reverseReceipt(tx, { organisationId: org, companyId: coN, actor: me(), id: rc.id, reason: 'Cheque bounced', negativeCashReason: 'The bounced amount is being recovered from the customer' }));
    expect(balance(coN, '1220')).toBe('-35.0000');
  });
});
