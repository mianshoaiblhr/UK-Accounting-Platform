import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, FxSettingsService, PostingService, PurchasesService, RateService, type PurchaseActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M6b through the services: supplier payments (Dr payables / Cr bank), allocation at entry and later, prepayments, realised FX on every allocation,
 * the duplicate check, the flag for unverified stored bank details (DEC-035), reversal of unallocated payments, the supplier statement and aged payables.
 * ALL RATES ARE SYNTHETIC (EUR at 0.85 / 0.90 / 0.80).
 */
let db: Database;
let org: string, user: string, co: string, coE: string;
const acc: Record<string, Record<string, string>> = {};
const purchases = new PurchasesService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const me = (deny: string[] = []): PurchaseActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string, status?: number) => expect(p).rejects.toMatchObject({ code: c, ...(status ? { status } : {}) });
const linesOf = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit, ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);
function supplier(company: string, name: string) {
  const c = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','${name}','${user}') RETURNING id`).split('\n')[0]!;
  const r = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, created_by_user_id) VALUES ('${org}','${company}','${c}','SUPPLIER','${user}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO supplier_profile(role_id, organisation_id, company_id, payment_terms_days, default_expense_account_id) VALUES ('${r}','${org}','${company}',30,'${acc[company]!['6100']}')`);
  return r;
}
let refSeq = 0;
const bill = async (company: string, role: string, amount: string, issueDate: string, currency?: string) => {
  const d = await t((tx) => purchases.createBill(tx, { organisationId: org, companyId: company, actor: me(), supplierRoleId: role, supplierReference: `SUP-${++refSeq}`, issueDate, amountsIncludeVat: false, ...(currency ? { currency } : {}),
    lines: [{ description: 'Synthetic goods', quantity: '1', unitPrice: amount }] }));
  return t((tx) => purchases.approve(tx, { organisationId: org, companyId: company, actor: me(), id: d.id, duplicateOverrideReason: 'Synthetic test bills may repeat' }));
};
const pay = (company: string, role: string, amount: string, paymentDate: string, o: { allocations?: { billId: string; amount: string }[]; currency?: string; reference?: string; bank?: string; duplicateOverrideReason?: string; negativeCashReason?: string; actor?: PurchaseActor } = {}) =>
  t((tx) => purchases.recordPayment(tx, { organisationId: org, companyId: company, actor: o.actor ?? me(), supplierRoleId: role, paymentDate, amount, bankAccountId: acc[company]![o.bank ?? '1200']!,
    allocations: o.allocations ?? [], ...(o.currency ? { currency: o.currency } : {}), ...(o.reference ? { reference: o.reference } : {}), ...(o.duplicateOverrideReason ? { duplicateOverrideReason: o.duplicateOverrideReason } : {}), ...(o.negativeCashReason ? { negativeCashReason: o.negativeCashReason } : {}) }));
const doc = (company: string, id: string) => t((tx) => purchases.get(tx, company, id));

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  user = sql(`INSERT INTO "user"(email, display_name) VALUES ('ppy-${org}@t.test','P') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Payments')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Payments Co') RETURNING id`).split('\n')[0]!;
  coE = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Payments EUR Co') RETURNING id`).split('\n')[0]!;
  const accounts = new AccountService();
  for (const c of [co, coE]) {
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','2026-01-01','2026-12-31')`);
    acc[c] = {};
    for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: user }))).items) acc[c]![a.code] = a.id;
    for (const [n, name] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) {
      acc[c]![n] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: user, input: { code: n, name, type: 'EXPENSE', subtype: 'OTHER_EXPENSE', isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: 'PL.OTHER_EXPENSES', activeFrom: null, activeTo: null } }))).id;
    }
    await t((tx) => new FxSettingsService().set(tx, { organisationId: org, companyId: c, actor: { ...me(), kind: 'USER' }, roundingAccountId: acc[c]!['7900']!, realisedAccountId: acc[c]!['7910']!, unrealisedAccountId: acc[c]!['7920']!, defaultSeries: {}, reason: 'FX accounts for the payment tests' }));
    await t((tx) => purchases.setSettings(tx, { organisationId: org, companyId: c, actor: me(), payablesAccountId: acc[c]!['2100']!, billPrefix: 'BILL-', debitNotePrefix: 'DN-', billStart: 1, debitNoteStart: 1, requireSeparateApprover: false, reason: 'Purchase settings for the payment tests' }));
  }
  for (const [date, rate] of [['2026-03-02', '0.85'], ['2026-04-01', '0.90'], ['2026-05-04', '0.80']] as const) {
    await t((tx) => new RateService().create(tx, { organisationId: org, companyId: coE, actor: me(), fromCurrency: 'EUR', kind: 'DAILY', validFrom: date, rate, source: 'synthetic test rate' }));
  }
});
afterAll(() => db.close());

describe('supplier payments (V1-MOD-09, V1-EX-04)', () => {
  let sup: string, a: Awaited<ReturnType<typeof bill>>, b: Awaited<ReturnType<typeof bill>>, p: Awaited<ReturnType<typeof pay>>;
  it('a payment posts Dr payables / Cr bank; allocated in full and in part at entry; the rest stays a prepayment', async () => {
    sup = supplier(co, 'Parts Supplier Ltd');
    a = await bill(co, sup, '100.00', '2026-02-01');
    b = await bill(co, sup, '250.00', '2026-02-10');
    p = await pay(co, sup, '400.00', '2026-02-20', { reference: 'FP 0001', allocations: [{ billId: a.id, amount: '100.00' }, { billId: b.id, amount: '200.00' }] });
    expect(p).toMatchObject({ amount: '400.00', unallocated: '100.00', status: 'POSTED', bankDetailsUnverified: false, allocations: [{ billId: a.id, amount: '100.0000' }, { billId: b.id, amount: '200.0000' }] });
    expect(linesOf(p.journalId)).toBe('2100:400.0000/0.0000 ; 1200:0.0000/400.0000');
    expect(await doc(co, a.id)).toMatchObject({ paymentStatus: 'PAID' });
    expect(await doc(co, b.id)).toMatchObject({ paymentStatus: 'PART_PAID', outstanding: '50.00' });
    const later = await t((tx) => purchases.allocatePayment(tx, { organisationId: org, companyId: co, actor: me(), paymentId: p.id, allocations: [{ billId: b.id, amount: '50.00' }], date: '2026-03-01' }));
    expect(later.unallocated).toBe('50.00');
    expect(await doc(co, b.id)).toMatchObject({ paymentStatus: 'PAID' });
    expect(await t((tx) => purchases.reconciliation(tx, co))).toMatchObject({ reconciled: true, currencies: [{ currency: 'GBP', openItems: '-50.00', difference: '0.00' }] });
  });
  it('a payment while the stored bank details are unverified is recorded and flagged, never blocked (DEC-035)', async () => {
    sql(`UPDATE supplier_profile SET bank_details_enc='v1:synthetic-ciphertext', bank_details_masked='S*** - account ****1234', bank_details_status='UNVERIFIED', bank_details_changed_by_user_id='${user}', bank_details_changed_at=now() WHERE role_id='${sup}'`);
    const flagged = await pay(co, sup, '12.34', '2026-03-03', { reference: 'FP 0002' });
    expect(flagged.bankDetailsUnverified).toBe(true);
    expect(sql(`SELECT metadata->>'bankDetailsUnverified' FROM audit_event WHERE entity_id='${flagged.id}' AND action='purchase_payment.recorded'`)).toBe('true');
    expect((await t((tx) => purchases.listPayments(tx, co, { bankDetailsUnverified: true, limit: 10 }))).items.map((x) => x.id)).toEqual([flagged.id]);
  });
  it('duplicates need a reason; bank account and permission checks; allocated payments cannot be reversed; unallocated ones are mirrored', async () => {
    await rejects(pay(co, sup, '400.00', '2026-02-20'), 'possible_duplicate', 409);
    await rejects(pay(co, sup, '1.00', '2026-03-09', { reference: 'FP 0001' }), 'possible_duplicate', 409);
    await rejects(pay(co, sup, '5.00', '2026-03-10', { bank: '2100' }), 'not_a_bank_account');
    await rejects(pay(co, sup, '5.00', '2026-03-10', { actor: me(['purchases:approve']) }), 'permission_denied', 403);
    await rejects(t((tx) => purchases.reversePayment(tx, { organisationId: org, companyId: co, actor: me(), id: p.id, reason: 'Paid to the wrong supplier' })), 'payment_allocated', 409);
    // DEC-037: the cash box holds nothing, so paying 75.00 from it is refused until someone says why
    await rejects(pay(co, sup, '75.00', '2026-03-05', { reference: 'CASH 7', bank: '1220' }), 'negative_cash', 422);
    const lone = await pay(co, sup, '75.00', '2026-03-05', { reference: 'CASH 7', bank: '1220', negativeCashReason: 'Paid from the owner\'s pocket; cash float not yet recorded' });
    expect(sql(`SELECT negative_cash_reason FROM journal WHERE id='${lone.journalId}'`)).toMatch(/owner's pocket/);
    const rev = await t((tx) => purchases.reversePayment(tx, { organisationId: org, companyId: co, actor: me(), id: lone.id, reason: 'Payment bounced back' }));
    expect(linesOf(rev.reversalJournalId!)).toBe('1220:75.0000/0.0000 ; 2100:0.0000/75.0000');
    await rejects(t((tx) => new PostingService().reverse(tx, { organisationId: org, companyId: co, journalId: p.journalId, reason: 'Ledger route', actor: { kind: 'USER', userId: user, can: async () => true } })), 'subledger_journal');
    expect((await t((tx) => purchases.reconciliation(tx, co))).reconciled).toBe(true);
  });
});

describe('realised FX on payments (V1-FX-07)', () => {
  it('an EUR bill paid at two rates: a loss when paying more in sterling, a gain when paying less; no residue', async () => {
    const sup = supplier(coE, 'Euro Supplier SA');
    const b = await bill(coE, sup, '1000.00', '2026-03-02', 'EUR');
    // 600 at 0.90 = 540.00 paid against 510.00 carried: a loss of 30.00
    const p1 = await pay(coE, sup, '600.00', '2026-04-01', { currency: 'EUR', allocations: [{ billId: b.id, amount: '600.00' }] });
    expect(p1.allocations[0]).toMatchObject({ billFunctional: '510.00', debitFunctional: '540.00', realisedFx: '-30.00' });
    expect(linesOf(p1.allocations[0]!.fxJournalId!)).toBe('2100:0.0000/30.0000 ; 7910:30.0000/0.0000');
    // 400 at 0.80 = 320.00 against the remaining 340.00: a gain of 20.00
    const p2 = await pay(coE, sup, '400.00', '2026-05-04', { currency: 'EUR', allocations: [{ billId: b.id, amount: '400.00' }] });
    expect(p2.allocations[0]).toMatchObject({ billFunctional: '340.00', debitFunctional: '320.00', realisedFx: '20.00' });
    expect(linesOf(p2.allocations[0]!.fxJournalId!)).toBe('2100:20.0000/0.0000 ; 7910:0.0000/20.0000');
    expect(await doc(coE, b.id)).toMatchObject({ paymentStatus: 'PAID', functional: { outstanding: '0.00' } });
    // 540 + 320 paid against 850 carried: a net loss of 10.00
    expect(sql(`SELECT sum(l.debit - l.credit) FROM journal_line l JOIN journal j ON j.id=l.journal_id WHERE l.account_id='${acc[coE]!['7910']}' AND j.source_type='PURCHASE_ALLOCATION_FX'`)).toBe('10.0000');
    expect(await t((tx) => purchases.reconciliation(tx, coE))).toMatchObject({ reconciled: true, currencies: [{ currency: 'EUR', openItems: '0.00', control: { total: '0.00', totalFunctional: '0.00' } }] });
  });
});

describe('supplier statement and aged payables', () => {
  it('the statement shows what is owed, with a running balance', async () => {
    const sup = supplier(co, 'Statement Supplier Ltd');
    await bill(co, sup, '100.00', '2026-02-01');
    await bill(co, sup, '250.00', '2026-02-10');
    await pay(co, sup, '400.00', '2026-02-20', { reference: 'ST-1' });
    const st = await t((tx) => purchases.statement(tx, co, sup, { from: '2026-02-05', to: '2026-02-28' }));
    expect(st.currencies).toEqual([expect.objectContaining({ currency: 'GBP', opening: '100.00', closing: '-50.00' })]);
    expect(st.currencies[0]!.lines.map((l) => `${l.date} ${l.type} ${l.debit}/${l.credit} = ${l.balance}`)).toEqual(['2026-02-10 BILL 0.00/250.00 = 350.00', '2026-02-20 PAYMENT 400.00/0.00 = -50.00']);
  });
  it('ageing as at a date, unallocated payments apart; a later allocation does not rewrite the past', async () => {
    const sup = supplier(co, 'Ageing Supplier Ltd');
    const x = await bill(co, sup, '300.00', '2026-01-01');
    await bill(co, sup, '120.00', '2026-03-01');
    const p = await pay(co, sup, '100.00', '2026-03-10', { reference: 'AG-1' });
    const at = (asOf: string) => t((tx) => purchases.agedPayables(tx, co, { asOf, supplierRoleId: sup }));
    expect((await at('2026-04-15')).suppliers).toEqual([expect.objectContaining({ days1to30: '120.00', days61to90: '300.00', unallocatedDebits: '-100.00', total: '320.00' })]);
    await t((tx) => purchases.allocatePayment(tx, { organisationId: org, companyId: co, actor: me(), paymentId: p.id, allocations: [{ billId: x.id, amount: '100.00' }], date: '2026-04-20' }));
    expect((await at('2026-04-15')).suppliers[0]).toMatchObject({ days61to90: '300.00', unallocatedDebits: '-100.00' });
    expect((await at('2026-04-30')).suppliers[0]).toMatchObject({ days61to90: '200.00', unallocatedDebits: '0.00', total: '320.00' });
  });
});
