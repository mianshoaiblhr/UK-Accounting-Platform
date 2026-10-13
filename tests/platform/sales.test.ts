import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database, type Tx } from '@uk/db';
import { AccountService, FxSettingsService, PeriodService, PostingService, RateService, SalesService, VatService, type SalesActor, type SalesLineInput } from '@uk/accounting';
import { adminSql } from '../helpers/db';

/**
 * V1-M5a through the services: drafts, approval (numbering, snapshot, posting, VAT), duplicate and credit-limit checks, separation of duties, credit notes
 * with their invoice's VAT rate, allocation with realised FX, the receivables reconciliation, the sub-ledger fences and the close control.
 * ALL RATES ARE SYNTHETIC (VAT 12.5 % and 15 %; EUR at 0.85 / 0.90): the platform ships none.
 */
let db: Database;
let org: string, prep: string, appr: string, reviewer: string;
let co: string, coF: string, coV: string, coP: string;
const acc: Record<string, Record<string, string>> = {};
const code: Record<string, string> = {};
const cust: Record<string, string> = {};
const sales = new SalesService();
const vat = new VatService();
const posting = new PostingService();
const sql = adminSql;
const t = <T>(fn: (tx: Tx) => Promise<T>) => db.tenant({ organisationId: org, userId: prep }, fn);
const person = (userId: string, deny: string[] = []): SalesActor => ({ userId, kind: 'USER', can: async (p) => !deny.includes(p) });
const rejects = (p: Promise<unknown>, c: string, status?: number) => expect(p).rejects.toMatchObject({ code: c, ...(status ? { status } : {}) });
const src = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026, s.1 (test fixture, not a real rule)', retrievedOn: '2026-01-01' };
const L = (company: string, a: string, unitPrice: string, o: { qty?: string; tax?: string; desc?: string } = {}): SalesLineInput =>
  ({ description: o.desc ?? `Line on ${a}`, quantity: o.qty ?? '1', unitPrice, accountId: acc[company]![a]!, ...(o.tax ? { taxCodeId: code[o.tax] } : {}) });
const draft = (company: string, lines: SalesLineInput[], o: Partial<Parameters<SalesService['createInvoice']>[1]> = {}) =>
  t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: company, actor: person(prep), customerRoleId: cust[company]!, issueDate: '2026-02-10', amountsIncludeVat: false, lines, ...o }));
const approve = (company: string, id: string, o: { by?: string; duplicateOverrideReason?: string; creditLimitOverrideReason?: string } = {}) =>
  t((tx) => sales.approve(tx, { organisationId: org, companyId: company, actor: person(o.by ?? appr), id, duplicateOverrideReason: o.duplicateOverrideReason, creditLimitOverrideReason: o.creditLimitOverrideReason }));
const credit = (company: string, invoiceId: string, o: Partial<Parameters<SalesService['createCreditNote']>[1]> = {}) =>
  t((tx) => sales.createCreditNote(tx, { organisationId: org, companyId: company, actor: person(prep), originalInvoiceId: invoiceId, issueDate: '2026-02-20', reason: 'Goods returned by the customer', ...o }));
const linesOf = (journalId: string) => sql(`SELECT string_agg(a.code||':'||l.debit||'/'||l.credit||':'||coalesce(l.vat_role,'-'), ' ; ' ORDER BY l.line_no) FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.journal_id='${journalId}'`);

async function defineCode(company: string, c: string, treatment: string, direction: string, versions: { rate: string; from: string; to?: string }[], netBoxes = [6], vatBoxes = [1]) {
  const tc = await t((tx) => vat.createCode(tx, { organisationId: org, companyId: company, actor: person(prep), code: c, name: `Synthetic ${c}`, treatment: treatment as never, direction: direction as never, reverseCharge: false }));
  code[c] = tc.id;
  for (const v of versions) {
    const r = await t((tx) => vat.addRate(tx, { organisationId: org, companyId: company, actor: person(prep), taxCodeId: tc.id, rate: v.rate, effectiveFrom: v.from, effectiveTo: v.to, netBoxes, vatBoxes: treatment === 'STANDARD' ? vatBoxes : [], source: src }));
    await t((tx) => vat.verifyRate(tx, { organisationId: org, companyId: company, actor: person(reviewer), id: r.id, notes: 'Synthetic fixture checked against the test source' }));
  }
}
function customer(company: string, name: string, o: { limit?: string; terms?: number } = {}) {
  const contact = sql(`INSERT INTO contact(organisation_id, kind, name, created_by_user_id) VALUES ('${org}','ORGANISATION','${name}','${prep}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO address(organisation_id, contact_id, kind, line1, city, postcode, country_code, is_primary) VALUES ('${org}','${contact}','TRADING','1 Synthetic Street','Testtown','TE1 1ST','GB',true)`);
  const role = sql(`INSERT INTO contact_role(organisation_id, company_id, contact_id, role, account_code, created_by_user_id) VALUES ('${org}','${company}','${contact}','CUSTOMER','C-${name.slice(0, 6).replace(/\W/g, '')}','${prep}') RETURNING id`).split('\n')[0]!;
  sql(`INSERT INTO customer_profile(role_id, organisation_id, company_id, payment_terms_days, credit_limit) VALUES ('${role}','${org}','${company}',${o.terms ?? 30},${o.limit ?? 'NULL'})`);
  return { role, contact };
}

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  const user = (n: string) => sql(`INSERT INTO "user"(email, display_name) VALUES ('sal-${n}-${org}@t.test','${n}') RETURNING id`).split('\n')[0]!;
  prep = user('prep'); appr = user('appr'); reviewer = user('rev');
  sql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Sales services')`);
  const mk = (n: string) => sql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','${n}') RETURNING id`).split('\n')[0]!;
  co = mk('Sales Co'); coF = mk('Sales FX Co'); coV = mk('Sales VAT-change Co'); coP = mk('Sales Close Co');
  const accounts = new AccountService();
  for (const c of [co, coF, coV, coP]) {
    if (c === coP) for (let m = 1; m <= 3; m++) sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','2026-0${m}-01',(date '2026-0${m}-01' + interval '1 month' - interval '1 day')::date)`);
    else sql(`INSERT INTO accounting_period(organisation_id, company_id, start_date, end_date) VALUES ('${org}','${c}','2026-01-01','2026-12-31')`);
    acc[c] = {};
    for (const a of (await t((tx) => accounts.initialiseDefault(tx, { organisationId: org, companyId: c, userId: prep }))).items) acc[c]![a.code] = a.id;
    for (const [codeNo, name] of [['7900', 'FX rounding'], ['7910', 'Realised FX'], ['7920', 'Unrealised FX']]) {
      acc[c]![codeNo] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: prep, input: { code: codeNo, name, type: 'EXPENSE', subtype: 'OTHER_EXPENSE', isControl: false, controlKind: null, taxTreatment: 'NOT_APPLICABLE', reportingMapping: 'PL.OTHER_EXPENSES', activeFrom: null, activeTo: null } }))).id;
    }
    await t((tx) => new FxSettingsService().set(tx, { organisationId: org, companyId: c, actor: { ...person(prep), kind: 'USER' }, roundingAccountId: acc[c]!['7900']!, realisedAccountId: acc[c]!['7910']!, unrealisedAccountId: acc[c]!['7920']!, defaultSeries: {}, reason: 'FX accounts for the sales tests' }));
    acc[c]!['1150'] = (await t((tx) => accounts.create(tx, { organisationId: org, companyId: c, userId: prep, input: { code: '1150', name: 'VAT recoverable', type: 'ASSET', subtype: 'CURRENT_ASSET_VAT', isControl: false, controlKind: null, taxTreatment: 'VAT_CONTROL', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS', activeFrom: null, activeTo: null } }))).id;
  }
  await defineCode(co, 'S', 'STANDARD', 'SALES', [{ rate: '12.5', from: '2026-01-01' }]);
  await defineCode(co, 'Z', 'ZERO', 'SALES', [{ rate: '0', from: '2026-01-01' }]);
  await defineCode(co, 'E', 'EXEMPT', 'SALES', [{ rate: '0', from: '2026-01-01' }]);
  await defineCode(co, 'P', 'STANDARD', 'PURCHASES', [{ rate: '12.5', from: '2026-01-01' }], [7], [4]);
  await defineCode(co, 'R', 'STANDARD', 'SALES', [{ rate: '12.5', from: '2026-01-01', to: '2026-06-30' }, { rate: '15', from: '2026-07-01' }]);
  for (const c of [co, coV]) await t((tx) => vat.setSettings(tx, { organisationId: org, companyId: c, actor: person(prep), registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', scheme: 'STANDARD',
    periodMonths: 3, anchorPeriodEnd: '2026-03-31', outputAccountId: acc[c]!['2200']!, inputAccountId: acc[c]!['1150']!, reason: 'Registered for VAT from 1 January (synthetic)' }));
  // exchange rates are organisation reference data (shared by the companies of the organisation)
  for (const [date, rate] of [['2026-03-02', '0.85'], ['2026-04-01', '0.90']] as const) await t((tx) => new RateService().create(tx, { organisationId: org, companyId: coF, actor: person(prep), fromCurrency: 'EUR', kind: 'DAILY', validFrom: date, rate, source: 'synthetic test rate' }));
  cust[co] = customer(co, 'Acme Retail Ltd', { limit: '1000' }).role;
  cust[coF] = customer(coF, 'Euro Buyer GmbH').role;
  cust[coV] = customer(coV, 'Rate Change Ltd').role;
  cust[coP] = customer(coP, 'Close Control Ltd').role;
  for (const c of [coF, coV, coP]) await t((tx) => sales.setSettings(tx, { organisationId: org, companyId: c, actor: person(prep), receivablesAccountId: acc[c]!['1100']!, invoicePrefix: 'INV-', creditNotePrefix: 'CN-', invoiceStart: 1, creditNoteStart: 1, requireSeparateApprover: false, reason: 'Sales settings for the tests' }));
});
afterAll(() => db.close());

describe('settings', () => {
  it('approval needs a receivables control account; only a TRADE_RECEIVABLES control account qualifies; ledger:policy is required', async () => {
    const d = await draft(co, [L(co, '4000', '10.00')]);
    await rejects(approve(co, d.id), 'sales_settings_missing', 422);
    const base = { organisationId: org, companyId: co, invoicePrefix: 'SI-', creditNotePrefix: 'SC-', invoiceStart: 1001, creditNoteStart: 1, requireSeparateApprover: false, reason: 'Configure sales for the company' };
    await rejects(t((tx) => sales.setSettings(tx, { ...base, actor: person(prep), receivablesAccountId: acc[co]!['1110']! })), 'receivables_account_invalid', 422);
    await rejects(t((tx) => sales.setSettings(tx, { ...base, actor: person(prep, ['ledger:policy']), receivablesAccountId: acc[co]!['1100']! })), 'permission_denied', 403);
    const s = await t((tx) => sales.setSettings(tx, { ...base, actor: person(prep), receivablesAccountId: acc[co]!['1100']! }));
    expect(s).toMatchObject({ receivablesAccountId: acc[co]!['1100'], invoicePrefix: 'SI-', invoiceStart: 1001, numberingFrozen: { invoice: false } });
    await t((tx) => sales.discard(tx, { organisationId: org, companyId: co, actor: person(prep), id: d.id, reason: 'Probe draft only' }));
  });
});

describe('drafts', () => {
  it('a draft has no number and no ledger effect; due date from the customer terms; amounts are previewed per line', async () => {
    const d = await draft(co, [L(co, '4000', '40.00', { qty: '2', tax: 'S' }), L(co, '4010', '33.33', { tax: 'Z' })]);
    expect(d).toMatchObject({ status: 'DRAFT', number: null, documentNumber: null, journalId: null, dueDate: '2026-03-12', currency: 'GBP', revision: 1,
      totals: { net: '113.33', vat: '10.00', gross: '123.33' }, paymentStatus: null, warnings: [] });
    expect(sql(`SELECT count(*) FROM journal WHERE source_id='${d.id}'`)).toBe('0');
  });
  it('lines must be valid: a purchase VAT code, a control account or a VAT account are refused', async () => {
    await rejects(draft(co, [L(co, '4000', '10.00', { tax: 'P' })]), 'tax_code_direction');
    await rejects(draft(co, [L(co, '1100', '10.00')]), 'control_account_restricted');
    await rejects(draft(co, [L(co, '1150', '10.00')]), 'system_account_restricted');
    await rejects(draft(co, [L(co, '4000', '10.00')], { actor: person(prep, ['sales:manage']) } as never), 'permission_denied', 403);
  });
  it('editing needs the current revision and writes a new revision of the lines (the old one is kept); a discarded draft is final', async () => {
    const d = await draft(co, [L(co, '4000', '10.00')]);
    const u = await t((tx) => sales.updateDraft(tx, { organisationId: org, companyId: co, actor: person(prep), id: d.id, revision: 1, lines: [L(co, '4000', '20.00'), L(co, '4000', '5.00')] }));
    expect(u).toMatchObject({ revision: 2, totals: { gross: '25.00' } });
    expect(sql(`SELECT count(*) FROM sales_document_line WHERE document_id='${d.id}'`)).toBe('3');
    await rejects(t((tx) => sales.updateDraft(tx, { organisationId: org, companyId: co, actor: person(prep), id: d.id, revision: 1, notes: 'stale' })), 'stale_revision', 409);
    await t((tx) => sales.discard(tx, { organisationId: org, companyId: co, actor: person(prep), id: d.id, reason: 'Raised in error' }));
    await rejects(approve(co, d.id), 'document_not_draft', 409);
    await rejects(t((tx) => sales.updateDraft(tx, { organisationId: org, companyId: co, actor: person(prep), id: d.id, revision: 2, notes: 'late' })), 'document_not_draft', 409);
  });
});

describe('approval', () => {
  let inv: Awaited<ReturnType<typeof draft>>;
  it('posts Dr receivables / Cr revenue / Cr output VAT, numbers from the start number, snapshots the customer and publishes InvoiceCreated (V1-EX-01)', async () => {
    const d = await draft(co, [L(co, '4000', '40.00', { qty: '2', tax: 'S' }), L(co, '4010', '33.33', { tax: 'Z' }), L(co, '4010', '7.00', { tax: 'E' })], { customerReference: 'PO-77' });
    inv = await approve(co, d.id);
    expect(inv).toMatchObject({ status: 'APPROVED', number: 1001, documentNumber: 'SI-1001', paymentStatus: 'UNPAID', totals: { net: '120.33', vat: '10.00', gross: '130.33' }, outstanding: '130.33',
      functional: { gross: '130.33', outstanding: '130.33' }, approvedByUserId: appr, contactSnapshot: { name: 'Acme Retail Ltd', address: { postcode: 'TE1 1ST' } } });
    expect(linesOf(inv.journalId!)).toBe('1100:130.3300/0.0000:- ; 4000:0.0000/80.0000:NET ; 2200:0.0000/10.0000:VAT ; 4010:0.0000/33.3300:NET ; 4010:0.0000/7.0000:NET');
    expect(sql(`SELECT source_type||'|'||source_id||'|'||source_reference FROM journal WHERE id='${inv.journalId}'`)).toBe(`SALES_INVOICE|${inv.id}|SI-1001`);
    expect(sql(`SELECT payload->>'documentNumber' FROM outbox_event WHERE event_type='invoice.created' AND aggregate_id='${inv.id}'`)).toBe('SI-1001');
  });
  it('the snapshot survives a later edit of the contact (V1-CON-04)', async () => {
    sql(`UPDATE contact SET name='Acme Renamed plc' WHERE id=(SELECT contact_id FROM contact_role WHERE id='${cust[co]}')`);
    const again = await t((tx) => sales.get(tx, co, inv.id));
    expect(again.contactSnapshot).toMatchObject({ name: 'Acme Retail Ltd' });
    sql(`UPDATE contact SET name='Acme Retail Ltd' WHERE id=(SELECT contact_id FROM contact_role WHERE id='${cust[co]}')`);
  });
  it('VAT-inclusive entry takes the VAT fraction out of the gross', async () => {
    const d = await draft(co, [L(co, '4000', '112.50', { tax: 'S' })], { amountsIncludeVat: true, issueDate: '2026-02-11' });
    const a = await approve(co, d.id);
    expect(a).toMatchObject({ number: 1002, totals: { net: '100.00', vat: '12.50', gross: '112.50' } });
    expect(linesOf(a.journalId!)).toBe('1100:112.5000/0.0000:- ; 4000:0.0000/100.0000:NET ; 2200:0.0000/12.5000:VAT');
  });
  it('a possible duplicate (same customer, date and total, or the same customer reference) needs a reason, which is stored', async () => {
    const same = await draft(co, [L(co, '4000', '40.00', { qty: '2', tax: 'S' }), L(co, '4010', '33.33', { tax: 'Z' }), L(co, '4010', '7.00', { tax: 'E' })]);
    await rejects(approve(co, same.id), 'possible_duplicate', 409);
    const byRef = await draft(co, [L(co, '4000', '1.00')], { customerReference: 'PO-77', issueDate: '2026-02-12' });
    await rejects(approve(co, byRef.id), 'possible_duplicate', 409);
    const ok = await approve(co, same.id, { duplicateOverrideReason: 'Second identical delivery on the same day, confirmed with the customer' });
    expect(ok).toMatchObject({ number: 1003, duplicateOverrideReason: 'Second identical delivery on the same day, confirmed with the customer' });
    await t((tx) => sales.discard(tx, { organisationId: org, companyId: co, actor: person(prep), id: byRef.id, reason: 'Duplicate of SI-1001' }));
  });
  it('a refused approval consumes no number: numbers stay without gaps', async () => {
    const n = await approve(co, (await draft(co, [L(co, '4000', '3.00')], { issueDate: '2026-02-13' })).id);
    expect(n.number).toBe(1004);
  });
  it('the credit limit (company currency, open balance including this invoice) needs a reason to exceed', async () => {
    // open so far: 130.33 + 112.50 + 130.33 + 3.00 = 376.16; limit 1000
    const big = await draft(co, [L(co, '4000', '700.00')], { issueDate: '2026-02-14' });
    await rejects(approve(co, big.id), 'credit_limit_exceeded', 409);
    const a = await approve(co, big.id, { creditLimitOverrideReason: 'Approved by the credit controller for the seasonal order' });
    expect(a).toMatchObject({ number: 1005, creditLimitOverrideReason: 'Approved by the credit controller for the seasonal order' });
    sql(`UPDATE customer_profile SET credit_limit = NULL WHERE role_id='${cust[co]}'`); // no limit for the remaining tests
  });
  it('separation of duties: with the policy on, the preparer cannot approve; AI and people without sales:approve never approve', async () => {
    // policy off: the preparer may approve their own draft
    expect((await approve(co, (await draft(co, [L(co, '4000', '5.00')], { issueDate: '2026-02-15' })).id, { by: prep })).number).toBe(1006);
    await t((tx) => sales.setSettings(tx, { organisationId: org, companyId: co, actor: person(prep), receivablesAccountId: acc[co]!['1100']!, invoicePrefix: 'SI-', creditNotePrefix: 'SC-', invoiceStart: 1001, creditNoteStart: 1, requireSeparateApprover: true, reason: 'Second person approves sales' }));
    const d2 = await draft(co, [L(co, '4000', '6.00')], { issueDate: '2026-02-16' });
    await rejects(approve(co, d2.id, { by: prep }), 'separate_approver_required', 403);
    await rejects(t((tx) => sales.approve(tx, { organisationId: org, companyId: co, actor: { kind: 'AI', userId: appr, can: async () => true } as never, id: d2.id })), 'ai_cannot_post', 403);
    await rejects(t((tx) => sales.approve(tx, { organisationId: org, companyId: co, actor: person(appr, ['sales:approve']), id: d2.id })), 'permission_denied', 403);
    expect((await approve(co, d2.id, { by: appr })).number).toBe(1007);
  });
  it('numbering is frozen once an invoice is approved', async () => {
    await rejects(t((tx) => sales.setSettings(tx, { organisationId: org, companyId: co, actor: person(prep), receivablesAccountId: acc[co]!['1100']!, invoicePrefix: 'X-', creditNotePrefix: 'SC-', invoiceStart: 1001, creditNoteStart: 1, requireSeparateApprover: true, reason: 'Try to renumber' })), 'numbering_frozen', 409);
  });
  it('concurrent approvals take consecutive numbers', async () => {
    const ds = [];
    for (let i = 0; i < 5; i++) ds.push(await draft(co, [L(co, '4000', `${10 + i}.00`)], { issueDate: '2026-03-0' + (i + 1) }));
    const res = await Promise.all(ds.map((d) => approve(co, d.id)));
    expect(res.map((r) => r.number).sort((x, y) => x! - y!)).toEqual([1008, 1009, 1010, 1011, 1012]);
    expect(sql(`SELECT max(number)-min(number)+1 = count(*) FROM sales_document WHERE company_id='${co}' AND kind='INVOICE' AND number IS NOT NULL`)).toBe('t');
  });
});

describe('credit notes', () => {
  let inv: Awaited<ReturnType<typeof draft>>;
  it('a full credit mirrors the invoice, is allocated to it and settles it (V1-MOD-06, V1-EX-05)', async () => {
    inv = await approve(co, (await draft(co, [L(co, '4000', '200.00', { tax: 'S' })], { issueDate: '2026-02-18' })).id);
    const cn = await credit(co, inv.id);
    expect(cn).toMatchObject({ kind: 'CREDIT_NOTE', status: 'DRAFT', totals: { net: '200.00', vat: '25.00', gross: '225.00' }, originalInvoiceId: inv.id });
    const a = await approve(co, cn.id);
    expect(a).toMatchObject({ documentNumber: 'SC-1', paymentStatus: 'ALLOCATED', outstanding: '0.00', allocations: [{ invoiceId: inv.id, creditId: cn.id, amount: '225.0000', realisedFx: '0.00', fxJournalId: null }] });
    expect(linesOf(a.journalId!)).toBe('1100:0.0000/225.0000:- ; 4000:200.0000/0.0000:NET ; 2200:25.0000/0.0000:VAT');
    expect(await t((tx) => sales.get(tx, co, inv.id))).toMatchObject({ paymentStatus: 'PAID', outstanding: '0.00', creditNotes: [{ id: cn.id, documentNumber: 'SC-1' }] });
    expect(sql(`SELECT payload->>'originalInvoiceId' FROM outbox_event WHERE event_type='credit_note.created' AND aggregate_id='${cn.id}'`)).toBe(inv.id);
  });
  it('a credit cannot exceed what is outstanding, use another VAT code, precede its invoice, or credit a draft', async () => {
    const i2 = await approve(co, (await draft(co, [L(co, '4000', '100.00', { tax: 'S' })], { issueDate: '2026-02-19' })).id);
    const part = await approve(co, (await credit(co, i2.id, { lines: [L(co, '4000', '40.00', { tax: 'S', desc: 'Part credit' })] })).id);
    expect(part).toMatchObject({ totals: { gross: '45.00' } });
    expect(await t((tx) => sales.get(tx, co, i2.id))).toMatchObject({ paymentStatus: 'PART_PAID', outstanding: '67.50' });
    const tooMuch = await credit(co, i2.id, { lines: [L(co, '4000', '70.00', { tax: 'S' })] });
    expect(tooMuch.warnings.join(' ')).toMatch(/exceeds what is outstanding/);
    await rejects(approve(co, tooMuch.id), 'credit_exceeds_outstanding', 422);
    await rejects(credit(co, i2.id, { lines: [L(co, '4000', '10.00', { tax: 'Z' })] }), 'tax_code_not_on_invoice');
    await rejects(credit(co, i2.id, { issueDate: '2026-02-01' }), 'invalid_date');
    await rejects(credit(co, i2.id), 'credit_lines_required');
    const dr = await draft(co, [L(co, '4000', '1.00')]);
    await rejects(credit(co, dr.id), 'invoice_not_approved');
  });
  it('the credit note takes the VAT rate version its invoice used, at its own tax point (DEC-029)', async () => {
    await t((tx) => sales.setSettings(tx, { organisationId: org, companyId: coV, actor: person(prep), receivablesAccountId: acc[coV]!['1100']!, invoicePrefix: 'INV-', creditNotePrefix: 'CN-', invoiceStart: 1, creditNoteStart: 1, requireSeparateApprover: false, reason: 'Sales settings for the rate-change company' }));
    const i = await t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: coV, actor: person(prep), customerRoleId: cust[coV]!, issueDate: '2026-06-15', amountsIncludeVat: false, lines: [L(coV, '4000', '100.00', { tax: 'R' })] }));
    const ia = await approve(coV, i.id);
    expect(ia.totals).toMatchObject({ vat: '12.50' });
    const cn = await credit(coV, ia.id, { issueDate: '2026-07-10' });
    expect(cn.totals).toMatchObject({ vat: '12.50', gross: '112.50' }); // not the 15 % in force on 10 July
    const ca = await approve(coV, cn.id);
    expect(sql(`SELECT tax_point||'|'||vat_rate_point FROM journal_line WHERE journal_id='${ca.journalId}' AND vat_role='VAT'`)).toBe('2026-07-10|2026-06-15');
    const wp = await t((tx) => vat.workpaper(tx, coV, { from: '2026-07-01', to: '2026-09-30' }));
    expect(wp.boxes.find((b) => b.box === 1)!.amount).toBe('-12.50');
  });
});

describe('foreign currency and realised FX on allocation (DEC-030, DEC-031)', () => {
  it('a VAT-registered company prepares but does not approve a foreign-currency sale; VAT codes on it are refused', async () => {
    await rejects(draft(co, [L(co, '4000', '10.00', { tax: 'S' })], { currency: 'EUR', issueDate: '2026-03-02' }), 'vat_foreign_currency_not_supported');
    const d = await draft(co, [L(co, '4000', '10.00')], { currency: 'EUR', issueDate: '2026-03-02' });
    await rejects(approve(co, d.id), 'vat_foreign_currency_not_supported', 422);
  });
  it('a company that is not VAT registered invoices in EUR; a credit note at another rate realises the difference exactly', async () => {
    const inv = await approve(coF, (await draft(coF, [L(coF, '4000', '1000.00')], { currency: 'EUR', issueDate: '2026-03-02' })).id);
    expect(inv).toMatchObject({ currency: 'EUR', totals: { gross: '1000.00' }, functional: { gross: '850.00' }, rate: '0.85000000' });
    const cn = await approve(coF, (await credit(coF, inv.id, { issueDate: '2026-04-01', lines: [L(coF, '4000', '400.00')] })).id);
    // invoice releases 850 x 400/1000 = 340.00; the credit carries 400 x 0.90 = 360.00; the 20.00 difference is a realised gain
    expect(cn.allocations[0]).toMatchObject({ amount: '400.0000', invoiceFunctional: '340.00', creditFunctional: '360.00', realisedFx: '20.00' });
    expect(linesOf(cn.allocations[0]!.fxJournalId!)).toBe('7910:0.0000/20.0000:- ; 1100:20.0000/0.0000:-');
    expect(sql(`SELECT adjusts_currency FROM journal_line WHERE journal_id='${cn.allocations[0]!.fxJournalId}' AND line_no=2`)).toBe('EUR');
    expect(await t((tx) => sales.get(tx, coF, inv.id))).toMatchObject({ outstanding: '600.00', functional: { outstanding: '510.00' }, paymentStatus: 'PART_PAID' });
    const rec = await t((tx) => sales.reconciliation(tx, coF));
    expect(rec).toMatchObject({ reconciled: true, currencies: [{ currency: 'EUR', openItems: '600.00', openItemsFunctional: '510.00', control: { fromSalesDocuments: '600.00', fromSalesDocumentsFunctional: '510.00' }, difference: '0.00', differenceFunctional: '0.00' }] });
  });
  it('a full settlement leaves no residue on either side', async () => {
    const inv = await approve(coF, (await draft(coF, [L(coF, '4000', '333.33')], { currency: 'EUR', issueDate: '2026-03-02' })).id);
    const cn = await approve(coF, (await credit(coF, inv.id, { issueDate: '2026-04-01' })).id);
    // 333.33 x 0.85 = 283.33 (rounded) carried; 333.33 x 0.90 = 300.00 credited; difference 16.67 realised
    expect(cn.allocations[0]).toMatchObject({ invoiceFunctional: '283.33', creditFunctional: '300.00', realisedFx: '16.67' });
    expect(await t((tx) => sales.get(tx, coF, inv.id))).toMatchObject({ outstanding: '0.00', functional: { outstanding: '0.00' }, paymentStatus: 'PAID' });
    expect((await t((tx) => sales.reconciliation(tx, coF))).reconciled).toBe(true);
  });
});

describe('fences around the sub-ledger', () => {
  it('a sales journal is corrected with a credit note, never reversed in the ledger (service and database)', async () => {
    const inv = await approve(coF, (await draft(coF, [L(coF, '4000', '1.00')], { issueDate: '2026-03-10' })).id);
    await rejects(t((tx) => posting.reverse(tx, { organisationId: org, companyId: coF, journalId: inv.journalId!, reason: 'Trying to reverse an invoice', actor: { kind: 'USER', userId: appr, can: async () => true } })), 'subledger_journal', 422);
    await expect(t((tx) => posting.post(tx, { organisationId: org, companyId: coF, journalDate: '2026-03-11', sourceType: 'REVERSAL', sourceId: inv.journalId!, reversesJournalId: inv.journalId!, description: 'Direct reversal',
      lines: [{ accountId: acc[coF]!['4000']!, debit: '1.00', credit: '0' }, { accountId: acc[coF]!['1100']!, debit: '0', credit: '1.00' }], idempotencyKey: `k-${uuidv7()}`, actor: { kind: 'USER', userId: appr, can: async () => true } }))).rejects.toThrow(/corrected in the sales ledger/);
  });
  it('sales journals reach trade receivables and no other control account', async () => {
    await rejects(t((tx) => posting.post(tx, { organisationId: org, companyId: coF, journalDate: '2026-03-11', sourceType: 'SALES_INVOICE', sourceId: uuidv7(), description: 'Probe',
      lines: [{ accountId: acc[coF]!['1200']!, debit: '1.00', credit: '0' }, { accountId: acc[coF]!['4000']!, debit: '0', credit: '1.00' }], idempotencyKey: `k-${uuidv7()}`, actor: { kind: 'USER', userId: appr, can: async () => true } })), 'control_account_restricted');
  });
  it('closing a period with drafts dated in it needs an acknowledgement, recorded on the audit event (MAN-ACC-08)', async () => {
    const janDraft = await t((tx) => sales.createInvoice(tx, { organisationId: org, companyId: coP, actor: person(prep), customerRoleId: cust[coP]!, issueDate: '2026-01-20', amountsIncludeVat: false, lines: [L(coP, '4000', '9.00')] }));
    const jan = sql(`SELECT id FROM accounting_period WHERE company_id='${coP}' AND start_date='2026-01-01'`);
    const periods = new PeriodService();
    const close = (ack: boolean) => t((tx) => periods.transition(tx, { organisationId: org, companyId: coP, periodId: jan, action: 'close', userId: appr, acknowledgeDraftDocuments: ack, can: async () => true }));
    await rejects(close(false), 'unposted_documents', 409);
    expect((await close(true)).status).toBe('CLOSED');
    expect(sql(`SELECT metadata->>'acknowledgedDraftDocuments' FROM audit_event WHERE entity_id='${jan}' AND action='period.closed'`)).toBe('1');
    // period lock: the draft dated in the closed period cannot be approved (and takes no number)
    await rejects(approve(coP, janDraft.id), 'period_closed', 422);
    expect(sql(`SELECT count(*) FROM sales_sequence WHERE company_id='${coP}'`)).toBe('0');
  });
  it('an AI-proposed draft: only from an ACCEPTED sales_invoice proposal of the company, and approved only by a person', async () => {
    const mk = (status: string, kind = 'sales_invoice') => sql(`INSERT INTO ai_proposal(organisation_id, company_id, kind, payload, status) VALUES ('${org}','${coF}','${kind}','{}','${status}') RETURNING id`).split('\n')[0]!;
    await rejects(draft(coF, [L(coF, '4000', '2.00')], { aiProposalId: mk('SUGGESTED') }), 'proposal_not_accepted');
    await rejects(draft(coF, [L(coF, '4000', '2.00')], { aiProposalId: mk('ACCEPTED', 'bank_match') }), 'proposal_kind_invalid');
    const d = await draft(coF, [L(coF, '4000', '2.00')], { aiProposalId: mk('ACCEPTED'), issueDate: '2026-03-12' });
    expect(d).toMatchObject({ origin: 'AI_PROPOSAL', createdByUserId: prep });
    await rejects(t((tx) => sales.approve(tx, { organisationId: org, companyId: coF, actor: { kind: 'AI', userId: prep, can: async () => true } as never, id: d.id })), 'ai_cannot_post', 403);
    expect((await approve(coF, d.id)).status).toBe('APPROVED');
  });
  it('the GBP receivables reconcile; isolation: another company cannot see the document', async () => {
    const rec = await t((tx) => sales.reconciliation(tx, co));
    expect(rec.reconciled).toBe(true);
    expect(rec.currencies.map((c) => c.currency)).toEqual(['GBP']);
    const any = sql(`SELECT id FROM sales_document WHERE company_id='${co}' LIMIT 1`);
    await rejects(t((tx) => sales.get(tx, coF, any)), 'not_found', 404);
  });
});
