import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, FxSettingsService, PostingService, RateService, SalesService, type SalesActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M5b through the services: receipts (Dr bank / Cr receivables), allocation at entry and later, part payments, overpayments as unallocated credit,
 * realised FX on every allocation, duplicate check, reversal of unallocated receipts, the customer statement and aged receivables.
 * ALL RATES ARE SYNTHETIC (EUR at 0.85 / 0.90 / 0.80).
 */
let db: Database;
let org: string, user: string, co: string, coE: string;
const acc: Record<string, Record<string, string>> = {};
const sales = new SalesService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const me = (deny: string[] = []): SalesActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string, status?: number) => expect(p).rejects.toMatchObject({ code: c, ...(status ? { status } : {}) });
const linesOf = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit, ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);
function customer(company: string, name: string) {
  const c = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','${name}','${user}') RETURNING id`).split('\n')[0]!;
  const r = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, account_code, created_by_user_id) VALUES ('${org}','${company}','${c}','CUSTOMER','${name.slice(0, 8).replace(/\W/g, '')}','${user}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO customer_profile(role_id, organisation_id, company_id, payment_terms_days) VALUES ('${r}','${org}','${company}',30)`);
  return r;
}
const invoice = async (company: string, role: string, amount: string, issueDate: string, currency?: string) => {
  const d = await t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: company, actor: me(), customerRoleId: role, issueDate, amountsIncludeVat: false, ...(currency ? { currency } : {}),
    lines: [{ description: 'Synthetic goods', quantity: '1', unitPrice: amount, accountId: acc[company]!['4000']! }] }));
  return t((tx) => sales.approve(tx, { organisationId: org, companyId: company, actor: me(), id: d.id, duplicateOverrideReason: 'Synthetic test invoices may repeat' }));
};
const receive = (company: string, role: string, amount: string, receiptDate: string, o: { allocations?: { invoiceId: string; amount: string }[]; currency?: string; reference?: string; bank?: string; duplicateOverrideReason?: string; actor?: SalesActor } = {}) =>
  t((tx) => sales.recordReceipt(tx, { organisationId: org, companyId: company, actor: o.actor ?? me(), customerRoleId: role, receiptDate, amount, bankAccountId: acc[company]![o.bank ?? '1200']!,
    allocations: o.allocations ?? [], ...(o.currency ? { currency: o.currency } : {}), ...(o.reference ? { reference: o.reference } : {}), ...(o.duplicateOverrideReason ? { duplicateOverrideReason: o.duplicateOverrideReason } : {}) }));
const doc = (company: string, id: string) => t((tx) => sales.get(tx, company, id));

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('rcp-${org}@t.test','R') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Receipts')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Receipts Co') RETURNING id`).split('\n')[0]!;
  coE = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Receipts EUR Co') RETURNING id`).split('\n')[0]!;
  const accounts = new AccountService();
  for (const c of [co, coE]) {
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','2026-01-01','2026-12-31')`);
    acc[c] = {};
    for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: user }))).items) acc[c]![a.code] = a.id;
    for (const [code, name] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) {
      acc[c]![code] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: user, input: { code, name, type: 'EXPENSE', subtype: 'OTHER_EXPENSE', isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: 'PL.OTHER_EXPENSES', activeFrom: null, activeTo: null } }))).id;
    }
    await t((tx) => new FxSettingsService().set(tx, { organisationId: org, companyId: c, actor: { ...me(), kind: 'USER' }, roundingAccountId: acc[c]!['7900']!, realisedAccountId: acc[c]!['7910']!, unrealisedAccountId: acc[c]!['7920']!, defaultSeries: {}, reason: 'FX accounts for the receipt tests' }));
    await t((tx) => sales.setSettings(tx, { organisationId: org, companyId: c, actor: me(), receivablesAccountId: acc[c]!['1100']!, invoicePrefix: 'INV-', creditNotePrefix: 'CN-', invoiceStart: 1, creditNoteStart: 1, requireSeparateApprover: false, reason: 'Sales settings for the receipt tests' }));
  }
  for (const [date, rate] of [['2026-03-02', '0.85'], ['2026-04-01', '0.90'], ['2026-05-04', '0.80']] as const) {
    await t((tx) => new RateService().create(tx, { organisationId: org, companyId: coE, actor: me(), fromCurrency: 'EUR', kind: 'DAILY', validFrom: date, rate, source: 'synthetic test rate' }));
  }
});
afterAll(() => db.close());

describe('receipts and allocation (V1-MOD-08, V1-EX-03)', () => {
  let cust: string, a: Awaited<ReturnType<typeof invoice>>, b: Awaited<ReturnType<typeof invoice>>, r: Awaited<ReturnType<typeof receive>>;
  it('a receipt posts Dr bank / Cr receivables; allocated at entry in full and in part; the overpayment stays unallocated credit', async () => {
    cust = customer(co, 'Paying Customer Ltd');
    a = await invoice(co, cust, '100.00', '2026-02-01');
    b = await invoice(co, cust, '250.00', '2026-02-10');
    r = await receive(co, cust, '400.00', '2026-02-20', { reference: 'BACS 0001', allocations: [{ invoiceId: a.id, amount: '100.00' }, { invoiceId: b.id, amount: '200.00' }] });
    expect(r).toMatchObject({ amount: '400.00', unallocated: '100.00', status: 'POSTED', functional: { amount: '400.00', unallocated: '100.00' }, allocations: [{ invoiceId: a.id, amount: '100.0000' }, { invoiceId: b.id, amount: '200.0000' }] });
    expect(linesOf(r.journalId)).toBe('1200:400.0000/0.0000 ; 1100:0.0000/400.0000');
    expect(sql(`SELECT source_type||'|'||source_id FROM journal WHERE id='${r.journalId}'`)).toBe(`SALES_RECEIPT|${r.id}`);
    expect(await doc(co, a.id)).toMatchObject({ paymentStatus: 'PAID', outstanding: '0.00' });
    expect(await doc(co, b.id)).toMatchObject({ paymentStatus: 'PART_PAID', outstanding: '50.00' });
    expect((await t((tx) => sales.openBalance(tx, co, cust))).toFixed(2)).toBe('-50.00'); // 50 owed less 100 unallocated credit
    expect(sql(`SELECT payload->>'allocated' FROM outbox_event WHERE event_type='sales_receipt.recorded' AND aggregate_id='${r.id}'`)).toBe('300.00');
  });
  it('unallocated credit is allocated later; allocations cannot exceed either side, cross customers or precede the documents', async () => {
    await rejects(t((tx) => sales.allocateReceipt(tx, { organisationId: org, companyId: co, actor: me(), receiptId: r.id, allocations: [{ invoiceId: b.id, amount: '60.00' }] })), 'allocation_exceeds_outstanding');
    const other = await invoice(co, customer(co, 'Someone Else Ltd'), '10.00', '2026-02-11');
    await rejects(t((tx) => sales.allocateReceipt(tx, { organisationId: org, companyId: co, actor: me(), receiptId: r.id, allocations: [{ invoiceId: other.id, amount: '5.00' }] })), 'allocation_mismatch');
    await rejects(t((tx) => sales.allocateReceipt(tx, { organisationId: org, companyId: co, actor: me(), receiptId: r.id, allocations: [{ invoiceId: b.id, amount: '50.00' }], date: '2026-02-15' })), 'invalid_date');
    const after = await t((tx) => sales.allocateReceipt(tx, { organisationId: org, companyId: co, actor: me(), receiptId: r.id, allocations: [{ invoiceId: b.id, amount: '50.00' }], date: '2026-03-01' }));
    expect(after).toMatchObject({ unallocated: '50.00', allocations: [{}, {}, { invoiceId: b.id, amount: '50.0000', allocatedOn: '2026-03-01' }] });
    expect(await doc(co, b.id)).toMatchObject({ paymentStatus: 'PAID', outstanding: '0.00' });
  });
  it('an allocated receipt cannot be reversed; an unallocated one is reversed with a mirror journal and is then final', async () => {
    await rejects(t((tx) => sales.reverseReceipt(tx, { organisationId: org, companyId: co, actor: me(), id: r.id, reason: 'Entered against the wrong customer' })), 'receipt_allocated', 409);
    const lone = await receive(co, cust, '75.00', '2026-03-05', { reference: 'CHQ 77', bank: '1220' });
    expect(linesOf(lone.journalId)).toBe('1220:75.0000/0.0000 ; 1100:0.0000/75.0000');
    const rev = await t((tx) => sales.reverseReceipt(tx, { organisationId: org, companyId: co, actor: me(), id: lone.id, reason: 'Cheque returned unpaid' }));
    expect(rev).toMatchObject({ status: 'REVERSED', reversedReason: 'Cheque returned unpaid' });
    expect(linesOf(rev.reversalJournalId!)).toBe('1100:75.0000/0.0000 ; 1220:0.0000/75.0000');
    await rejects(t((tx) => sales.reverseReceipt(tx, { organisationId: org, companyId: co, actor: me(), id: lone.id, reason: 'again' })), 'receipt_reversed', 409);
    await rejects(t((tx) => sales.allocateReceipt(tx, { organisationId: org, companyId: co, actor: me(), receiptId: lone.id, allocations: [{ invoiceId: b.id, amount: '1.00' }] })), 'receipt_reversed');
    await rejects(t((tx) => new PostingService().reverse(tx, { organisationId: org, companyId: co, journalId: r.journalId, reason: 'Trying the ledger route', actor: { kind: 'USER', userId: user, can: async () => true } })), 'subledger_journal');
  });
  it('a possible duplicate receipt needs a reason; the bank account must be a bank or cash account; recording needs sales:approve', async () => {
    await rejects(receive(co, cust, '400.00', '2026-02-20'), 'possible_duplicate', 409);
    await rejects(receive(co, cust, '1.00', '2026-03-09', { reference: 'BACS 0001' }), 'possible_duplicate', 409);
    const ok = await receive(co, cust, '400.00', '2026-02-20', { duplicateOverrideReason: 'Two identical transfers confirmed on the bank statement' });
    expect(ok.duplicateOverrideReason).toBe('Two identical transfers confirmed on the bank statement');
    await rejects(receive(co, cust, '5.00', '2026-03-10', { bank: '4000' }), 'not_a_bank_account');
    await rejects(receive(co, cust, '5.00', '2026-03-10', { bank: '1100' }), 'not_a_bank_account');
    await rejects(receive(co, cust, '5.00', '2026-03-10', { actor: me(['sales:approve']) }), 'permission_denied', 403);
    await rejects(receive(co, cust, '5.00', '2027-03-10'), 'no_period');
    await rejects(receive(co, cust, '5.001', '2026-03-10'), 'invalid_amount');
  });
  it('the receivables reconcile with receipts, reversals and unallocated credit', async () => {
    const rec = await t((tx) => sales.reconciliation(tx, co));
    expect(rec.reconciled).toBe(true);
    expect(rec.currencies[0]).toMatchObject({ currency: 'GBP', difference: '0.00', differenceFunctional: '0.00' });
  });
});

describe('realised FX on receipts (V1-FX-07, DEC-030)', () => {
  it('an EUR invoice settled by two receipts at different rates realises a gain then a loss that net to cash received less carried', async () => {
    const cust = customer(coE, 'Euro Payer SA');
    const inv = await invoice(coE, cust, '1000.00', '2026-03-02', 'EUR');
    expect(inv.functional).toMatchObject({ gross: '850.00' });
    // 600 at 0.90 = 540.00 received; the invoice releases 850 x 600/1000 = 510.00: a gain of 30.00
    const r1 = await receive(coE, cust, '600.00', '2026-04-01', { currency: 'EUR', allocations: [{ invoiceId: inv.id, amount: '600.00' }] });
    expect(r1).toMatchObject({ functional: { amount: '540.00', unallocated: '0.00' }, rate: '0.90000000', allocations: [{ invoiceFunctional: '510.00', creditFunctional: '540.00', realisedFx: '30.00' }] });
    expect(linesOf(r1.allocations[0]!.fxJournalId!)).toBe('7910:0.0000/30.0000 ; 1100:30.0000/0.0000');
    // 400 at 0.80 = 320.00 received; the invoice releases what is left, 340.00: a loss of 20.00 and no residue
    const r2 = await receive(coE, cust, '400.00', '2026-05-04', { currency: 'EUR', allocations: [{ invoiceId: inv.id, amount: '400.00' }] });
    expect(r2.allocations[0]).toMatchObject({ invoiceFunctional: '340.00', creditFunctional: '320.00', realisedFx: '-20.00' });
    expect(linesOf(r2.allocations[0]!.fxJournalId!)).toBe('7910:20.0000/0.0000 ; 1100:0.0000/20.0000');
    expect(await doc(coE, inv.id)).toMatchObject({ paymentStatus: 'PAID', outstanding: '0.00', functional: { outstanding: '0.00' } });
    // 540 + 320 received against 850 carried = 10.00 net gain
    expect(sql(`SELECT sum(l.credit - l.debit) FROM journal_line l JOIN journal j ON j.id=l.journal_id WHERE l.account_id='${acc[coE]!['7910']}' AND j.source_type='SALES_ALLOCATION_FX'`)).toBe('10.0000');
    expect(await t((tx) => sales.reconciliation(tx, coE))).toMatchObject({ reconciled: true, currencies: [{ currency: 'EUR', openItems: '0.00', control: { total: '0.00', totalFunctional: '0.00' } }] });
  });
  it('an unallocated foreign receipt is reversed at its own rate', async () => {
    const cust = customer(coE, 'Euro Refund SA');
    const r = await receive(coE, cust, '100.00', '2026-04-01', { currency: 'EUR' });
    const rev = await t((tx) => sales.reverseReceipt(tx, { organisationId: org, companyId: coE, actor: me(), id: r.id, reason: 'Paid into the wrong company', date: '2026-05-04' }));
    expect(linesOf(rev.reversalJournalId!)).toBe('1100:90.0000/0.0000 ; 1200:0.0000/90.0000'); // 0.90, not the 0.80 of the reversal date
  });
});

describe('customer statement and aged receivables', () => {
  it('the statement shows the opening balance, each item in date order and a running balance', async () => {
    const cust = customer(co, 'Statement Customer Ltd');
    await invoice(co, cust, '100.00', '2026-02-01');
    await invoice(co, cust, '250.00', '2026-02-10');
    await receive(co, cust, '400.00', '2026-02-20', { reference: 'STMT-1' });
    const st = await t((tx) => sales.statement(tx, co, cust, { from: '2026-02-05', to: '2026-02-28' }));
    expect(st.customer).toMatchObject({ name: 'Statement Customer Ltd' });
    expect(st.currencies).toEqual([expect.objectContaining({ currency: 'GBP', opening: '100.00', closing: '-50.00' })]);
    expect(st.currencies[0]!.lines.map((l) => `${l.date} ${l.type} ${l.debit}/${l.credit} = ${l.balance}`)).toEqual(['2026-02-10 INVOICE 250.00/0.00 = 350.00', '2026-02-20 RECEIPT 0.00/400.00 = -50.00']);
  });
  it('ageing as at a date uses only what existed then: buckets by days past due, unallocated credit apart', async () => {
    const cust = customer(co, 'Ageing Customer Ltd');
    const x = await invoice(co, cust, '300.00', '2026-01-01');                 // due 31 Jan
    await invoice(co, cust, '120.00', '2026-03-01');                           // due 31 Mar
    const r = await receive(co, cust, '100.00', '2026-03-10', { reference: 'AGE-1' });
    const at = (asOf: string) => t((tx) => sales.agedReceivables(tx, co, { asOf, customerRoleId: cust }));
    expect((await at('2026-02-15')).customers).toEqual([expect.objectContaining({ days1to30: '300.00', total: '300.00' })]);
    expect((await at('2026-04-15')).customers).toEqual([expect.objectContaining({ notDue: '0.00', days1to30: '120.00', days61to90: '300.00', unallocatedCredits: '-100.00', total: '320.00' })]);
    await t((tx) => sales.allocateReceipt(tx, { organisationId: org, companyId: co, actor: me(), receiptId: r.id, allocations: [{ invoiceId: x.id, amount: '100.00' }], date: '2026-04-20' }));
    expect((await at('2026-04-15')).customers[0]).toMatchObject({ days61to90: '300.00', unallocatedCredits: '-100.00' }); // the later allocation does not rewrite the past
    expect((await at('2026-04-30')).customers[0]).toMatchObject({ days61to90: '200.00', days1to30: '120.00', unallocatedCredits: '0.00', total: '320.00' });
  });
});
