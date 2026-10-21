import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect as pw } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * V2-M7a (DEC-071, DEC-050) in a real browser over the real stack: the year-end workspace on the V2-M6c golden company (DEC-070), built
 * through the API up to the review. In the browser: a flag explained and signed off, a fact set, step 11 signed off, the partner refused as
 * reviewer, the owner's review, the period closed, the client's approval recorded and the package generated; a reviewer sees no action; with
 * the feature off the pages say so. The screens show what the API computes; they compute nothing themselves.
 */
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m6c-approval.json'), 'utf8')) as Record<string, any>;
const L = JSON.parse(readFileSync(resolve(__dirname, '..', '..', G.linesFrom), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };
const S = G.setup, Y = G.year.yearStart;

let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser, partner: TestUser, author: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
let director: string;
const acc: Record<string, string> = {};
const call = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = async (r: Promise<{ status: number; body: any }> | { status: number; body: any }, status = 200) => { const x = await r; expect(x.status, JSON.stringify(x.body)).toBe(status); return x.body; };
const co = (p = '') => `/companies/${company.id}${p}`;
const ws = (p = '') => `/org/${owner.organisationId}/companies/${company.id}${p}`;
const open = async (u: TestUser, path: string): Promise<Page> => { const page = await signIn(browser, u.email); await page.goto(`${WEB}${ws(path)}?year=${Y}`); return page; };
const stepRow = (page: Page, n: number) => page.getByTestId('workflow').locator(`tr[data-step="${n}"]`);

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  company = await makeCompany(stack, owner, 'Year End Screens Ltd');
  partner = await addMember(stack, owner, 'partner');
  author = await addMember(stack, owner, 'admin');
  accountant = await addMember(stack, owner, 'accountant');
  reviewer = await addMember(stack, owner, 'reviewer');
  await ok(call(owner, 'post', co('/periods'), { startDate: Y, endDate: G.year.yearEnd }), 201);
  for (const a of (await ok(call(owner, 'post', co('/accounts/initialise')), 201)).items) acc[a.code] = a.id;
  acc['6950'] = (await ok(call(owner, 'post', co('/accounts'), { code: '6950', name: 'Profit or loss on disposal of fixed assets', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', reportingMapping: 'PL.OTHER_EXPENSES' }), 201)).id;
  await ok(call(owner, 'put', co('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Receivables control (synthetic)' }));
  await ok(call(owner, 'put', co('/purchase-settings'), { payablesAccountId: acc['2100'], reason: 'Payables control (synthetic)' }));
  const customerContact = (await ok(call(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: G.company.customer }), 201)).id;
  const customer = (await ok(call(owner, 'post', co('/contact-roles'), { contactId: customerContact, role: 'CUSTOMER', accountCode: 'YSC01' }), 201)).id;
  director = (await ok(call(owner, 'post', '/contacts', { kind: 'PERSON', name: G.company.director }), 201)).id;
  await ok(call(owner, 'post', co('/officers'), { contactId: director, role: 'DIRECTOR', appointedOn: G.company.appointedOn }), 201);
  const a = S.asset, k = a.class;
  const payment = await ok(call(accountant, 'post', co('/cash-transactions'), { direction: 'PAYMENT', transactionDate: a.acquiredOn, bankAccountId: acc['1200'], description: a.description,
    lines: [{ description: a.description, accountId: acc[k.costAccount], amount: a.cost }] }), 201);
  await ok(call(accountant, 'post', co('/cash-transactions'), { direction: 'RECEIPT', transactionDate: S.shares.date, bankAccountId: acc['1200'], description: 'Shares issued',
    lines: [{ description: 'Shares issued', accountId: acc['3000'], amount: S.shares.amount }] }), 201);
  const classId = (await ok(call(accountant, 'post', co('/fixed-asset-classes'), { code: k.code, name: k.name, costAccountId: acc[k.costAccount], depreciationAccountId: acc[k.depreciationAccount],
    expenseAccountId: acc[k.expenseAccount], disposalAccountId: acc[k.disposalAccount], method: k.method, lifeMonths: k.lifeMonths, convention: k.convention }), 201)).id;
  await ok(call(accountant, 'post', co('/fixed-assets'), { classId, description: a.description, acquiredOn: a.acquiredOn, cost: a.cost, addition: { kind: 'LINKED', journalId: payment.journalId } }), 201);
  const inv = S.invoice;
  const invoiceId = (await ok(call(accountant, 'post', co('/sales/invoices'), { customerRoleId: customer, issueDate: inv.issueDate, dueDate: inv.dueDate,
    lines: [{ description: 'Synthetic', quantity: '1', unitPrice: inv.amount, accountId: acc[inv.account], taxCodeId: null }] }), 201)).id;
  await ok(call(accountant, 'post', co(`/sales/documents/${invoiceId}/approve`), {}));
  const standardId = (await ok(call(author, 'post', co('/reporting-standards'), { code: 'SYN-E2E', name: 'Synthetic screens standard' }), 201)).id;
  const versionId = (await ok(call(author, 'post', co(`/reporting-standards/${standardId}/versions`), { label: 'Synthetic screens v1', effectiveFrom: '2020-01-01',
    source: { url: 'https://example.test/synthetic-screens', provision: 'Synthetic test content', retrievedOn: '2026-10-21' } }), 201)).id;
  const v = co(`/reporting-standard-versions/${versionId}`);
  for (const l of L.lines) await ok(call(author, 'post', `${v}/lines`, l), 201);
  for (const [sourceLine, accountSubtype, targetKey] of L.mapEntries) await ok(call(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey }), 201);
  for (const r of S.rules) await ok(call(author, 'post', `${v}/disclosure-rules`, r), 201);
  await ok(call(author, 'patch', v, { turnoverLineKey: 'P.T' }));
  await ok(call(owner, 'post', `${v}/verify`, { notes: 'Synthetic version checked for the screens test' }));
  await ok(call(accountant, 'put', co('/reporting-frameworks'), { yearStart: Y, yearEnd: G.year.yearEnd, versionId, entitySize: G.year.entitySize, reason: 'Synthetic' }));
  const set = await ok(call(author, 'post', co('/size-threshold-sets'), { ...S.thresholds, source: { url: 'https://example.test/synthetic-limits', provision: 'Synthetic test limits', retrievedOn: '2026-10-21' } }), 201);
  await ok(call(owner, 'post', co(`/size-threshold-sets/${set.id}/verify`), { notes: 'Synthetic limits checked for the screens test' }));
  // every fact but the employees average, which the browser sets
  for (const [key, value] of S.facts) if (key !== 'employees.average') await ok(call(accountant, 'post', co('/accounts-facts'), { yearStart: Y, key, value: value === '@director' ? director : value, reason: 'Synthetic' }), 201);
  await ok(call(accountant, 'post', co('/review-settings'), { ...S.settings, reason: 'Firm settings (synthetic)' }), 201);
  await ok(call(accountant, 'post', co('/depreciation-runs'), { asAt: S.depreciationRun.asAt }), 201);
  const d = await uploadDoc(stack, owner, { companyId: company.id, name: 'Signed balance sheet.pdf' }); await waitForVersion(stack, owner, d.documentId, d.versionId);
});
afterAll(async () => { await stopWeb(w ?? {}); });

describe('V2-M7a year-end workspace in the browser', () => {
  it('the review screen: the accountant explains the bank flag and the partner signs it off', async () => {
    let page = await open(accountant, '/year-end/review');
    const flag = page.locator('section[data-control="RC-08"] tr[data-flag]');
    await pw(flag.getByTestId('flag-state')).toContainText('OPEN');
    await pw(flag.getByRole('button', { name: 'Sign off' })).toHaveCount(0);   // an accountant does not hold accounts:review
    await flag.getByRole('textbox').fill('The bank account is set up with the first statements next year (synthetic)');
    await flag.getByRole('button', { name: 'Explain' }).click();
    await pw(flag.getByTestId('flag-state')).toContainText('EXPLAINED');
    await page.context().close();
    page = await open(partner, '/year-end/review');
    const f2 = page.locator('section[data-control="RC-08"] tr[data-flag]');
    await f2.getByRole('button', { name: 'Sign off' }).click();
    await pw(f2.getByTestId('flag-state')).toContainText('SIGNED_OFF');
    await pw(page.getByTestId('review-settings')).toContainText('1000000.00');
    await page.context().close();
  });

  it('the accounts screen: the preparer sets the employees fact; the document shows the API\'s statements and wording', async () => {
    const page = await open(accountant, '/year-end/accounts');
    await pw(page.getByTestId('document-complete')).toContainText('not complete');
    await page.getByLabel('Fact').selectOption('employees.average');
    await page.getByLabel('Value').fill('1');
    await page.getByLabel('Reason').fill('Payroll records (synthetic)');
    await page.getByRole('button', { name: 'Set fact' }).click();
    await pw(page.getByTestId('facts').locator('tr[data-fact="employees.average"]')).toContainText('1');
    await pw(page.getByTestId('document-complete')).toContainText('The accounts document is complete.');
    await pw(page.getByTestId('accounts-document')).toContainText('The average number of employees during the year was 1.');
    await pw(page.getByTestId('accounts-document')).toContainText('The financial statements were approved by the board of directors on 16 March 2026');
    await pw(page.getByTestId('statement-bs')).toBeVisible();
    await pw(page.getByTestId('size-test')).toContainText('qualifies as: MICRO');
    await page.context().close();
  });

  it('the workflow, approval and package: a refusal shown in the API\'s words, the year locked, the package generated', async () => {
    for (let n = 1; n <= 10; n++) await ok(call(accountant, 'post', co('/year-end-workflow/sign-off'), { yearStart: Y, step: n, note: `Step ${n} reviewed (synthetic)` }));
    // the partner signs off step 11 in the browser
    let page = await open(partner, '/year-end');
    await pw(page.getByTestId('current-step')).toContainText('Current step: 11');
    await stepRow(page, 11).getByRole('button', { name: 'Sign off' }).click();
    await pw(stepRow(page, 11).getByTestId('step-state')).toContainText('DONE');
    await pw(stepRow(page, 12).getByTestId('step-state')).toContainText('TODO');
    // ... and is refused as partner reviewer: the screen shows the API's reason
    await page.getByRole('link', { name: 'Approval' }).first().click();
    await page.getByRole('button', { name: 'Record the partner review' }).click();
    await pw(page.locator('main').getByRole('alert')).toContainText('someone other than the person who signed off the accounts');
    await page.context().close();
    // the owner reviews
    page = await open(owner, '/year-end/approval');
    await page.getByRole('button', { name: 'Record the partner review' }).click();
    await pw(page.getByTestId('partner-reviews')).toContainText('(live)');
    await pw(page.getByTestId('approval-steps').locator('tr[data-step="12"]').getByTestId('step-state')).toContainText('DONE');
    // the owner closes the period on the periods screen
    await page.goto(`${WEB}${ws('/periods')}`);
    await page.locator(`tr[data-period="${Y}"]`).getByRole('button', { name: 'Close' }).click();
    await pw(page.locator(`tr[data-period="${Y}"]`).getByTestId('period-status')).toHaveText('CLOSED');
    await page.context().close();
    // the partner records the client's approval with the director and the evidence
    page = await open(partner, '/year-end/approval');
    await page.getByLabel('Approving director').selectOption({ label: G.company.director });
    await page.getByLabel('Approved on').fill(S.approval.approvedOn);
    await page.getByLabel('Evidence (the signed approval)').selectOption({ label: 'Signed balance sheet.pdf' });
    await page.getByRole('button', { name: "Record the client's approval and lock the year" }).click();
    await pw(page.getByTestId('client-approval')).toContainText(`Approved on ${S.approval.approvedOn}`);
    await pw(page.getByTestId('year-locked')).toBeVisible();
    await page.context().close();
    // the accountant generates the package; its SHA-256 and the fingerprint are the API's
    page = await open(accountant, '/year-end/approval');
    await page.getByRole('button', { name: 'Generate the package' }).click();
    await pw(page.getByTestId('package-sha256')).toHaveText(/^[0-9a-f]{64}$/);
    const pkg = await ok(call(reviewer, 'get', co(`/accounts-package?yearStart=${Y}`)));
    await pw(page.getByTestId('package-sha256')).toHaveText(pkg.sha256);
    await pw(page.getByTestId('approval-steps').locator('tr[data-step="14"]').getByTestId('step-state')).toContainText('DONE');
    // the workflow is complete and offers no more actions on the locked year
    await page.getByRole('link', { name: 'Workflow' }).click();
    await pw(page.getByTestId('current-step')).toContainText('Every step is done.');
    await pw(page.getByTestId('workflow').getByRole('button')).toHaveCount(0);
    await page.context().close();
  });

  it('a reviewer sees every year-end screen and no action button', async () => {
    for (const p of ['/year-end', '/year-end/review', '/year-end/accounts', '/year-end/approval']) {
      const page = await open(reviewer, p);
      await pw(page.getByTestId('year-end-nav')).toBeVisible();
      await pw(page.locator('main').getByRole('heading', { level: 1 })).toBeVisible();
      await pw(page.locator('main .card').first()).not.toContainText('Loading');
      await pw(page.locator('main').getByRole('button', { name: /Sign off|Explain|Reopen|Record|Generate|Save settings|Set fact/ })).toHaveCount(0);
      await page.context().close();
    }
  });

  it('with accounts production off for the organisation, the pages say so and the navigation has no year end', async () => {
    await ok(call(owner, 'put', '/feature-flags/accounts.production', { enabled: false, reason: 'Screens off for the e2e test' }));
    try {
      const page = await open(owner, '/year-end');
      await pw(page.getByTestId('feature-off')).toContainText('Accounts production is not enabled');
      await pw(page.getByRole('navigation', { name: 'Bookkeeping' }).getByRole('link', { name: 'Year end' })).toHaveCount(0);
      await page.context().close();
    } finally {
      await call(owner, 'put', '/feature-flags/accounts.production', { enabled: true, reason: 'Screens back on' });
    }
  });
});
