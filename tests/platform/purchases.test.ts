import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, FxSettingsService, PeriodService, PostingService, PurchasesService, RateService, VatService, type PurchaseActor, type PurchaseLineInput } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M6a through the services: supplier bills and debit notes - the purchase example with input VAT and reverse charge, the supplier-reference duplicate
 * check, debit notes at the bill's rates (reverse charge mirrored), realised FX, reconciliation and the fences. ALL RATES ARE SYNTHETIC.
 */
let db: Database;
let org: string, prep: string, appr: string, reviewer: string, co: string, coF: string;
const acc: Record<string, Record<string, string>> = {};
const code: Record<string, string> = {};
const sup: Record<string, string> = {};
const purchases = new PurchasesService();
const vat = new VatService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: prep }, fn);
const person = (userId: string, deny: string[] = []): PurchaseActor => ({ userId, kind: 'USER', can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string, status?: number) => expect(p).rejects.toMatchObject({ code: c, ...(status ? { status } : {}) });
const src = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026, s.1 (test fixture, not a real rule)', retrievedOn: '2026-01-01' };
const L = (unitPrice: string, o: { qty?: string; tax?: string; account?: string; company?: string } = {}): PurchaseLineInput =>
  ({ description: 'Synthetic purchase', quantity: o.qty ?? '1', unitPrice, ...(o.account ? { accountId: acc[o.company ?? co]![o.account]! } : {}), ...(o.tax ? { taxCodeId: code[o.tax] } : {}) });
const bill = (company: string, ref: string, lines: PurchaseLineInput[], o: Partial<Parameters<PurchasesService['createBill']>[1]> = {}) =>
  t((tx) => purchases.createBill(tx, { organisationId: org, companyId: company, actor: person(prep), supplierRoleId: sup[company]!, supplierReference: ref, issueDate: '2026-02-10', amountsIncludeVat: false, lines, ...o }));
const approve = (company: string, id: string, o: { by?: string; duplicateOverrideReason?: string } = {}) =>
  t((tx) => purchases.approve(tx, { organisationId: org, companyId: company, actor: person(o.by ?? appr), id, duplicateOverrideReason: o.duplicateOverrideReason }));
const debit = (company: string, billId: string, o: Partial<Parameters<PurchasesService['createDebitNote']>[1]> = {}) =>
  t((tx) => purchases.createDebitNote(tx, { organisationId: org, companyId: company, actor: person(prep), originalBillId: billId, issueDate: '2026-02-20', reason: 'Goods returned to the supplier', ...o }));
const linesOf = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit||':'||coalesce(l.vat_role,'-'), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);

async function defineCode(c: string, treatment: string, direction: string, rate: string, netBoxes: number[], vatBoxes: number[], reverseCharge = false) {
  const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: co, actor: person(prep), code: c, name: `Synthetic ${c}`, treatment: treatment as never, direction: direction as never, reverseCharge }));
  code[c] = tc.id;
  const r = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: co, actor: person(prep), taxCodeId: tc.id, rate, effectiveFrom: '2026-01-01', netBoxes, vatBoxes, source: src }));
  await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: co, actor: person(reviewer), id: r.id, notes: 'Synthetic fixture checked against the test source' }));
}

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  const user = (n: string) => sql(`INSERT INTO "user"(email, display_name) VALUES ('pur-${n}-${org}@t.test','${n}') RETURNING id`).split('\n')[0]!;
  prep = user('prep'); appr = user('appr'); reviewer = user('rev');
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Purchases')`);
  co = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Purchases Co') RETURNING id`).split('\n')[0]!;
  coF = sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','Purchases FX Co') RETURNING id`).split('\n')[0]!;
  const accounts = new AccountService();
  for (const c of [co, coF]) {
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','2026-01-01','2026-12-31')`);
    acc[c] = {};
    for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: prep }))).items) acc[c]![a.code] = a.id;
    for (const [n, name] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) {
      acc[c]![n] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: prep, input: { code: n, name, type: 'EXPENSE', subtype: 'OTHER_EXPENSE', isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: 'PL.OTHER_EXPENSES', activeFrom: null, activeTo: null } }))).id;
    }
    acc[c]!['1150'] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: prep, input: { code: '1150', name: 'VAT recoverable', type: 'ASSET', subtype: 'CURRENT_ASSET_VAT', isControl: false, controlKind: null, taxTreatment: 'VAT_CONTROL', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS', activeFrom: null, activeTo: null } }))).id;
    await t((tx) => new FxSettingsService().set(tx, { organisationId: org, companyId: c, actor: { ...person(prep), kind: 'USER' }, roundingAccountId: acc[c]!['7900']!, realisedAccountId: acc[c]!['7910']!, unrealisedAccountId: acc[c]!['7920']!, defaultSeries: {}, reason: 'FX accounts for the purchase tests' }));
    const contact = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','Widget Supplies Ltd','${prep}') RETURNING id`).split('\n')[0]!;
    sup[c] = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, account_code, created_by_user_id) VALUES ('${org}','${c}','${contact}','SUPPLIER','WIDGET','${prep}') RETURNING id`).split('\n')[0]!;
    sql(`INSERT INTO supplier_profile(role_id, organisation_id, company_id, payment_terms_days, default_expense_account_id) VALUES ('${sup[c]}','${org}','${c}',30,'${acc[c]!['6100']}')`);
    await t((tx) => purchases.setSettings(tx, { organisationId: org, companyId: c, actor: person(prep), payablesAccountId: acc[c]!['2100']!, billPrefix: 'BILL-', debitNotePrefix: 'DN-', billStart: 1, debitNoteStart: 1, requireSeparateApprover: false, reason: 'Purchase settings for the tests' }));
  }
  await defineCode('P', 'STANDARD', 'PURCHASES', '12.5', [7], [4]);
  await defineCode('RC', 'STANDARD', 'PURCHASES', '12.5', [7], [1, 4], true);
  await defineCode('Z', 'ZERO', 'BOTH', '0', [6, 7], []);
  await defineCode('E', 'EXEMPT', 'PURCHASES', '0', [7], []);
  await defineCode('S', 'STANDARD', 'SALES', '12.5', [6], [1]);
  await defineCode('B', 'STANDARD', 'BOTH', '12.5', [6, 7], [1, 4]);
  await t((tx) => vat.setSettings(tx, { organisationId: org, companyId: co, actor: person(prep), registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', scheme: 'STANDARD',
    periodMonths: 3, anchorPeriodEnd: '2026-03-31', outputAccountId: acc[co]!['2200']!, inputAccountId: acc[co]!['1150']!, reason: 'Registered for VAT from 1 January (synthetic)' }));
  for (const [date, rate] of [['2026-03-02', '0.85'], ['2026-04-01', '0.90']] as const) await t((tx) => new RateService().create(tx, { organisationId: org, companyId: coF, actor: person(prep), fromCurrency: 'EUR', kind: 'DAILY', validFrom: date, rate, source: 'synthetic test rate' }));
});
afterAll(() => db.close());

describe('bills (V1-MOD-05, V1-EX-02)', () => {
  let b: Awaited<ReturnType<typeof approve>>;
  it('settings need a TRADE_PAYABLES control account; lines default to the supplier expense account; sales VAT codes and control accounts are refused', async () => {
    await rejects(t((tx) => purchases.setSettings(tx, { organisationId: org, companyId: co, actor: person(prep), payablesAccountId: acc[co]!['1100']!, billPrefix: 'BILL-', debitNotePrefix: 'DN-', billStart: 1, debitNoteStart: 1, requireSeparateApprover: false, reason: 'Wrong control account' })), 'payables_account_invalid');
    const d = await bill(co, 'PROBE-1', [L('10.00')]);
    expect(d.lines[0]).toMatchObject({ accountId: acc[co]!['6100'] });
    expect(d).toMatchObject({ status: 'DRAFT', dueDate: '2026-03-12', documentNumber: null, supplierReference: 'PROBE-1' });
    await rejects(bill(co, 'PROBE-2', [L('10.00', { tax: 'S' })]), 'tax_code_direction');
    await rejects(bill(co, 'PROBE-3', [L('10.00', { account: '2100' })]), 'control_account_restricted');
    await rejects(bill(co, 'PROBE-4', [L('112.50', { tax: 'RC' })], { amountsIncludeVat: true }), 'reverse_charge_inclusive_not_supported');
    await t((tx) => purchases.discard(tx, { organisationId: org, companyId: co, actor: person(prep), id: d.id, reason: 'Probe only' }));
  });
  it('a bill posts Dr expense / Dr input VAT / Cr payables, with zero, exempt and reverse-charge lines, hand-calculated', async () => {
    const d = await bill(co, 'INV 001', [L('40.00', { qty: '2', tax: 'P' }), L('33.33', { tax: 'Z' }), L('7.00', { tax: 'E' }), L('200.00', { tax: 'RC' })]);
    expect(d.totals).toEqual({ net: '320.33', vat: '10.00', gross: '330.33' }); // reverse charge adds no VAT to what the supplier is owed
    b = await approve(co, d.id);
    expect(b).toMatchObject({ documentNumber: 'BILL-1', paymentStatus: 'UNPAID', outstanding: '330.33', contactSnapshot: { name: 'Widget Supplies Ltd' } });
    expect(linesOf(b.journalId!)).toBe('2100:0.0000/330.3300:- ; 6100:80.0000/0.0000:NET ; 1150:10.0000/0.0000:VAT ; 6100:33.3300/0.0000:NET ; 6100:7.0000/0.0000:NET ; 6100:200.0000/0.0000:NET ; 2200:0.0000/25.0000:RC_OUTPUT ; 1150:25.0000/0.0000:RC_INPUT');
    expect(sql(`SELECT source_type||'|'||source_reference FROM journal WHERE id='${b.journalId}'`)).toBe('PURCHASE_BILL|INV 001');
    const wp = await t((tx) => vat.workpaper(tx, co, { from: '2026-01-01', to: '2026-03-31' }));
    const box = (n: number) => wp.boxes.find((x) => x.box === n)!.amount;
    expect([box(1), box(4), box(6), box(7)]).toEqual(['25.00', '35.00', '0.00', '320.33']);
    expect(sql(`SELECT payload->>'supplierReference' FROM outbox_event WHERE event_type='bill.approved' AND aggregate_id='${b.id}'`)).toBe('INV 001');
  });
  it("the supplier's own number is the duplicate key (case and spaces ignored), as is the same date and total; an override reason is stored", async () => {
    const again = await bill(co, 'inv001', [L('1.00')], { issueDate: '2026-02-11' });
    await rejects(approve(co, again.id), 'possible_duplicate', 409);
    const sameSum = await bill(co, 'INV 002', [L('40.00', { qty: '2', tax: 'P' }), L('33.33', { tax: 'Z' }), L('7.00', { tax: 'E' }), L('200.00', { tax: 'RC' })]);
    await rejects(approve(co, sameSum.id), 'possible_duplicate', 409);
    const ok = await approve(co, again.id, { duplicateOverrideReason: 'The supplier reused its invoice number for a separate delivery' });
    expect(ok).toMatchObject({ documentNumber: 'BILL-2', duplicateOverrideReason: 'The supplier reused its invoice number for a separate delivery' });
    await t((tx) => purchases.discard(tx, { organisationId: org, companyId: co, actor: person(prep), id: sameSum.id, reason: 'Duplicate of BILL-1' }));
  });
  it('separation of duties and permissions; AI never approves', async () => {
    await t((tx) => purchases.setSettings(tx, { organisationId: org, companyId: co, actor: person(prep), payablesAccountId: acc[co]!['2100']!, billPrefix: 'BILL-', debitNotePrefix: 'DN-', billStart: 1, debitNoteStart: 1, requireSeparateApprover: true, reason: 'Second person approves bills' }));
    const d = await bill(co, 'SOD-1', [L('5.00')], { issueDate: '2026-02-12' });
    await rejects(approve(co, d.id, { by: prep }), 'separate_approver_required', 403);
    await rejects(t((tx) => purchases.approve(tx, { organisationId: org, companyId: co, actor: person(appr, ['purchases:approve']), id: d.id })), 'permission_denied', 403);
    await rejects(t((tx) => purchases.approve(tx, { organisationId: org, companyId: co, actor: { kind: 'AI', userId: appr, can: async () => true } as never, id: d.id })), 'ai_cannot_post', 403);
    expect((await approve(co, d.id)).documentNumber).toBe('BILL-3');
  });

  describe('debit notes (V1-MOD-07)', () => {
    it('a full debit note mirrors the bill, reverse-charge pair included, and settles it', async () => {
      const dn = await approve(co, (await debit(co, b.id, { supplierReference: 'CR-77' })).id);
      expect(dn).toMatchObject({ documentNumber: 'DN-1', paymentStatus: 'ALLOCATED', allocations: [{ billId: b.id, amount: '330.3300', realisedFx: '0.00' }] });
      // before the fix the reverse-charge pair was always output-credit / input-debit, whatever the side of the net line
      expect(linesOf(dn.journalId!)).toBe('2100:330.3300/0.0000:- ; 6100:0.0000/80.0000:NET ; 1150:0.0000/10.0000:VAT ; 6100:0.0000/33.3300:NET ; 6100:0.0000/7.0000:NET ; 6100:0.0000/200.0000:NET ; 2200:25.0000/0.0000:RC_OUTPUT ; 1150:0.0000/25.0000:RC_INPUT');
      expect(await t((tx) => purchases.get(tx, co, b.id))).toMatchObject({ paymentStatus: 'PAID', outstanding: '0.00', debitNotes: [{ id: dn.id, documentNumber: 'DN-1' }] });
      const wp = await t((tx) => vat.workpaper(tx, co, { from: '2026-01-01', to: '2026-03-31' }));
      const box = (n: number) => wp.boxes.find((x) => x.box === n)!.amount;
      expect([box(1), box(4), box(7)]).toEqual(['0.00', '0.00', '0.00']); // the debit note cancels BILL-1 in every box; the other bills carry no VAT code
    });
    it('a debit note on a BOTH-direction code reduces INPUT VAT; a debit note cannot exceed the bill or precede it', async () => {
      const bb = await approve(co, (await bill(co, 'BOTH-1', [L('100.00', { tax: 'B' })], { issueDate: '2026-02-13' })).id);
      expect(linesOf(bb.journalId!)).toBe('2100:0.0000/112.5000:- ; 6100:100.0000/0.0000:NET ; 1150:12.5000/0.0000:VAT');
      const dn = await approve(co, (await debit(co, bb.id, { lines: [L('40.00', { tax: 'B' })] })).id);
      expect(linesOf(dn.journalId!)).toBe('2100:45.0000/0.0000:- ; 6100:0.0000/40.0000:NET ; 1150:0.0000/5.0000:VAT');
      const tooMuch = await debit(co, bb.id, { lines: [L('70.00', { tax: 'B' })] });
      await rejects(approve(co, tooMuch.id), 'debit_exceeds_outstanding', 422);
      await rejects(debit(co, bb.id, { issueDate: '2026-02-01', lines: [L('1.00', { tax: 'B' })] }), 'invalid_date');
      await rejects(debit(co, bb.id, { lines: [L('1.00', { tax: 'P' })] }), 'tax_code_not_on_bill');
    });
  });
});

describe('foreign currency, fences and controls', () => {
  it('an EUR bill part-credited at another rate realises the difference (payables are credit-normal: here a loss)', async () => {
    const b = await approve(coF, (await bill(coF, 'EU-1001', [L('1000.00', { company: coF })], { currency: 'EUR', issueDate: '2026-03-02' })).id);
    expect(b).toMatchObject({ functional: { gross: '850.00' } });
    const dn = await approve(coF, (await debit(coF, b.id, { issueDate: '2026-04-01', lines: [L('400.00', { company: coF })] })).id);
    // the bill releases 850 x 400/1000 = 340.00 of the liability; the debit note took 400 x 0.90 = 360.00 off it: 20.00 too much, a loss
    expect(dn.allocations[0]).toMatchObject({ billFunctional: '340.00', debitFunctional: '360.00', realisedFx: '-20.00' });
    expect(linesOf(dn.allocations[0]!.fxJournalId!)).toBe('2100:0.0000/20.0000:- ; 7910:20.0000/0.0000:-');
    expect(await t((tx) => purchases.reconciliation(tx, coF))).toMatchObject({ reconciled: true, currencies: [{ currency: 'EUR', openItems: '600.00', openItemsFunctional: '510.00', difference: '0.00', differenceFunctional: '0.00' }] });
  });
  it('a VAT-registered company does not approve a foreign-currency bill (DEC-031/034); purchase journals are not reversed in the ledger', async () => {
    const d = await bill(co, 'EUR-X', [L('10.00')], { currency: 'EUR', issueDate: '2026-03-02' });
    await rejects(approve(co, d.id), 'vat_foreign_currency_not_supported', 422);
    const any = sql(`SELECT journal_id FROM purchase_document WHERE company_id='${co}' AND status='APPROVED' LIMIT 1`);
    await rejects(t((tx) => new PostingService().reverse(tx, { organisationId: org, companyId: co, journalId: any, reason: 'Trying the ledger route', actor: { kind: 'USER', userId: appr, can: async () => true } })), 'subledger_journal');
  });
  it('a draft bill blocks closing its period unless acknowledged; the payables reconcile', async () => {
    sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${coF}','2025-12-01','2025-12-31')`);
    await bill(coF, 'DEC-DRAFT', [L('3.00', { company: coF })], { issueDate: '2025-12-15' });
    const dec = sql(`SELECT id FROM accounting_period WHERE company_id='${coF}' AND start_date='2025-12-01'`);
    await rejects(t((tx) => new PeriodService().transition(tx, { organisationId: org, companyId: coF, periodId: dec, action: 'close', userId: appr, can: async () => true })), 'unposted_documents', 409);
    expect((await t((tx) => purchases.reconciliation(tx, co))).reconciled).toBe(true);
  });
});
