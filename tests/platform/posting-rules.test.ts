import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOURNAL_SOURCES } from '@uk/contracts';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, BankService, CashService, FxSettingsService, PeriodService, PostingService, PurchasesService, RateService, SalesService, VatService, type SalesActor } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-TEST-01 (DEC-047): the cells of the posting-rule coverage registry that no earlier milestone's tests filled. ALL SYNTHETIC (VAT at 12.5%).
 *  - every journal source is refused in a closed period through its own service (the service passes its date to the PostingService), and in a locked one;
 *  - every source whose design carries no VAT refuses a VAT code (registry flag `vatCodes`);
 *  - every sub-ledger source reaches only its control kinds, and is never reversed through the ledger;
 *  - a cash receipt's reversal mirrors its VAT lines at the same rate version and tax point.
 * Lock Co (VAT registered, GBP) and FX Lock Co (not registered, EUR documents at 0.85 then 0.90); each closes January and is then asked to post in it.
 */
let db: Database;
let org: string, user: string, reviewer: string, co: string, coF: string;
const acc: Record<string, Record<string, string>> = {};
const code: Record<string, string> = {};
const vat = new VatService(), sales = new SalesService(), purchases = new PurchasesService(), cash = new CashService(), bank = new BankService(), posting = new PostingService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const me = (): SalesActor => ({ kind: 'USER', userId: user, can: async () => true });
const all = async () => true;
const rejects = (p: Promise<unknown>, c: string) => expect(p).rejects.toMatchObject({ code: c });
const src = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026, s.1 (test fixture, not a real rule)', retrievedOn: '2025-01-01' };
const journals = (c: string) => Number(sql(`SELECT count(*) FROM journal WHERE company_id='${c}'`));
const period = (c: string, start: string) => sql(`SELECT id FROM accounting_period WHERE company_id='${c}' AND start_date='${start}'`);

async function setupCompany(name: string) {
  const c = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','${name}') RETURNING id`).split('\n')[0]!;
  for (const [s, e] of [['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28']]) sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','${s}','${e}')`);
  const accounts = new AccountService();
  acc[c] = {};
  for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: user }))).items) acc[c]![a.code] = a.id;
  const mk = async (n: string, nm: string, type: string, subtype: string, mapping: string, tax = 'NOT_APPLICABLE') =>
    (acc[c]![n] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: user, input: { code: n, name: nm, type: type as never, subtype, isControl: false, controlKind: null, taxTreatment: tax as never, reportingMapping: mapping, activeFrom: null, activeTo: null } }))).id);
  for (const [n, nm] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) await mk(n, nm, 'EXPENSE', 'OTHER_EXPENSE', 'PL.OTHER_EXPENSES');
  await mk('1150', 'VAT recoverable', 'ASSET', 'CURRENT_ASSET_VAT', 'BS.CURRENT_ASSETS.DEBTORS', 'VAT_CONTROL');
  await t((tx) => new FxSettingsService().set(tx, { organisationId: org, companyId: c, actor: me(), roundingAccountId: acc[c]!['7900']!, realisedAccountId: acc[c]!['7910']!, unrealisedAccountId: acc[c]!['7920']!, defaultSeries: {}, reason: 'FX accounts for the posting-rule tests' }));
  await t((tx) => sales.setSettings(tx, { organisationId: org, companyId: c, actor: me(), receivablesAccountId: acc[c]!['1100']!, invoicePrefix: 'INV-', creditNotePrefix: 'CN-', invoiceStart: 1, creditNoteStart: 1, requireSeparateApprover: false, reason: 'Sales settings for the posting-rule tests' }));
  await t((tx) => purchases.setSettings(tx, { organisationId: org, companyId: c, actor: me(), payablesAccountId: acc[c]!['2100']!, billPrefix: 'BILL-', debitNotePrefix: 'DN-', billStart: 1, debitNoteStart: 1, requireSeparateApprover: false, reason: 'Purchase settings for the posting-rule tests' }));
  return c;
}
function role(company: string, kind: 'CUSTOMER' | 'SUPPLIER') {
  const ct = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','${kind} ${uuidv7().slice(-6)}','${user}') RETURNING id`).split('\n')[0]!;
  const r = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, created_by_user_id) VALUES ('${org}','${company}','${ct}','${kind}','${user}') RETURNING id`).split('\n')[0]!;
  sql(kind === 'CUSTOMER' ? `INSERT INTO customer_profile(role_id, organisation_id, company_id, payment_terms_days) VALUES ('${r}','${org}','${company}',30)`
    : `INSERT INTO supplier_profile(role_id, organisation_id, company_id, payment_terms_days) VALUES ('${r}','${org}','${company}',30)`);
  return r;
}
const base = (c: string) => ({ organisationId: org, companyId: c, actor: me() });
const invoiceDraft = (c: string, cust: string, date: string, net: string, o: { tax?: boolean; currency?: string } = {}) =>
  t((tx) => sales.createInvoice(tx, { ...base(c), customerRoleId: cust, issueDate: date, amountsIncludeVat: false, ...(o.currency ? { currency: o.currency } : {}),
    lines: [{ description: 'Synthetic goods', quantity: '1', unitPrice: net, accountId: acc[c]!['4000']!, ...(o.tax ? { taxCodeId: code.S } : {}) }] }));
const billDraft = (c: string, sup: string, date: string, net: string, ref: string, o: { tax?: boolean; currency?: string } = {}) =>
  t((tx) => purchases.createBill(tx, { ...base(c), supplierRoleId: sup, supplierReference: ref, issueDate: date, amountsIncludeVat: false, ...(o.currency ? { currency: o.currency } : {}),
    lines: [{ description: 'Synthetic service', quantity: '1', unitPrice: net, accountId: acc[c]!['6100']!, ...(o.tax ? { taxCodeId: code.P } : {}) }] }));
const money = (c: string, direction: 'RECEIPT' | 'PAYMENT', date: string, account: string, amount: string, tax?: string) =>
  t((tx) => cash.record(tx, { ...base(c), direction, transactionDate: date, bankAccountId: acc[c]!['1200']!, description: `${direction} ${account} ${amount}`, amountsIncludeVat: false,
    lines: [{ description: 'Synthetic', accountId: acc[c]![account]!, amount, ...(tax ? { taxCodeId: code[tax] } : {}) }], duplicateOverrideReason: 'Synthetic entries may repeat' }));
const close = (c: string, start: string) => t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: c, periodId: period(c, start), action: 'close', userId: user, can: all,
  acknowledgeDraftDocuments: true, acknowledgeUnreconciledBank: true }));

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  const mkUser = (n: string) => sql(`INSERT INTO "user"(email, display_name) VALUES ('rules-${n}-${org}@t.test','${n}') RETURNING id`).split('\n')[0]!;
  user = mkUser('u'); reviewer = mkUser('r');
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Posting rules')`);
  co = await setupCompany('Lock Co');
  coF = await setupCompany('FX Lock Co');
  for (const [c, dir, boxes] of [['S', 'SALES', [[6], [1]]], ['P', 'PURCHASES', [[7], [4]]]] as const) {
    const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: me(), code: c, name: `Synthetic ${c}`, treatment: 'STANDARD' as never, direction: dir as never, reverseCharge: false }));
    code[c] = tc.id;
    const r = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: me(), taxCodeId: tc.id, rate: '12.5', effectiveFrom: '2025-01-01', netBoxes: [...boxes[0]], vatBoxes: [...boxes[1]], source: src }));
    await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: { ...me(), userId: reviewer }, id: r.id, notes: 'Synthetic fixture checked against the test source' }));
  }
  await t((tx) => vat.setSettings(tx, { organisationId: org, companyId: co, actor: me(), registered: true, vrn: 'GB123456789', registeredFrom: '2025-01-01', scheme: 'STANDARD', periodMonths: 3, anchorPeriodEnd: '2026-03-31',
    outputAccountId: acc[co]!['2200']!, inputAccountId: acc[co]!['1150']!, reason: 'Registered for VAT (synthetic)' }));
});
afterAll(() => db.close());

describe('period lock, per journal source through its own service (V1-TEST-01)', () => {
  it('Lock Co: after January is closed, every document, receipt, payment, cash entry, transfer and their reversals dated in it are refused; nothing is written', async () => {
    const cust = role(co, 'CUSTOMER'), sup = role(co, 'SUPPLIER');
    await money(co, 'RECEIPT', '2026-01-02', '3000', '5000.00');
    const inv = await t(async (tx) => sales.approve(tx, { ...base(co), id: (await invoiceDraft(co, cust, '2026-01-05', '400.00', { tax: true })).id }));
    const receipt = await t((tx) => sales.recordReceipt(tx, { ...base(co), customerRoleId: cust, receiptDate: '2026-01-06', amount: '100.00', bankAccountId: acc[co]!['1200']!, allocations: [] }));
    const bill = await t(async (tx) => purchases.approve(tx, { ...base(co), id: (await billDraft(co, sup, '2026-01-07', '200.00', 'LOCK-1', { tax: true })).id }));
    const payment = await t((tx) => purchases.recordPayment(tx, { ...base(co), supplierRoleId: sup, paymentDate: '2026-01-08', amount: '50.00', bankAccountId: acc[co]!['1200']!, allocations: [] }));
    const cashOut = await money(co, 'PAYMENT', '2026-01-09', '6100', '80.00', 'P');
    const cashIn = await money(co, 'RECEIPT', '2026-01-10', '4000', '200.00', 'S');
    const transfer = await t((tx) => bank.transfer(tx, { ...base(co), fromAccountId: acc[co]!['1200']!, toAccountId: acc[co]!['1220']!, transferDate: '2026-01-11', amount: '100.00', description: 'Float' }));
    // drafts dated in January, approved only after it is closed
    const creditDraft = await t((tx) => sales.createCreditNote(tx, { ...base(co), originalInvoiceId: inv.id, issueDate: '2026-01-20', reason: 'Goods returned (synthetic)' }));
    const debitDraft = await t((tx) => purchases.createDebitNote(tx, { ...base(co), originalBillId: bill.id, issueDate: '2026-01-20', reason: 'Service credited (synthetic)' }));
    const invoiceDraft2 = await invoiceDraft(co, cust, '2026-01-21', '50.00', { tax: true });
    const billDraft2 = await billDraft(co, sup, '2026-01-21', '60.00', 'LOCK-2', { tax: true });
    await close(co, '2026-01-01');
    const before = journals(co);
    const day = '2026-01-25';
    await rejects(t((tx) => sales.approve(tx, { ...base(co), id: invoiceDraft2.id })), 'period_closed'); // SALES_INVOICE
    await rejects(t((tx) => sales.approve(tx, { ...base(co), id: creditDraft.id })), 'period_closed'); // SALES_CREDIT_NOTE
    await rejects(t((tx) => sales.recordReceipt(tx, { ...base(co), customerRoleId: cust, receiptDate: day, amount: '10.00', bankAccountId: acc[co]!['1200']!, allocations: [] })), 'period_closed'); // SALES_RECEIPT
    await rejects(t((tx) => sales.reverseReceipt(tx, { ...base(co), id: receipt.id, reason: 'Recorded twice (synthetic)', date: day })), 'period_closed'); // SALES_RECEIPT_REVERSAL
    await rejects(t((tx) => purchases.approve(tx, { ...base(co), id: billDraft2.id })), 'period_closed'); // PURCHASE_BILL
    await rejects(t((tx) => purchases.approve(tx, { ...base(co), id: debitDraft.id })), 'period_closed'); // PURCHASE_DEBIT_NOTE
    await rejects(t((tx) => purchases.recordPayment(tx, { ...base(co), supplierRoleId: sup, paymentDate: day, amount: '10.00', bankAccountId: acc[co]!['1200']!, allocations: [] })), 'period_closed'); // PURCHASE_PAYMENT
    await rejects(t((tx) => purchases.reversePayment(tx, { ...base(co), id: payment.id, reason: 'Recorded twice (synthetic)', date: day })), 'period_closed'); // PURCHASE_PAYMENT_REVERSAL
    await rejects(money(co, 'PAYMENT', day, '6100', '10.00', 'P'), 'period_closed'); // CASH_PAYMENT
    await rejects(money(co, 'RECEIPT', day, '4000', '10.00', 'S'), 'period_closed'); // CASH_RECEIPT
    await rejects(t((tx) => cash.reverse(tx, { ...base(co), id: cashOut.id, reason: 'Entered in error (synthetic)', date: day })), 'period_closed'); // CASH_PAYMENT_REVERSAL
    await rejects(t((tx) => cash.reverse(tx, { ...base(co), id: cashIn.id, reason: 'Entered in error (synthetic)', date: day })), 'period_closed'); // CASH_RECEIPT_REVERSAL
    await rejects(t((tx) => bank.transfer(tx, { ...base(co), fromAccountId: acc[co]!['1200']!, toAccountId: acc[co]!['1220']!, transferDate: day, amount: '10.00', description: 'Float top-up', duplicateOverrideReason: 'Synthetic' })), 'period_closed'); // BANK_TRANSFER
    await rejects(t((tx) => bank.reverseTransfer(tx, { ...base(co), id: transfer.id, reason: 'Entered in error (synthetic)', date: day })), 'period_closed'); // BANK_TRANSFER_REVERSAL
    expect(journals(co)).toBe(before);
    expect(sql(`SELECT count(*) FROM sales_document WHERE company_id='${co}' AND status='DRAFT'`)).toBe('2');
    // locked is refused with its own code
    await t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: co, periodId: period(co, '2026-01-01'), action: 'lock', userId: user, can: all, reason: 'January filed (synthetic)' }));
    await rejects(money(co, 'RECEIPT', day, '4000', '10.00', 'S'), 'period_locked');
    await rejects(t((tx) => bank.reverseTransfer(tx, { ...base(co), id: transfer.id, reason: 'Entered in error (synthetic)', date: day })), 'period_locked');
    expect(journals(co)).toBe(before);
  });

  it('FX Lock Co: an allocation dated in a closed period would post its realised difference there, so it is refused (sales and purchases)', async () => {
    const rates = new RateService();
    for (const [date, rate] of [['2026-01-05', '0.85'], ['2026-01-06', '0.90']] as const) {
      await t((tx) => rates.create(tx, { organisationId: org, companyId: coF, actor: me(), fromCurrency: 'EUR', kind: 'DAILY', validFrom: date, rate, source: 'synthetic test rate' }));
    }
    const cust = role(coF, 'CUSTOMER'), sup = role(coF, 'SUPPLIER');
    const inv = await t(async (tx) => sales.approve(tx, { ...base(coF), id: (await invoiceDraft(coF, cust, '2026-01-05', '1000.00', { currency: 'EUR' })).id }));
    const receipt = await t((tx) => sales.recordReceipt(tx, { ...base(coF), customerRoleId: cust, receiptDate: '2026-01-06', currency: 'EUR', amount: '600.00', bankAccountId: acc[coF]!['1200']!, allocations: [] }));
    const bill = await t(async (tx) => purchases.approve(tx, { ...base(coF), id: (await billDraft(coF, sup, '2026-01-05', '500.00', 'FX-1', { currency: 'EUR' })).id }));
    const payment = await t((tx) => purchases.recordPayment(tx, { ...base(coF), supplierRoleId: sup, paymentDate: '2026-01-06', currency: 'EUR', amount: '300.00', bankAccountId: acc[coF]!['1200']!, allocations: [] }));
    await close(coF, '2026-01-01');
    const before = journals(coF);
    await rejects(t((tx) => sales.allocateReceipt(tx, { ...base(coF), receiptId: receipt.id, allocations: [{ invoiceId: inv.id, amount: '600.00' }], date: '2026-01-25' })), 'period_closed'); // SALES_ALLOCATION_FX
    await rejects(t((tx) => purchases.allocatePayment(tx, { ...base(coF), paymentId: payment.id, allocations: [{ billId: bill.id, amount: '300.00' }], date: '2026-01-25' })), 'period_closed'); // PURCHASE_ALLOCATION_FX
    expect(journals(coF)).toBe(before);
    // in February the same allocations post their realised differences; those journals are final in the ledger (corrected in the sub-ledger only)
    await t((tx) => sales.allocateReceipt(tx, { ...base(coF), receiptId: receipt.id, allocations: [{ invoiceId: inv.id, amount: '600.00' }], date: '2026-02-02' }));
    await t((tx) => purchases.allocatePayment(tx, { ...base(coF), paymentId: payment.id, allocations: [{ billId: bill.id, amount: '300.00' }], date: '2026-02-02' }));
    const fx = sql(`SELECT source_type || ':' || id FROM journal WHERE company_id='${coF}' AND source_type LIKE '%_ALLOCATION_FX' ORDER BY source_type`).split('\n');
    expect(fx.map((x) => x.split(':')[0])).toEqual(['PURCHASE_ALLOCATION_FX', 'SALES_ALLOCATION_FX']);
    for (const x of fx) await rejects(t((tx) => posting.reverse(tx, { organisationId: org, companyId: coF, journalId: x.split(':')[1]!, reason: 'Trying to undo an exchange difference', actor: me() })), 'subledger_journal');
  });
});

describe('fences every source shares (V1-TEST-01)', () => {
  it('a source whose design carries no VAT refuses a VAT code: receipts, payments, transfers, allocations, revaluations, reversals and requests', async () => {
    // the V2 register sources (FIXED_ASSET_*, year-end adjustments) are proved in tests/platform/fixed-assets.test.ts and year-end.test.ts on their own accounts
    const noVat = Object.entries(JOURNAL_SOURCES).filter(([k, s]) => !s.vatCodes && !k.startsWith('FIXED_ASSET_') && !['ACCRUAL', 'ACCRUAL_AUTO_REVERSAL', 'ACCRUAL_CANCELLATION', 'ADJUSTMENT_SETUP', 'ADJUSTMENT_SETUP_REVERSAL', 'ADJUSTMENT_RELEASE', 'ADJUSTMENT_RELEASE_REVERSAL', 'PROVISION_MOVEMENT', 'PROVISION_MOVEMENT_REVERSAL', 'YEAR_END_CLOSE', 'YEAR_END_CLOSE_REVERSAL'].includes(k)).map(([k]) => k);
    expect(noVat.sort()).toEqual(['BANK_TRANSFER', 'BANK_TRANSFER_REVERSAL', 'CASH_PAYMENT_REVERSAL', 'CASH_RECEIPT_REVERSAL', 'CONTROL_ADJUSTMENT', 'FX_REVALUATION', 'OPENING_BALANCE', 'PURCHASE_ALLOCATION_FX',
      'PURCHASE_PAYMENT', 'PURCHASE_PAYMENT_REVERSAL', 'REVERSAL', 'SALES_ALLOCATION_FX', 'SALES_RECEIPT', 'SALES_RECEIPT_REVERSAL', 'VAT_RETURN']);
    const before = journals(co);
    for (const s of noVat) {
      const id = uuidv7();
      const def = JOURNAL_SOURCES[s]!;
      await rejects(t((tx) => posting.post(tx, {
        organisationId: org, companyId: co, journalDate: '2026-02-03', sourceType: s, sourceId: id, description: `VAT on a ${s} journal`, idempotencyKey: `vat-${id}`, actor: me(),
        ...(s === 'REVERSAL' ? { reversesJournalId: id } : {}), ...(def.requiresRequest ? { request: { id, requestedByUserId: reviewer, selfApproved: false } } : {}),
        lines: [{ accountId: acc[co]!['1200']!, debit: '10.00', credit: '0' }, { accountId: acc[co]!['4000']!, debit: '0', credit: '10.00', taxCodeId: code.S }],
      } as never)), 'vat_not_applicable');
    }
    expect(journals(co)).toBe(before);
  });

  it('every sub-ledger source reaches only its own control kinds (retained earnings is none of them)', async () => {
    // the closing journal (V2-M3b) is the one sub-ledger source that reaches retained earnings, and it reaches nothing else (tests/platform/year-end-close.test.ts)
    const sub = Object.entries(JOURNAL_SOURCES).filter(([k, s]) => s.subLedger && !k.startsWith('YEAR_END_CLOSE'));
    expect(sub.length).toBe(32);   // V5-M2 (DEC-091) adds VAT_RETURN, which reaches only VAT control accounts
    for (const k of ['YEAR_END_CLOSE', 'YEAR_END_CLOSE_REVERSAL']) expect(JOURNAL_SOURCES[k]!.controlKinds).toEqual(['RETAINED_EARNINGS']);
    for (const [s, def] of sub) {
      expect(def.controlKinds ?? []).not.toContain('RETAINED_EARNINGS');
      const id = uuidv7();
      await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: co, journalDate: '2026-02-03', sourceType: s, sourceId: id, description: `${s} to retained earnings`, idempotencyKey: `ck-${id}`, actor: me(),
        lines: [{ accountId: acc[co]!['3200']!, debit: '10.00', credit: '0' }, { accountId: acc[co]!['4000']!, debit: '0', credit: '10.00' }] })), 'control_account_restricted');
    }
  });

  it('a cash receipt reversal mirrors its VAT lines at the same rate version and tax point, and the VAT workpaper nets to nil', async () => {
    const r = await money(co, 'RECEIPT', '2026-02-04', '4000', '80.00', 'S');
    const rev = await t((tx) => cash.reverse(tx, { ...base(co), id: r.id, reason: 'Taken in error (synthetic)', date: '2026-02-05' }));
    const lines = (j: string) => sql(`SELECT account_id || '|' || debit || '|' || credit || '|' || coalesce(vat_role,'-') || '|' || coalesce(tax_rate_id::text,'-') || '|' || coalesce(tax_point::text,'-')
      FROM journal_line WHERE journal_id='${j}' ORDER BY line_no`).split('\n');
    const orig = lines(r.journalId!), mirror = lines(sql(`SELECT reversal_journal_id FROM cash_transaction WHERE id='${rev.id}'`));
    expect(orig).toHaveLength(3);
    expect(mirror).toEqual(orig.map((l) => { const [a, d, c, ...rest] = l.split('|'); return [a, c, d, ...rest].join('|'); }));
    expect(orig.filter((l) => l.split('|')[3] === 'VAT')[0]!.split('|').slice(1, 3)).toEqual(['0.0000', '10.0000']);
    const wp = await t((tx) => vat.workpaper(tx, co, { from: '2026-02-04', to: '2026-02-05' }));
    const box = (n: number) => wp.boxes.find((b) => b.box === n)!;
    expect([box(1).amount, box(6).amount, box(1).lines.length]).toEqual(['0.00', '0.00', 2]);
  });
});

describe('audit trail of every source module (V1-CTL-06)', () => {
  it('each journal has its journal.posted event; each sub-ledger action its own event, by the person, with what changed', async () => {
    for (const c of [co, coF]) {
      const missing = sql(`SELECT count(*) FROM journal j WHERE j.company_id='${c}' AND NOT EXISTS (SELECT 1 FROM audit_event a WHERE a.entity_type='journal' AND a.entity_id=j.id::text AND a.action IN ('journal.posted','journal.reversed') AND a.actor_user_id='${user}')`);
      expect(missing).toBe('0');
    }
    const actions = new Set(sql(`SELECT DISTINCT action FROM audit_event WHERE company_id IN ('${co}','${coF}')`).split('\n'));
    for (const a of ['sales_document.created', 'sales_document.approved', 'sales_receipt.recorded', 'sales_allocation.created', 'purchase_document.created', 'purchase_document.approved', 'purchase_payment.recorded',
      'purchase_allocation.created', 'cash_transaction.recorded', 'cash_transaction.reversed', 'bank_transfer.recorded', 'period.closed', 'period.locked']) expect(actions, a).toContain(a);
    const unattributed = sql(`SELECT count(*) FROM audit_event WHERE company_id IN ('${co}','${coF}') AND action NOT LIKE '%settings%' AND actor_user_id IS NULL`);
    expect(unattributed).toBe('0');
    const approved = sql(`SELECT after::text FROM audit_event WHERE company_id='${co}' AND action='cash_transaction.reversed' LIMIT 1`);
    expect(approved.length).toBeGreaterThan(2);
  });
});
