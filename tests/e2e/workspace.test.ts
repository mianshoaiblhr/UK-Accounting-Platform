import { expect as pw } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * M9a (DEC-048..050) in a real browser over the real stack, on synthetic books built through the API:
 *   1 Feb  capital 1,000.00 into the bank      3 Mar  sales 600.00 into the bank     5 Mar  rent 250.00 from the bank
 *   6 Mar  sundry 20.00 from cash in hand, taking it to -20.00 (with a reason)          10 Mar  a draft invoice, not approved
 *   Profit January to June: 600.00 - 250.00 - 20.00 = 330.00
 * The screens must show what the API computes; they compute nothing themselves.
 */
let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser, reviewer: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const call = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const co = (p: string) => `/companies/${company.id}${p}`;
const ws = (p = '') => `/org/${owner.organisationId}/companies/${company.id}${p}`;
const cash = (direction: 'RECEIPT' | 'PAYMENT', date: string, bank: string, account: string, amount: string, extra: object = {}) =>
  call(owner, 'post', co('/cash-transactions'), { direction, transactionDate: date, bankAccountId: acc[bank], description: `${direction} ${amount}`, lines: [{ description: 'Synthetic', accountId: acc[account], amount }], ...extra });

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  company = await makeCompany(stack, owner, 'Workspace Books Ltd');
  reviewer = await addMember(stack, owner, 'reviewer');
  for (const [s, e] of [['2026-01-01', '2026-06-30'], ['2026-07-01', '2026-12-31']]) expect((await call(owner, 'post', co('/periods'), { startDate: s, endDate: e })).status).toBe(201);
  for (const a of (await call(owner, 'post', co('/accounts/initialise'))).body.items) acc[a.code] = a.id;
  for (const r of [await cash('RECEIPT', '2026-02-01', '1200', '3000', '1000.00'), await cash('RECEIPT', '2026-03-03', '1200', '4000', '600.00'), await cash('PAYMENT', '2026-03-05', '1200', '6100', '250.00'),
    await cash('PAYMENT', '2026-03-06', '1220', '6800', '20.00', { negativeCashReason: 'Float not yet topped up (synthetic)' })]) expect(r.status).toBe(201);
  expect((await call(owner, 'put', co('/sales-settings'), { receivablesAccountId: acc['1100'], reason: 'Receivables control for the e2e books' })).status).toBe(200);
  const contact = (await call(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: 'E2E Customer Ltd' })).body;
  const role = (await call(owner, 'post', co('/contact-roles'), { contactId: contact.id, role: 'CUSTOMER', paymentTermsDays: 30 })).body;
  expect((await call(owner, 'post', co('/sales/invoices'), { customerRoleId: role.id, issueDate: '2026-03-10', lines: [{ description: 'Synthetic work', unitPrice: '75.00', accountId: acc['4000'] }] })).status).toBe(201);
});
afterAll(async () => { await stopWeb(w ?? {}); });

const tab = async (page: Page, name: string) => { await page.getByRole('navigation', { name: 'Bookkeeping' }).getByRole('link', { name, exact: true }).click(); };

describe('M9a workspace in the browser', () => {
  it('the owner opens the company from the home page and sees the dashboard controls and alerts the API computed', async () => {
    const page = await signIn(browser, owner.email);
    await page.getByRole('link', { name: 'Workspace Books Ltd' }).click();
    await page.waitForURL(`${WEB}${ws()}`);
    await page.getByLabel('As at').fill('2026-06-30');
    const keys = page.getByTestId('key-controls');
    await pw(keys.getByRole('row', { name: /Cash or bank below zero/ })).toContainText('1');
    await pw(keys.getByRole('row', { name: /Suspense balance/ })).toContainText('0');
    await pw(page.getByTestId('alerts').locator('tr[data-code=negative_cash]')).toContainText('HIGH');
    await pw(page.getByTestId('alerts').locator('tr[data-code=negative_cash]')).toContainText('1220');
    // the alert opens the ledger of the account it is about
    await page.getByTestId('alerts').locator('tr[data-code=negative_cash]').getByRole('link').first().click();
    await pw(page.getByRole('heading', { name: /General ledger: 1220/ })).toBeVisible();
    await pw(page.getByTestId('ledger')).toContainText('-20.00');
    await page.context().close();
  });

  it('journals open their lines and the cash transaction that posted them', async () => {
    const page = await signIn(browser, owner.email);
    await page.goto(ws('/journals'));
    const table = page.getByTestId('journals');
    await pw(table.getByRole('row')).toHaveCount(5);
    await table.getByRole('row', { name: /CASH_PAYMENT.*250\.00/ }).getByRole('link').click();
    await pw(page.getByRole('heading', { name: /Journal \d+/ })).toBeVisible();
    await pw(page.getByTestId('journal-lines')).toContainText('6100');
    await pw(page.getByTestId('journal-lines')).toContainText('250.00');
    await pw(page.getByTestId('journal-source')).toContainText('cash transaction');
    await pw(page.getByTestId('journal-source')).toContainText('POSTED');
    await page.context().close();
  });

  it('the profit and loss and the balance sheet show exactly the API figures, reconciled, and expand to accounts', async () => {
    const pl = (await call(owner, 'get', co('/reports/profit-and-loss?from=2026-01-01&to=2026-06-30'))).body;
    const bs = (await call(owner, 'get', co('/reports/balance-sheet?asOf=2026-06-30'))).body;
    expect(pl.profitForPeriod).toBe('330.00');
    const page = await signIn(browser, owner.email);
    await page.goto(ws('/reports/profit-and-loss'));
    await page.getByLabel('From', { exact: true }).fill('2026-01-01');
    await page.getByLabel('To', { exact: true }).fill('2026-06-30');
    for (const l of pl.lines as { key: string; amount: string }[]) await pw(page.locator(`tr[data-key="${l.key}"]`)).toContainText(l.amount);
    await pw(page.getByTestId('reconciliation')).toContainText('Profit for the period 330.00');
    await pw(page.getByTestId('reconciliation')).toContainText('(reconciled)');
    await page.locator('tr[data-key="PL.ADMIN_EXPENSES"]').getByRole('button').click();
    await pw(page.getByTestId('statement')).toContainText('6100');
    await page.goto(ws('/reports/balance-sheet'));
    await page.getByLabel('As at').fill('2026-06-30');
    for (const l of bs.lines as { key: string; amount: string }[]) await pw(page.locator(`tr[data-key="${l.key}"]`)).toContainText(l.amount);
    await pw(page.getByTestId('reconciliation')).toContainText('(balanced; trial balance balanced)');
    await tab(page, 'Trial balance');
    await page.getByLabel('As at').fill('2026-06-30');
    await pw(page.getByRole('status')).toContainText('Balanced');
    await page.context().close();
  });

  it('closing the period meets the draft-invoice control: the API message is shown, the acknowledgement closes it; locking needs a reason', async () => {
    const page = await signIn(browser, owner.email);
    await page.goto(ws('/periods'));
    const row = page.locator('tr[data-period="2026-01-01"]');
    await row.getByRole('button', { name: 'Close' }).click();
    await pw(row.getByRole('alert')).toContainText('draft sales or purchase document');
    await row.getByLabel('Close with the draft documents left unapproved').check();
    await row.getByRole('button', { name: 'Close' }).click();
    await pw(row.getByTestId('period-status')).toHaveText('CLOSED');
    await row.getByRole('button', { name: 'Lock' }).click();
    await pw(row.getByRole('alert')).toContainText(/reason/i);
    await row.getByLabel('Reason for 2026-01-01').fill('First half filed (synthetic)');
    await row.getByRole('button', { name: 'Lock' }).click();
    await pw(row.getByTestId('period-status')).toHaveText('LOCKED');
    const audit = (await call(owner, 'get', `/audit-events?entityType=accounting_period`)).body.items.find((e: { action: string }) => e.action === 'period.closed');
    expect(audit.metadata).toMatchObject({ acknowledgedDraftDocuments: 1 });
    await page.context().close();
  });

  it('the owner adds an account modelled on an existing one', async () => {
    const page = await signIn(browser, owner.email);
    await page.goto(ws('/accounts'));
    const card = page.getByTestId('new-account');
    await card.getByLabel('Code').fill('6150');
    await card.getByLabel('Name').fill('Synthetic software');
    await card.getByLabel('Same kind as').selectOption({ label: '6100 Rent and rates' });
    await card.getByRole('button', { name: 'Add account' }).click();
    await pw(card.getByRole('status')).toContainText('Account added');
    await pw(page.getByTestId('accounts')).toContainText('Synthetic software');
    await page.context().close();
  });

  it('a reviewer reads the books but sees no action, and the API refuses the action anyway', async () => {
    const page = await signIn(browser, reviewer.email);
    await page.goto(ws('/periods'));
    await pw(page.getByTestId('periods')).toBeVisible();
    await pw(page.getByRole('button', { name: /^(Close|Reopen|Lock|Unlock)$/ })).toHaveCount(0);
    await page.goto(ws('/accounts'));
    await pw(page.getByTestId('accounts')).toBeVisible();
    await pw(page.getByTestId('new-account')).toHaveCount(0);
    const period = (await call(owner, 'get', co('/periods'))).body.items.find((p: { startDate: string }) => p.startDate.startsWith('2026-07-01'));
    expect((await call(reviewer, 'post', co(`/periods/${period.id}/close`), {})).status).toBe(403);
    await page.context().close();
  });

  it('with bookkeeping off for the organisation, the workspace says so and shows no bookkeeping navigation', async () => {
    expect((await call(owner, 'put', '/feature-flags/bookkeeping.core', { enabled: false, reason: 'Screens off for the e2e test' })).status).toBe(200);
    try {
      const page = await signIn(browser, owner.email);
      await page.goto(ws('/journals'));
      await pw(page.getByTestId('feature-off')).toContainText('not enabled');
      await pw(page.getByRole('navigation', { name: 'Bookkeeping' })).toHaveCount(0);
      await page.context().close();
    } finally {
      await call(owner, 'put', '/feature-flags/bookkeeping.core', { enabled: true, reason: 'Screens back on' });
    }
  });
});
