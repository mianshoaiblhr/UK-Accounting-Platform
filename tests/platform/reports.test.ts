import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statementMappingSchema } from '@uk/contracts';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import {
  AccountService, AlertService, BankService, CashService, DrillDownService, FxSettingsService, JournalRequestService, LedgerPolicyService, PeriodService, PostingService, PurchasesService, RateService,
  ReportService, RevaluationService, SalesService, VatService, type SalesActor,
} from '@uk/accounting';
import { BankStatementService } from '@uk/platform';
import { adminSql } from '../helpers/db';

/**
 * V1-M8 through the services, on hand-calculated books (ALL SYNTHETIC; VAT at a synthetic 12.5%):
 *  Report Co, financial years 2025 and 2026 (calendar):
 *   2025  share capital 1,000.00 paid in; cash sale 400.00 + VAT 50.00                                         -> profit 400.00
 *   2026  invoice 2,000.00 + 250.00 (paid); bill rent 800.00 + 100.00 (paid); bank charges 25.00; interest 10.00;
 *         cost of sales 300.00 + 37.50 by card; 100.00 to petty cash; invoice 1,000.00 + 125.00 (unpaid); bill stationery 200.00 + 25.00 (unpaid)
 *         P&L: turnover 3,000.00; cost of sales 300.00; gross profit 2,700.00; admin 1,025.00; operating profit 1,675.00; interest 10.00 -> 1,685.00
 *         balance sheet 31 Dec 2026: debtors 1,125.00 + VAT recoverable 162.50; bank 2,347.50 + cash 100.00 = current assets 3,735.00;
 *         creditors 225.00 + VAT 425.00 = 650.00; net assets 3,085.00 = share capital 1,000.00 + P&L b/f 400.00 + year to date 1,685.00
 *  FX Co (EUR at 0.85 / 0.90 / 0.80): invoice EUR 1,000 (850.00), receipt EUR 600 (540.00 for 510.00 carried: realised gain 30.00), revaluation at 0.80
 *         of EUR 400 receivable (340.00 -> 320.00) and EUR 600 at the bank (540.00 -> 480.00): unrealised loss 80.00, reversed the next day
 */
let db: Database;
let org: string, user: string, reviewer: string, co: string, coF: string, coA: string;
const acc: Record<string, Record<string, string>> = {};
const code: Record<string, string> = {};
const vat = new VatService(), sales = new SalesService(), purchases = new PurchasesService(), cash = new CashService(), reports = new ReportService(), drill = new DrillDownService(), alerts = new AlertService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: user }, fn);
const me = (deny: string[] = []): SalesActor => ({ kind: 'USER', userId: user, can: async (p) => !deny.includes(p) });
const all = (deny: string[] = []) => async (p: string) => !deny.includes(p);
const src = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026, s.1 (test fixture, not a real rule)', retrievedOn: '2025-01-01' };
/** Statement lines are a union: totals carry no accounts. */
const accountsOf = (l: object) => ('accounts' in l ? (l.accounts as { accountId: string; code: string; amount: string; drilldown: unknown }[]) : []);
const amounts = (lines: { key: string; amount: string; comparative?: string }[]) => Object.fromEntries(lines.map((l) => [l.key, l.comparative === undefined ? l.amount : `${l.amount} | ${l.comparative}`]));

async function setupCompany(name: string, periods: [string, string][]) {
  const c = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','${name}') RETURNING id`).split('\n')[0]!;
  for (const [s, e] of periods) sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','${s}','${e}')`);
  const accounts = new AccountService();
  acc[c] = {};
  for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: user }))).items) acc[c]![a.code] = a.id;
  const mk = async (n: string, nm: string, type: string, subtype: string, mapping: string, tax = 'NOT_APPLICABLE') =>
    (acc[c]![n] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: user, input: { code: n, name: nm, type: type as never, subtype, isControl: false, controlKind: null, taxTreatment: tax as never, reportingMapping: mapping, activeFrom: null, activeTo: null } }))).id);
  for (const [n, nm] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) await mk(n, nm, 'EXPENSE', 'OTHER_EXPENSE', 'PL.OTHER_EXPENSES');
  await mk('1150', 'VAT recoverable', 'ASSET', 'CURRENT_ASSET_VAT', 'BS.CURRENT_ASSETS.DEBTORS', 'VAT_CONTROL');
  await t((tx) => new FxSettingsService().set(tx, { organisationId: org, companyId: c, actor: me(), roundingAccountId: acc[c]!['7900']!, realisedAccountId: acc[c]!['7910']!, unrealisedAccountId: acc[c]!['7920']!, defaultSeries: {}, reason: 'FX accounts for the report tests' }));
  await t((tx) => sales.setSettings(tx, { organisationId: org, companyId: c, actor: me(), receivablesAccountId: acc[c]!['1100']!, invoicePrefix: 'INV-', creditNotePrefix: 'CN-', invoiceStart: 1, creditNoteStart: 1, requireSeparateApprover: false, reason: 'Sales settings for the report tests' }));
  await t((tx) => purchases.setSettings(tx, { organisationId: org, companyId: c, actor: me(), payablesAccountId: acc[c]!['2100']!, billPrefix: 'BILL-', debitNotePrefix: 'DN-', billStart: 1, debitNoteStart: 1, requireSeparateApprover: false, reason: 'Purchase settings for the report tests' }));
  return c;
}
function role(company: string, kind: 'CUSTOMER' | 'SUPPLIER') {
  const ct = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','${kind} ${uuidv7().slice(-6)}','${user}') RETURNING id`).split('\n')[0]!;
  const r = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, created_by_user_id) VALUES ('${org}','${company}','${ct}','${kind}','${user}') RETURNING id`).split('\n')[0]!;
  sql(kind === 'CUSTOMER' ? `INSERT INTO customer_profile(role_id, organisation_id, company_id, payment_terms_days) VALUES ('${r}','${org}','${company}',30)`
    : `INSERT INTO supplier_profile(role_id, organisation_id, company_id, payment_terms_days) VALUES ('${r}','${org}','${company}',30)`);
  return r;
}
const invoice = async (company: string, cust: string, date: string, net: string, o: { tax?: string; currency?: string } = {}) => {
  const d = await t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: company, actor: me(), customerRoleId: cust, issueDate: date, amountsIncludeVat: false, ...(o.currency ? { currency: o.currency } : {}),
    lines: [{ description: 'Synthetic goods', quantity: '1', unitPrice: net, accountId: acc[company]!['4000']!, ...(o.tax ? { taxCodeId: code[o.tax] } : {}) }] }));
  return t((tx) => sales.approve(tx, { organisationId: org, companyId: company, actor: me(), id: d.id }));
};
const bill = async (company: string, sup: string, date: string, net: string, account: string, ref: string) => {
  const d = await t((tx) => purchases.createBill(tx, { organisationId: org, companyId: company, actor: me(), supplierRoleId: sup, supplierReference: ref, issueDate: date, amountsIncludeVat: false,
    lines: [{ description: 'Synthetic service', quantity: '1', unitPrice: net, accountId: acc[company]![account]!, taxCodeId: code.P }] }));
  return t((tx) => purchases.approve(tx, { organisationId: org, companyId: company, actor: me(), id: d.id }));
};
const money = (company: string, direction: 'RECEIPT' | 'PAYMENT', date: string, account: string, amount: string, o: { tax?: string; bank?: string; negativeCashReason?: string } = {}) =>
  t((tx) => cash.record(tx, { organisationId: org, companyId: company, actor: me(), direction, transactionDate: date, bankAccountId: acc[company]![o.bank ?? '1200']!, description: `${account} ${amount}`, amountsIncludeVat: false,
    lines: [{ description: 'Synthetic', accountId: acc[company]![account]!, amount, ...(o.tax ? { taxCodeId: code[o.tax] } : {}) }], duplicateOverrideReason: 'Synthetic report entries may repeat', negativeCashReason: o.negativeCashReason }));

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  const mkUser = (n: string) => sql(`INSERT INTO "user"(email, display_name) VALUES ('rep-${n}-${org}@t.test','${n}') RETURNING id`).split('\n')[0]!;
  user = mkUser('u'); reviewer = mkUser('r');
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Reports')`);
  co = await setupCompany('Report Co', [['2025-01-01', '2025-12-31'], ['2026-01-01', '2026-12-31']]);
  coF = await setupCompany('FX Report Co', [['2026-01-01', '2026-06-30'], ['2026-07-01', '2026-12-31']]);
  coA = await setupCompany('Alerts Co', [['2026-01-01', '2026-06-30'], ['2026-07-01', '2026-12-31']]);
  for (const [c, dir, boxes] of [['S', 'SALES', [[6], [1]]], ['P', 'PURCHASES', [[7], [4]]]] as const) {
    const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: me(), code: c, name: `Synthetic ${c}`, treatment: 'STANDARD' as never, direction: dir as never, reverseCharge: false }));
    code[c] = tc.id;
    const r = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: me(), taxCodeId: tc.id, rate: '12.5', effectiveFrom: '2025-01-01', netBoxes: [...boxes[0]], vatBoxes: [...boxes[1]], source: src }));
    await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: { ...me(), userId: reviewer }, id: r.id, notes: 'Synthetic fixture checked against the test source' }));
  }
  await t((tx) => vat.setSettings(tx, { organisationId: org, companyId: co, actor: me(), registered: true, vrn: 'GB123456789', registeredFrom: '2025-01-01', scheme: 'STANDARD', periodMonths: 3, anchorPeriodEnd: '2025-03-31',
    outputAccountId: acc[co]!['2200']!, inputAccountId: acc[co]!['1150']!, reason: 'Registered for VAT (synthetic)' }));
});
afterAll(() => db.close());

describe('the books of Report Co', () => {
  let paidInvoice: Awaited<ReturnType<typeof invoice>>, rentBill: Awaited<ReturnType<typeof bill>>;
  it('two years of activity through every sub-ledger', async () => {
    await money(co, 'RECEIPT', '2025-03-01', '3000', '1000.00');
    await money(co, 'RECEIPT', '2025-06-01', '4000', '400.00', { tax: 'S' });
    const cust = role(co, 'CUSTOMER'), sup = role(co, 'SUPPLIER');
    paidInvoice = await invoice(co, cust, '2026-02-10', '2000.00', { tax: 'S' });
    await t((tx) => sales.recordReceipt(tx, { organisationId: org, companyId: co, actor: me(), customerRoleId: cust, receiptDate: '2026-03-01', amount: '2250.00', bankAccountId: acc[co]!['1200']!, reference: 'BACS 1', allocations: [{ invoiceId: paidInvoice.id, amount: '2250.00' }] }));
    rentBill = await bill(co, sup, '2026-02-15', '800.00', '6100', 'RENT-Q1');
    await t((tx) => purchases.recordPayment(tx, { organisationId: org, companyId: co, actor: me(), supplierRoleId: sup, paymentDate: '2026-03-05', amount: '900.00', bankAccountId: acc[co]!['1200']!, allocations: [{ billId: rentBill.id, amount: '900.00' }] }));
    await money(co, 'PAYMENT', '2026-04-01', '6800', '25.00');
    await money(co, 'RECEIPT', '2026-04-02', '4900', '10.00');
    await money(co, 'PAYMENT', '2026-04-05', '5000', '300.00', { tax: 'P' });
    await t((tx) => new BankService().transfer(tx, { organisationId: org, companyId: co, actor: me(), fromAccountId: acc[co]!['1200']!, toAccountId: acc[co]!['1220']!, transferDate: '2026-04-10', amount: '100.00', description: 'Petty cash float' }));
    await invoice(co, cust, '2026-05-01', '1000.00', { tax: 'S' });
    await bill(co, sup, '2026-05-02', '200.00', '6310', 'STAT-1');
  });
  it('profit and loss for 2026 with 2025 alongside, reconciled to the ledger to the cent', async () => {
    const pl = await t((tx) => reports.profitAndLoss(tx, co, { from: '2026-01-01', to: '2026-12-31', compareFrom: '2025-01-01', compareTo: '2025-12-31' }));
    expect(amounts(pl.lines)).toEqual({
      'PL.TURNOVER': '3000.00 | 400.00', 'PL.COST_OF_SALES': '300.00 | 0.00', 'TOTAL.grossProfit': '2700.00 | 400.00',
      'PL.ADMIN_EXPENSES': '1025.00 | 0.00', 'TOTAL.operatingProfit': '1675.00 | 400.00',
      'PL.INTEREST_RECEIVABLE': '10.00 | 0.00', 'TOTAL.profitBeforeTax': '1685.00 | 400.00', 'TOTAL.profitForPeriod': '1685.00 | 400.00',
    });
    expect(pl.reconciliation).toEqual({ incomeLessExpensesFromLedger: '1685.00', difference: '0.00', reconciled: true, comparative: { incomeLessExpensesFromLedger: '400.00', reconciled: true } });
    const admin = pl.lines.find((l) => l.key === 'PL.ADMIN_EXPENSES')!;
    expect(accountsOf(admin).map((a) => `${a.code}:${a.amount}`)).toEqual(['6100:800.00', '6310:200.00', '6800:25.00']);
    expect(accountsOf(admin)[0]!.drilldown).toEqual({ accountId: acc[co]!['6100'], from: '2026-01-01', to: '2026-12-31' });
    const withEmpty = await t((tx) => reports.profitAndLoss(tx, co, { from: '2026-01-01', to: '2026-12-31', includeEmpty: true }));
    expect(withEmpty.lines.map((l) => l.key)).toContain('PL.TAXATION');
  });
  it('balance sheet at 31 December 2026 with 2025 alongside: net assets equal capital and reserves, the trial balance balances', async () => {
    const bs = await t((tx) => reports.balanceSheet(tx, co, { asOf: '2026-12-31', compareAsOf: '2025-12-31' }));
    expect(amounts(bs.lines)).toEqual({
      'TOTAL.FIXED_ASSETS': '0.00 | 0.00', 'BS.CURRENT_ASSETS.DEBTORS': '1287.50 | 0.00', 'BS.CURRENT_ASSETS.CASH': '2447.50 | 1450.00', 'TOTAL.CURRENT_ASSETS': '3735.00 | 1450.00',
      'BS.CREDITORS_WITHIN_ONE_YEAR': '650.00 | 50.00', 'TOTAL.NET_CURRENT_ASSETS': '3085.00 | 1400.00', 'TOTAL.ASSETS_LESS_CURRENT': '3085.00 | 1400.00', 'TOTAL.NET_ASSETS': '3085.00 | 1400.00',
      'BS.CAPITAL.SHARE_CAPITAL': '1000.00 | 1000.00', 'PL.BROUGHT_FORWARD': '400.00 | 0.00', 'PL.YEAR_TO_DATE': '1685.00 | 400.00', 'TOTAL.EQUITY': '3085.00 | 1400.00',
    });
    expect(bs.reconciliation).toMatchObject({ netAssets: '3085.00', capitalAndReserves: '3085.00', difference: '0.00', balanced: true, trialBalance: { balanced: true }, comparative: { balanced: true } });
    expect(bs.financialYearStart).toBe('2026-01-01');
    const debtors = bs.lines.find((l) => l.key === 'BS.CURRENT_ASSETS.DEBTORS')!;
    expect(accountsOf(debtors).map((a) => `${a.code}:${a.amount}`)).toEqual(['1100:1125.00', '1150:162.50']);
    const cashLine = bs.lines.find((l) => l.key === 'BS.CURRENT_ASSETS.CASH')!;
    expect(accountsOf(cashLine).map((a) => `${a.code}:${a.amount}`)).toEqual(['1200:2347.50', '1220:100.00']);
    const creditors = bs.lines.find((l) => l.key === 'BS.CREDITORS_WITHIN_ONE_YEAR')!;
    expect(accountsOf(creditors).map((a) => `${a.code}:${a.amount}`)).toEqual(['2100:225.00', '2200:425.00']);
  });
  it('drill-down: statement line -> account -> journal -> the document that posted it, for every kind of source in these books', async () => {
    const journals = sql(`SELECT string_agg(id::text || ':' || source_type, ',' ORDER BY journal_number) FROM journal WHERE company_id='${co}'`).split(',').map((x) => x.split(':') as [string, string]);
    const seen = new Set<string>();
    for (const [id, type] of journals) {
      const d = await t((tx) => drill.journalSource(tx, co, id, all()));
      expect(d.journal.sourceType).toBe(type);
      expect(d.source, type).not.toBeNull();
      seen.add(`${type}->${(d.source as { entityType: string }).entityType}`);
    }
    expect([...seen].sort()).toEqual(['BANK_TRANSFER->bank_transfer', 'CASH_PAYMENT->cash_transaction', 'CASH_RECEIPT->cash_transaction', 'PURCHASE_BILL->purchase_document',
      'PURCHASE_PAYMENT->purchase_payment', 'SALES_INVOICE->sales_document', 'SALES_RECEIPT->sales_receipt']);
    const inv = sql(`SELECT id FROM journal WHERE source_id='${paidInvoice.id}'`);
    const d = await t((tx) => drill.journalSource(tx, co, inv, all()));
    expect(d.source).toMatchObject({ entityType: 'sales_document', id: paidInvoice.id, documentNumber: 'INV-1', gross: '2250.00', attachments: [] });
    expect(d.lines.map((l) => `${l.accountCode}:${l.debit}/${l.credit}`)).toEqual(['1100:2250.00/0.00', '4000:0.00/2000.00', '2200:0.00/250.00']);
    // a reader without sales:read sees that a sales document stands behind the journal, not what it says
    expect((await t((tx) => drill.journalSource(tx, co, inv, all(['sales:read'])))).source).toEqual({ entityType: 'sales_document', id: paidInvoice.id, restricted: true, requires: 'sales:read' });
  });
});

describe('the FX report (V1-FX-09)', () => {
  it('realised gain on the receipt, open balances against the closing rate, the revaluation and its reversal', async () => {
    const rates = new RateService();
    for (const [date, rate] of [['2026-03-02', '0.85'], ['2026-04-01', '0.90'], ['2026-06-30', '0.80']] as const) {
      await t((tx) => rates.create(tx, { organisationId: org, companyId: coF, actor: me(), fromCurrency: 'EUR', kind: 'DAILY', validFrom: date, rate, source: 'synthetic test rate' }));
    }
    const cust = role(coF, 'CUSTOMER');
    const inv = await invoice(coF, cust, '2026-03-02', '1000.00', { currency: 'EUR' });
    await t((tx) => sales.recordReceipt(tx, { organisationId: org, companyId: coF, actor: me(), customerRoleId: cust, receiptDate: '2026-04-01', currency: 'EUR', amount: '600.00', bankAccountId: acc[coF]!['1200']!, allocations: [{ invoiceId: inv.id, amount: '600.00' }] }));
    const before = await t((tx) => reports.fx(tx, coF, { from: '2026-01-01', to: '2026-06-30' }));
    expect(before.realised).toMatchObject({ total: '30.00', byCurrency: [{ currency: 'EUR', gain: '30.00' }], journals: [{ sourceType: 'SALES_ALLOCATION_FX', gain: '30.00' }] });
    expect(before.openBalances.map((b) => `${b.accountCode}:${b.currency}:${b.originalBalance}:${b.carryingAmount}:${b.atClosingRate}:${b.unrevaluedDifference}`)).toEqual([
      '1100:EUR:400.0000:340.00:320.00:-20.00', '1200:EUR:600.0000:540.00:480.00:-60.00']);
    expect(before.revaluedAtClosingRate).toBe(false);
    const period = sql(`SELECT id FROM accounting_period WHERE company_id='${coF}' AND start_date='2026-01-01'`);
    await t((tx) => new RevaluationService(rates, new PostingService()).post(tx, { organisationId: org, companyId: coF, periodId: period, actor: me(), rates: {} }));
    const after = await t((tx) => reports.fx(tx, coF, { from: '2026-01-01', to: '2026-06-30' }));
    expect(after.unrealised).toMatchObject({ total: '-80.00', journals: [{ sourceType: 'FX_REVALUATION', gain: '-80.00' }] });
    expect(after.revaluedAtClosingRate).toBe(true);
    const year = await t((tx) => reports.fx(tx, coF, { from: '2026-01-01', to: '2026-07-31' }));
    expect(year.unrealised.total).toBe('0.00');
    expect(year.unrealised.journals.map((j) => j.sourceType)).toEqual(['FX_REVALUATION', 'REVERSAL']);
    for (const j of [...year.realised.journals, ...year.unrealised.journals]) {
      const d = await t((tx) => drill.journalSource(tx, coF, j.journalId, all()));
      expect(d.source).not.toBeNull();
    }
    const pl = await t((tx) => reports.profitAndLoss(tx, coF, { from: '2026-01-01', to: '2026-06-30' }));
    // 850.00 turnover; FX accounts are mapped to other expenses: realised gain 30.00 reduces them, unrealised loss 80.00 adds: 50.00
    expect(amounts(pl.lines)).toMatchObject({ 'PL.TURNOVER': '850.00', 'PL.OTHER_EXPENSES': '50.00', 'TOTAL.profitForPeriod': '800.00' });
    expect(pl.reconciliation.reconciled).toBe(true);
  });
});

describe('alerts and close controls (V1-CTL-03/04/05, V1-BANK-05, MAN-ACC-08)', () => {
  it('each alert is raised, shown only to readers of its module; closing and locking need acknowledgements', async () => {
    // a suspense posting through an exempt control adjustment, a short cash box, an old draft, an old unmatched statement line
    await t((tx) => new LedgerPolicyService().set(tx, { organisationId: org, companyId: coA, actor: me(), openingBalanceApproval: 'ALWAYS', controlAdjustmentApproval: 'ABOVE_THRESHOLD', materialityThreshold: '1000', requestExpiryDays: 14, reason: 'Small control adjustments without a second person (test)' }));
    await t((tx) => new JournalRequestService(new PostingService(), new LedgerPolicyService()).create(tx, { organisationId: org, companyId: coA, kind: 'CONTROL_ADJUSTMENT', actor: me(), journalDate: '2026-02-01', description: 'Unidentified receipt',
      reason: 'Money received that nobody can identify yet', lines: [{ accountId: acc[coA]!['1200']!, debit: '50.00', credit: '0' }, { accountId: acc[coA]!['9999']!, debit: '0', credit: '50.00' }],
      evidenceDocumentIds: [sql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${coA}','remittance.pdf','${user}') RETURNING id`).split('\n')[0]!] }));
    await money(coA, 'PAYMENT', '2026-02-03', '6310', '20.00', { bank: '1220', negativeCashReason: 'Paid from the owner\'s pocket before the float existed' });
    await t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: coA, actor: me(), customerRoleId: role(coA, 'CUSTOMER'), issueDate: '2026-02-05', amountsIncludeVat: false, lines: [{ description: 'Draft', quantity: '1', unitPrice: '10.00', accountId: acc[coA]!['4000']! }] }));
    const bankId = (await t((tx) => new BankService().create(tx, { organisationId: org, companyId: coA, actor: me(), accountId: acc[coA]!['1200']!, name: 'Current', statementOpeningDate: '2026-01-31', statementOpeningBalance: '0' }))).id;
    const data = Buffer.from('Date,Description,Amount\n02/02/2026,UNKNOWN CREDIT,50.00\n');
    const doc = sql(`INSERT INTO document(organisation_id, company_id, name, created_by_user_id) VALUES ('${org}','${coA}','s.csv','${user}') RETURNING id`).split('\n')[0]!;
    const ver = sql(`INSERT INTO document_version(organisation_id, document_id, version_no, storage_key, content_type, size_bytes, sha256, status, created_by_user_id) VALUES ('${org}','${doc}',1,'rep-k','text/csv',${data.length},'${createHash('sha256').update(data).digest('hex')}','AVAILABLE','${user}') RETURNING id`).split('\n')[0]!;
    const st = new BankStatementService();
    const req = await t((tx) => st.request(tx, { organisationId: org, companyId: coA, userId: user, bankAccountId: bankId, documentId: doc, versionId: ver, mapping: statementMappingSchema.parse({ dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Description', amountColumn: 'Amount' }) }));
    await st.process(db, { getObject: async () => data }, { organisationId: org, userId: user, importId: req.id });

    const list = await t((tx) => alerts.list(tx, coA, all(), { asOf: '2026-06-30' }));
    const byCode = Object.fromEntries(list.alerts.map((a) => [a.code, a]));
    expect(Object.keys(byCode).sort()).toEqual(['negative_cash', 'old_sales_drafts', 'old_unmatched_bank_lines', 'suspense_balance']);
    expect(byCode.suspense_balance).toMatchObject({ severity: 'HIGH', count: 1, total: '-50.00' });
    expect(byCode.negative_cash).toMatchObject({ severity: 'HIGH', items: [{ accountCode: '1220', balance: '-20.00' }] });
    expect(byCode.old_sales_drafts).toMatchObject({ count: 1, oldestDate: '2026-02-05' });
    expect(byCode.old_unmatched_bank_lines).toMatchObject({ count: 1, oldestDate: '2026-02-02', items: [{ bankAccountId: bankId, lines: 1, unmatched: '50.00' }] });
    expect(list.alerts.slice(0, 2).map((a) => a.severity)).toEqual(['HIGH', 'HIGH']);
    // a reader without sales or bank access does not see those alerts; a fresh draft is not old yet
    const narrow = await t((tx) => alerts.list(tx, coA, all(['sales:read', 'bank:read']), { asOf: '2026-06-30' }));
    expect(narrow.alerts.map((a) => a.code).sort()).toEqual(['negative_cash', 'suspense_balance']);
    expect((await t((tx) => alerts.list(tx, coA, all(), { asOf: '2026-02-10' }))).alerts.map((a) => a.code)).not.toContain('old_sales_drafts');

    const periods = new PeriodService();
    const p = sql(`SELECT id FROM accounting_period WHERE company_id='${coA}' AND start_date='2026-01-01'`);
    const go = (action: 'close' | 'lock', o: Record<string, unknown> = {}) => t((tx) => periods.transition(tx, { organisationId: org, companyId: coA, periodId: p, action, userId: user, can: async () => true, acknowledgeDraftDocuments: true, ...o }));
    await expect(go('close')).rejects.toMatchObject({ code: 'unreconciled_bank_items', details: { lines: 1 } });
    await go('close', { acknowledgeUnreconciledBank: true });
    expect(sql(`SELECT metadata->>'acknowledgedUnreconciledBankLines' FROM audit_event WHERE entity_id='${p}' AND action='period.closed'`)).toBe('1');
    await expect(go('lock', { reason: 'Year end lock' })).rejects.toMatchObject({ code: 'suspense_balance' });
    await go('lock', { reason: 'Locked with the unidentified receipt still in suspense, being chased', acknowledgeSuspenseBalance: true });
    expect(sql(`SELECT metadata->>'acknowledgedSuspenseBalance' FROM audit_event WHERE entity_id='${p}' AND action='period.locked'`)).toBe('-50.0000');
  });
});
