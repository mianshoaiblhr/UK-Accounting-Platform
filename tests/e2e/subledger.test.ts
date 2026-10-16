import { expect as pw } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, type Stack, type TestUser } from '../helpers/stack';
import { signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * M9b (plan 13.2) in a real browser over the real stack. Synthetic: a sales VAT code with no verified rate (so a line with it stays a draft with a warning),
 * invoices without VAT, a receipt into the bank, a full credit note, a bill paid from an empty cash box (the negative-cash refusal and its reason).
 */
let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser, bookkeeper: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
let customer: string, supplier: string, vatCode: string;
const call = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const co = (p: string) => `/companies/${company.id}${p}`;
const ws = (p = '') => `/org/${owner.organisationId}/companies/${company.id}${p}`;
const docs: Record<string, string> = {};

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  company = await makeCompany(stack, owner, 'Ledger Screens Ltd');
  bookkeeper = await addMember(stack, owner, 'bookkeeper');
  accountant = await addMember(stack, owner, 'accountant');
  reviewer = await addMember(stack, owner, 'reviewer');
  expect((await call(owner, 'post', co('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' })).status).toBe(201);
  for (const a of (await call(owner, 'post', co('/accounts/initialise'))).body.items) acc[a.code] = a.id;
  expect((await call(owner, 'put', co('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Receivables control for the e2e books' })).status).toBe(200);
  expect((await call(owner, 'put', co('/purchase-settings'), { payablesAccountId: acc['2100'], reason: 'Payables control for the e2e books' })).status).toBe(200);
  vatCode = (await call(owner, 'post', co('/tax-codes'), { code: 'DEFS', name: 'Synthetic standard', treatment: 'STANDARD', direction: 'SALES', reverseCharge: false })).body.id;
  const c1 = (await call(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: 'Screen Customer Ltd' })).body;
  customer = (await call(owner, 'post', co('/contact-roles'), { contactId: c1.id, role: 'CUSTOMER', paymentTermsDays: 30, defaultTaxCodeId: vatCode })).body.id;
  const c2 = (await call(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: 'Screen Supplier Ltd' })).body;
  supplier = (await call(owner, 'post', co('/contact-roles'), { contactId: c2.id, role: 'SUPPLIER', paymentTermsDays: 30 })).body.id;
  expect([customer, supplier, vatCode].every(Boolean)).toBe(true);
});
afterAll(async () => { await stopWeb(w ?? {}); });

async function newDocument(page: Page, side: 'sales' | 'purchases', party: string, o: { amount: string; account: string; vat?: string; reference?: string }) {
  await page.goto(ws(`/${side}/new`));
  const form = page.getByTestId('new-document');
  await form.getByLabel(side === 'sales' ? 'Customer' : 'Supplier', { exact: true }).selectOption({ label: party });
  if (o.reference) await form.getByLabel("Supplier's invoice number").fill(o.reference);
  await form.getByLabel('Line 1 description').fill('Synthetic work');
  await form.getByLabel('Line 1 unit price').fill(o.amount);
  await form.getByLabel('Line 1 account').selectOption({ label: o.account });
  if (o.vat) await form.getByLabel('Line 1 VAT code').selectOption({ label: o.vat });
  await form.getByRole('button', { name: /Save draft/ }).click();
  await page.waitForURL(new RegExp(`${ws(`/${side}/`)}[0-9a-f-]{36}$`));
  return page.url().split('/').pop()!;
}
const approve = async (page: Page) => { await page.getByTestId('doc-actions').getByRole('button', { name: 'Approve' }).click(); };

describe('M9b sales and purchases in the browser', () => {
  it('a bookkeeper drafts an invoice whose line takes the customer default VAT code, sees the API warning, and has no Approve button', async () => {
    const page = await signIn(browser, bookkeeper.email);
    await page.goto(ws('/sales/new'));
    await page.getByTestId('new-document').getByLabel('Customer', { exact: true }).selectOption({ label: 'Screen Customer Ltd' });
    await pw(page.getByTestId('default-vat')).toContainText('DEFS');
    docs.vatDraft = await newDocument(page, 'sales', 'Screen Customer Ltd', { amount: '100.00', account: '4000 Sales - standard rated', vat: 'Customer default (DEFS)' });
    await pw(page.getByTestId('doc-status')).toContainText('DRAFT');
    await pw(page.getByTestId('line-vat')).toHaveText('DEFS');
    await pw(page.getByTestId('warning').first()).toBeVisible();
    await pw(page.getByTestId('doc-actions').getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await pw(page.getByTestId('doc-actions').getByRole('button', { name: 'Discard' })).toBeVisible();
    const api = (await call(bookkeeper, 'get', co(`/sales/documents/${docs.vatDraft}`))).body;
    expect(api.lines[0].taxCodeId).toBe(vatCode);
    await page.context().close();
  });

  it('an accountant approves an invoice, meets the duplicate refusal on the next one and approves it with a reason', async () => {
    const page = await signIn(browser, accountant.email);
    docs.inv1 = await newDocument(page, 'sales', 'Screen Customer Ltd', { amount: '500.00', account: '4000 Sales - standard rated', vat: 'No VAT code' });
    await approve(page);
    await pw(page.getByTestId('doc-status')).toContainText('APPROVED');
    await pw(page.getByTestId('doc-outstanding')).toHaveText('500.00');
    docs.inv2 = await newDocument(page, 'sales', 'Screen Customer Ltd', { amount: '500.00', account: '4000 Sales - standard rated', vat: 'No VAT code' });
    await approve(page);
    const prompt = page.locator('[data-override=possible_duplicate]');
    await pw(prompt).toContainText('Possible duplicate');
    await prompt.getByLabel('Reason to go ahead').fill('Two separate jobs at the same price (synthetic)');
    await approve(page);
    await pw(page.getByTestId('doc-status')).toContainText('APPROVED');
    await pw(page.getByText('Approved despite a possible duplicate: Two separate jobs')).toBeVisible();
    await page.context().close();
  });

  it('a receipt allocated to the first invoice pays it; a full credit note settles the second', async () => {
    const page = await signIn(browser, accountant.email);
    await page.goto(ws('/sales/money'));
    const form = page.getByTestId('record-money');
    await form.getByLabel('Customer', { exact: true }).selectOption({ label: 'Screen Customer Ltd' });
    await form.getByLabel('Amount').fill('500.00');
    await form.getByLabel('Bank or cash account').selectOption({ label: '1200 Bank current account' });
    await form.getByLabel('Reference').fill('BACS-E2E-1');
    const number1 = (await call(accountant, 'get', co(`/sales/documents/${docs.inv1}`))).body.documentNumber;
    await form.getByLabel(`Allocate to ${number1}`).fill('500.00');
    await form.getByRole('button', { name: 'Record receipt' }).click();
    await pw(page.getByRole('status')).toContainText('Receipt recorded');
    await pw(page.getByTestId('money')).toContainText('BACS-E2E-1');
    expect((await call(accountant, 'get', co(`/sales/documents/${docs.inv1}`))).body.paymentStatus).toBe('PAID');

    await page.goto(ws(`/sales/${docs.inv2}`));
    await page.getByLabel('Reason', { exact: true }).fill('Job cancelled (synthetic)');
    await page.getByRole('button', { name: 'Draft the credit note' }).click();
    await page.waitForURL((u) => /\/sales\/[0-9a-f-]{36}$/.test(u.pathname) && !u.pathname.endsWith(docs.inv2!));
    await pw(page.getByRole('heading', { name: /Credit note/ })).toBeVisible();
    await approve(page);
    await pw(page.getByTestId('doc-status')).toContainText('APPROVED');
    await page.getByRole('link', { name: /the original invoice/ }).click();
    await pw(page.getByTestId('doc-outstanding')).toHaveText('0.00');
    await page.context().close();
  });

  it('ageing and the customer statement show the API figures', async () => {
    // one invoice left open, dated in January so it ages into an overdue bucket
    const open = (await call(accountant, 'post', co('/sales/invoices'), { customerRoleId: customer, issueDate: '2026-01-15', customerReference: 'AGE-1', lines: [{ description: 'Synthetic work', unitPrice: '80.00', accountId: acc['4000'], taxCodeId: null }] })).body;
    expect((await call(accountant, 'post', co(`/sales/documents/${open.id}/approve`), {})).status).toBe(200);
    const aged = (await call(accountant, 'get', co('/sales/aged-receivables'))).body;
    expect(aged.totals[0].total).toBe('80.00');
    const page = await signIn(browser, accountant.email);
    await page.goto(ws('/sales/ageing'));
    await pw(page.getByTestId('aged-total').first()).toHaveText(aged.totals[0].total);
    await page.locator(`tr[data-party="${customer}"]`).getByRole('link').click();
    const year = new Date().getUTCFullYear();
    const st = (await call(accountant, 'get', co(`/sales/customers/${customer}/statement?from=${year}-01-01&to=${year}-12-31`))).body;
    await pw(page.getByTestId('statement-closing').first()).toHaveText(st.currencies[0].closing);
    await pw(page.getByTestId('statement-lines')).toContainText('BACS-E2E-1');
    await page.context().close();
  });

  it('a bill is approved; paying it from the empty cash box meets the negative-cash refusal and is recorded with a reason', async () => {
    const page = await signIn(browser, accountant.email);
    docs.bill = await newDocument(page, 'purchases', 'Screen Supplier Ltd', { amount: '120.00', account: '6100 Rent and rates', vat: 'No VAT code', reference: 'SUP-77' });
    await approve(page);
    await pw(page.getByTestId('doc-status')).toContainText('APPROVED');
    const billNumber = (await call(accountant, 'get', co(`/purchases/documents/${docs.bill}`))).body.documentNumber;
    await page.goto(ws('/purchases/money'));
    const form = page.getByTestId('record-money');
    await form.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Screen Supplier Ltd' });
    await form.getByLabel('Amount').fill('120.00');
    await form.getByLabel('Bank or cash account').selectOption({ label: '1220 Cash in hand' });
    await form.getByLabel(`Allocate to ${billNumber}`).fill('120.00');
    await form.getByRole('button', { name: 'Record payment' }).click();
    const prompt = form.locator('[data-override=negative_cash]');
    await pw(prompt).toContainText('below zero');
    await prompt.getByLabel('Reason to go ahead').fill('Paid from the owner\'s pocket, float to follow (synthetic)');
    await form.getByRole('button', { name: 'Record payment' }).click();
    await pw(page.getByRole('status')).toContainText('Payment recorded');
    expect((await call(accountant, 'get', co(`/purchases/documents/${docs.bill}`))).body.paymentStatus).toBe('PAID');
    await page.context().close();
  });

  it('a reviewer reads sales and purchases without any action, and the API refuses an approval anyway', async () => {
    const page = await signIn(browser, reviewer.email);
    await page.goto(ws('/sales'));
    await pw(page.getByTestId('documents')).toContainText('Credit note');
    await pw(page.getByTestId('side-nav').getByRole('link', { name: /New invoice/ })).toHaveCount(0);
    await page.goto(ws(`/sales/${docs.vatDraft}`));
    await pw(page.getByTestId('doc-status')).toContainText('DRAFT');
    await pw(page.getByTestId('doc-actions').getByRole('button')).toHaveCount(0);
    await page.goto(ws('/purchases/money'));
    await pw(page.getByTestId('money')).toBeVisible();
    await pw(page.getByTestId('record-money')).toHaveCount(0);
    expect((await call(reviewer, 'post', co(`/sales/documents/${docs.vatDraft}/approve`), {})).status).toBe(403);
    await page.context().close();
  });
});
