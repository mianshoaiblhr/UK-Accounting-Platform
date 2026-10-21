import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V2-M6b through the public API (v2-plan 5i.4): the golden year-end workflow (DEC-054, DEC-069) phase by phase, the refusals, permissions and tenancy. Synthetic data only. */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m6b-workflow.json'), 'utf8')) as Record<string, any>;
const L = JSON.parse(readFileSync(resolve(__dirname, '..', '..', G.linesFrom), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };
const S = G.setup, Y = G.year.yearStart;

let s: Stack;
let owner: TestUser, partner: TestUser, author: TestUser, accountant: TestUser, reviewer: TestUser, outsider: TestUser;
let company: { id: string };
let invoiceId: string, supplier: string;
const acc: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const workflow = async (u = reviewer) => ok(await as(u, 'get', c(`/year-end-workflow?yearStart=${Y}`)));
const signOff = (step: number, u = accountant) => as(u, 'post', c('/year-end-workflow/sign-off'), { yearStart: Y, step, note: `Step ${step} reviewed (synthetic)` });
const phase = async (i: number) => {
  const p = G.phases[i], w = await workflow();
  expect(w.steps.map((x: any) => [x.control.status, x.state]), p.name).toEqual(p.steps);
  expect(w.current, p.name).toBe(p.current);
  return w;
};

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, G.company.name);
  partner = await addMember(s, owner, 'partner');
  author = await addMember(s, owner, 'admin');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  ok(await as(owner, 'post', c('/periods'), { startDate: Y, endDate: G.year.yearEnd }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  acc['6950'] = ok(await as(owner, 'post', c('/accounts'), { code: '6950', name: 'Profit or loss on disposal of fixed assets', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', reportingMapping: 'PL.OTHER_EXPENSES' }), 201).id;
  ok(await as(owner, 'put', c('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Receivables control (synthetic)' }));
  ok(await as(owner, 'put', c('/purchase-settings'), { payablesAccountId: acc['2100'], reason: 'Payables control (synthetic)' }));
  const party = async (name: string, role: string, code: string) => ok(await as(owner, 'post', c('/contact-roles'), { contactId: ok(await as(owner, 'post', '/contacts', { kind: 'ORGANISATION', name }), 201).id, role, accountCode: code }), 201).id;
  const customer = await party(G.company.customer, 'CUSTOMER', 'YEC01');
  supplier = await party(G.company.supplier, 'SUPPLIER', 'YES01');
  // the laptops, bought from the bank and added to the register from that payment; the shares received
  const a = S.asset, k = a.class;
  const payment = ok(await as(accountant, 'post', c('/cash-transactions'), { direction: 'PAYMENT', transactionDate: a.acquiredOn, bankAccountId: acc['1200'], description: a.description,
    lines: [{ description: a.description, accountId: acc[k.costAccount], amount: a.cost }] }), 201);
  ok(await as(accountant, 'post', c('/cash-transactions'), { direction: 'RECEIPT', transactionDate: S.shares.date, bankAccountId: acc['1200'], description: 'Shares issued',
    lines: [{ description: 'Shares issued', accountId: acc['3000'], amount: S.shares.amount }] }), 201);
  const classId = ok(await as(accountant, 'post', c('/fixed-asset-classes'), { code: k.code, name: k.name, costAccountId: acc[k.costAccount], depreciationAccountId: acc[k.depreciationAccount],
    expenseAccountId: acc[k.expenseAccount], disposalAccountId: acc[k.disposalAccount], method: k.method, lifeMonths: k.lifeMonths, convention: k.convention }), 201).id;
  ok(await as(accountant, 'post', c('/fixed-assets'), { classId, description: a.description, acquiredOn: a.acquiredOn, cost: a.cost, addition: { kind: 'LINKED', journalId: payment.journalId } }), 201);
  // the draft invoice (not approved)
  const d = S.draftInvoice;
  invoiceId = ok(await as(accountant, 'post', c('/sales/invoices'), { customerRoleId: customer, issueDate: d.issueDate, dueDate: d.dueDate,
    lines: [{ description: 'Synthetic', quantity: '1', unitPrice: d.amount, accountId: acc[d.account], taxCodeId: null }] }), 201).id;
  // a verified synthetic version naming its turnover line, the framework year, verified thresholds and the size facts
  const standardId = ok(await as(author, 'post', c('/reporting-standards'), { code: 'SYN-YE', name: 'Synthetic workflow standard' }), 201).id;
  const versionId = ok(await as(author, 'post', c(`/reporting-standards/${standardId}/versions`), { label: 'Synthetic workflow v1', effectiveFrom: '2020-01-01',
    source: { url: 'https://example.test/synthetic-workflow', provision: 'Synthetic test content', retrievedOn: '2026-10-21' } }), 201).id;
  const v = c(`/reporting-standard-versions/${versionId}`);
  for (const l of L.lines) ok(await as(author, 'post', `${v}/lines`, l), 201);
  for (const [sourceLine, accountSubtype, targetKey] of L.mapEntries) ok(await as(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey }), 201);
  ok(await as(author, 'patch', v, { turnoverLineKey: 'P.T' }));
  ok(await as(owner, 'post', `${v}/verify`, { notes: 'Synthetic version checked for the workflow golden' }));
  ok(await as(accountant, 'put', c('/reporting-frameworks'), { yearStart: Y, yearEnd: G.year.yearEnd, versionId, entitySize: G.year.entitySize, reason: 'Synthetic' }));
  const set = ok(await as(author, 'post', c('/size-threshold-sets'), { ...S.thresholds, source: { url: 'https://example.test/synthetic-limits', provision: 'Synthetic test limits', retrievedOn: '2026-10-21' } }), 201);
  ok(await as(owner, 'post', c(`/size-threshold-sets/${set.id}/verify`), { notes: 'Synthetic limits checked for the workflow golden' }));
  for (const [key, value] of S.facts) ok(await as(accountant, 'post', c('/accounts-facts'), { yearStart: Y, key, value, reason: 'Synthetic' }), 201);
});
afterAll(() => s.stop());

describe('the golden workflow (DEC-054, DEC-069)', () => {
  it('phase 1: the start', async () => {
    const w = await phase(0);
    expect(w.steps[0].control.details).toMatchObject({ periodsCoverYear: true, draftSales: 1, draftPurchases: 0, pendingRequests: 0 });
    expect(w.steps.map((x: any) => x.title)).toEqual(['Lock/confirm period', 'Bank reconciliation', 'Receivables review', 'Payables review', 'Fixed asset review', 'Accrual/prepayment review',
      'Director balances', 'VAT reconciliation', 'Suspense clearance', 'Review adjustments', 'Generate accounts', 'Partner review', 'Client approval', 'Filing-ready package']);
    expect(w.steps[4].control).toMatchObject({ status: 'ATTENTION', details: { reconciled: true, activeAssets: 1, yearEndRun: false } });
    expect((await signOff(1)).body.code).toBe('step_not_ready');
  });
  it('phase 2: the cut-off fixed and step 1 signed off; steps 2 and 10 refused', async () => {
    ok(await as(accountant, 'post', c(`/sales/documents/${invoiceId}/approve`), {}));
    expect((await signOff(1, reviewer)).status).toBe(403);
    ok(await signOff(1));
    await phase(1);
    for (const r of G.phases[1].refusals) expect((await signOff(r.step)).body.code, `step ${r.step}`).toBe(r.code);
    expect((await signOff(1)).body.code).toBe('step_signed_off');
  });
  it('phase 3: settings set, the asset depreciated, the bank flag explained and signed off', async () => {
    ok(await as(accountant, 'post', c('/review-settings'), { ...S.settings, reason: 'Firm settings (synthetic)' }), 201);
    expect(ok(await as(accountant, 'post', c('/depreciation-runs'), { asAt: S.depreciationRun.asAt }), 201).total).toBe(S.depreciationRun.total);
    const flag = ok(await as(reviewer, 'get', c(`/review-checklist?yearStart=${Y}`))).controls.find((x: any) => x.code === 'RC-08').flags[0].key;
    ok(await as(accountant, 'post', c('/review-flags/explain'), { yearStart: Y, flagKey: flag, note: 'The bank account is set up with the first statements next year (synthetic)' }));
    ok(await as(partner, 'post', c('/review-flags/sign-off'), { yearStart: Y, flagKey: flag }));
    await phase(2);
  });
  it('phase 4: steps 2 to 11 signed off in turn; step 12 is for V2-M6c', async () => {
    for (let n = 2; n <= 11; n++) ok(await signOff(n));
    const w = await phase(3);
    expect(w.steps[10].control.details).toMatchObject({ documentComplete: true, sizeVerified: true, qualifiesAs: 'MICRO', chosen: 'MICRO', fits: true });
    expect(w.steps[1].signOffs).toMatchObject([{ action: 'SIGN_OFF', note: 'Step 2 reviewed (synthetic)', control: { status: 'READY' } }]);
    for (const r of G.phases[3].refusals) expect((await signOff(r.step)).body.code).toBe(r.code);
  });
  it('phase 5: a draft bill makes step 1 lapse; step 9 reopened is blocked behind it', async () => {
    const b = S.draftBill;
    ok(await as(accountant, 'post', c('/purchases/bills'), { supplierRoleId: supplier, issueDate: b.issueDate, dueDate: b.dueDate, supplierReference: 'YES-1',
      lines: [{ description: 'Synthetic', quantity: '1', unitPrice: b.amount, accountId: acc[b.account] }] }), 201);
    expect((await as(accountant, 'post', c('/year-end-workflow/reopen'), { yearStart: Y, step: 9 })).status).toBe(422);      // a reopen needs a reason
    ok(await as(accountant, 'post', c('/year-end-workflow/reopen'), { yearStart: Y, step: 9, note: 'Look at suspense again (synthetic)' }));
    const w = await phase(4);
    expect(w.steps[0].control.details).toMatchObject({ draftPurchases: 1 });
    for (const r of G.phases[4].refusals) expect((await as(accountant, 'post', c('/year-end-workflow/reopen'), { yearStart: Y, step: r.step, note: 'Again' })).body.code).toBe(r.code);
  });
});

describe('permissions and tenancy', () => {
  it('reading needs ledger:read; signing off needs accounts:prepare; another organisation sees nothing', async () => {
    expect((await signOff(2, reviewer)).status).toBe(403);
    expect((await as(outsider, 'get', c(`/year-end-workflow?yearStart=${Y}`))).status).toBe(404);
    expect((await as(reviewer, 'get', c('/year-end-workflow?yearStart=2030-01-01'))).body.code).toBe('framework_not_set');
  });
});
