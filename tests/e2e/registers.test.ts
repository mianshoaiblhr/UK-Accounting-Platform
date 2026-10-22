import { expect as pw } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * V2-M7b (DEC-074, DEC-050) in a real browser over the real stack, on synthetic 2026 books built through the API:
 *   2 Jan  shares 10,000.00 into the bank       1 Jan  laptops 3,600.00 paid from the bank to office equipment (0030)
 * In the browser the accountant adds the asset class and the laptops (linked to that payment), posts depreciation to 31.12.2026
 * (3,600 / 36 x 12 = 1,200.00), creates a 1,200.00 prepayment for October 2026 to September 2027 and releases it to 31.12.2026
 * (3 of 12 months: 300.00), makes a 500.00 provision, opens a director's loan account, records a related party and posts the closing
 * journal; a disposal dated before the laptops were in use is refused in the API's words; a reviewer sees every register and no action.
 * The screens show what the API computes; they compute nothing themselves.
 */
let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const call = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = async (r: Promise<{ status: number; body: any }>, status = 200) => { const x = await r; expect(x.status, JSON.stringify(x.body)).toBe(status); return x.body; };
const co = (p = '') => `/companies/${company.id}${p}`;
const ws = (p = '') => `/org/${owner.organisationId}/companies/${company.id}${p}`;
const open = async (u: TestUser, path: string): Promise<Page> => { const page = await signIn(browser, u.email); await page.goto(`${WEB}${ws(path)}`); return page; };
const pick = async (page: Page, label: string, option: string | RegExp) => {
  const select = page.getByLabel(label, { exact: true });
  await pw(select.locator('option', { hasText: option })).toHaveCount(1);   // wait for the API's list to arrive
  await select.selectOption({ label: (await select.locator('option', { hasText: option }).textContent())! });
};

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  company = await makeCompany(stack, owner, 'Register Screens Ltd');
  accountant = await addMember(stack, owner, 'accountant');
  reviewer = await addMember(stack, owner, 'reviewer');
  await ok(call(owner, 'post', co('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' }), 201);
  await ok(call(owner, 'post', co('/periods'), { startDate: '2027-01-01', endDate: '2027-12-31' }), 201);
  for (const a of (await ok(call(owner, 'post', co('/accounts/initialise')), 201)).items) acc[a.code] = a.id;
  await ok(call(owner, 'post', co('/accounts'), { code: '6950', name: 'Profit or loss on disposal of fixed assets', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', reportingMapping: 'PL.OTHER_EXPENSES' }), 201);
  await ok(call(owner, 'post', co('/accounts'), { code: '2400', name: 'Provisions for liabilities', type: 'LIABILITY', subtype: 'LONG_TERM_LIABILITY', reportingMapping: 'BS.CREDITORS_AFTER_ONE_YEAR' }), 201);
  await ok(call(accountant, 'post', co('/cash-transactions'), { direction: 'RECEIPT', transactionDate: '2026-01-02', bankAccountId: acc['1200'], description: 'Shares issued',
    lines: [{ description: 'Shares issued', accountId: acc['3000'], amount: '10000.00' }] }), 201);
  await ok(call(accountant, 'post', co('/cash-transactions'), { direction: 'PAYMENT', transactionDate: '2026-01-01', bankAccountId: acc['1200'], description: 'Laptops',
    lines: [{ description: 'Laptops', accountId: acc['0030'], amount: '3600.00' }] }), 201);
  const director = (await ok(call(owner, 'post', '/contacts', { kind: 'PERSON', name: 'Synthetic Director' }), 201)).id;
  await ok(call(owner, 'post', co('/officers'), { contactId: director, role: 'DIRECTOR', appointedOn: '2025-06-01' }), 201);   // a director's loan account needs the appointment
  await ok(call(owner, 'post', '/contacts', { kind: 'ORGANISATION', name: 'Director Family Ltd' }), 201);
});
afterAll(async () => { await stopWeb(w ?? {}); });

describe('V2-M7b registers in the browser', () => {
  it('fixed assets: a class and the laptops added, the register reconciled; a disposal before use refused in the API\'s words', async () => {
    const page = await open(accountant, '/registers');
    await page.getByLabel('Code').fill('OFFICE');
    await page.getByLabel('Name', { exact: true }).fill('Office equipment');
    await pick(page, 'Cost account', '0030 Office equipment');
    await pick(page, 'Accumulated depreciation account', '0031');
    await pick(page, 'Depreciation expense account', '6900');
    await pick(page, 'Disposal account', '6950');
    await page.getByLabel('Life (months)').fill('36');
    await page.getByRole('button', { name: 'Create class' }).click();
    await pw(page.getByTestId('fa-classes').locator('tr[data-class="OFFICE"]')).toContainText('Straight line, 36 months');
    await pick(page, 'Class', 'OFFICE');
    await page.getByLabel('Description').fill('Laptops');
    await page.getByLabel('Acquired on').fill('2026-01-01');
    await page.getByLabel('Cost', { exact: true }).fill('3600.00');
    await pick(page, 'Posting on the cost account', /3600/);
    await page.getByRole('button', { name: 'Add asset' }).click();
    await pw(page.getByTestId('fa-assets').locator('tr[data-asset="1"]')).toContainText('LINKED');
    await page.getByLabel('Register as at').fill('2026-12-31');
    await pw(page.getByTestId('fa-register')).toContainText('3600.00');
    await pw(page.getByTestId('reconciled')).toHaveText('The register reconciles to the ledger.');
    // the asset: a disposal dated before the laptops were in use is refused, in the API's words
    await page.getByTestId('fa-assets').getByRole('link', { name: 'Laptops' }).click();
    await page.getByLabel('Disposed on').fill('2025-12-31');
    await page.getByTestId('dispose').getByLabel('Reason', { exact: true }).fill('Sold (synthetic)');
    await page.getByRole('button', { name: 'Dispose of the asset' }).click();
    await pw(page.getByTestId('dispose').getByRole('alert')).toContainText("The disposal date precedes the asset's use");
    await pw(page.getByTestId('asset-status')).toHaveText('ACTIVE');
    await page.context().close();
  });

  it('depreciation: the API\'s preview to 31.12.2026 posted as a run', async () => {
    const page = await open(accountant, '/registers/depreciation');
    await page.getByLabel('Depreciate to').fill('2026-12-31');
    await pw(page.getByTestId('dep-total')).toHaveText('1200.00');
    await page.getByRole('button', { name: 'Post the run' }).click();
    await pw(page.getByTestId('dep-runs').locator('tr[data-run="2026-12-31"]').getByTestId('run-status')).toHaveText('POSTED');
    await page.goto(`${WEB}${ws('/registers')}`);
    await page.getByTestId('fa-assets').getByRole('link', { name: 'Laptops' }).click();
    await pw(page.getByTestId('carrying-amount')).toHaveText('2400.00');
    await page.context().close();
  });

  it('adjustments and provisions: a prepayment released by a run; a provision made', async () => {
    let page = await open(accountant, '/registers/adjustments');
    await page.getByLabel('Kind').selectOption('PREPAYMENT');
    await page.getByLabel('Description').fill('Insurance');
    await page.getByLabel('Amount').fill('1200.00');
    await page.getByLabel('Date', { exact: true }).fill('2026-10-01');
    await pick(page, 'Profit and loss account', '6200 Insurance');
    await pick(page, 'Balance sheet account', '1120 Prepayments');
    await page.getByLabel('Period from').fill('2026-10-01');
    await page.getByLabel('Period to').fill('2027-09-30');
    await page.getByRole('button', { name: 'Create the item' }).click();
    await pw(page.getByTestId('ye-items').locator('tr[data-item="Insurance"]')).toContainText('ACTIVE');
    await page.getByLabel('Release to').fill('2026-12-31');
    await pw(page.getByTestId('release-total')).toHaveText('300.00');
    await page.getByRole('button', { name: 'Post the release run' }).click();
    await pw(page.getByTestId('release-runs').locator('tr[data-run="2026-12-31"]')).toContainText('POSTED');
    await pw(page.getByTestId('ye-register').getByTestId('reconciled')).toHaveText('The register reconciles to the ledger.');
    await page.context().close();
    page = await open(accountant, '/registers/provisions');
    await page.getByLabel('Name').fill('Dilapidations');
    await pick(page, 'Provision account', '2400');
    await pick(page, 'Expense account', '6100 Rent');
    await page.getByLabel('Basis').fill('Estimate of the cost to restore the premises (synthetic)');
    await page.getByRole('button', { name: 'Create the provision' }).click();
    const section = page.locator('section[data-provision="Dilapidations"]');
    await section.getByLabel('Date').fill('2026-12-31');
    await section.getByLabel('Amount').fill('500.00');
    await section.getByLabel('Reason').fill('Made at the year end (synthetic)');
    await section.getByRole('button', { name: 'Record the movement' }).click();
    await pw(section.getByTestId('provision-balance')).toHaveText('500.00');
    await page.context().close();
  });

  it('directors and related parties: a loan account with its statement; a related party in the report', async () => {
    let page = await open(accountant, '/registers/directors');
    await pick(page, 'Director or shareholder', 'Synthetic Director');
    await pick(page, 'Ledger account', "2230 Directors' loan account");
    await page.getByLabel('Opened on').fill('2026-01-01');
    await page.getByRole('button', { name: 'Open the account' }).click();
    const row = page.getByTestId('loan-accounts').locator('tr[data-loan="Synthetic Director"]');
    await pw(row).toContainText('ACTIVE');
    await row.getByRole('button', { name: 'Synthetic Director' }).click();
    await pw(page.getByTestId('loan-closing')).toHaveText('0.00');
    await page.context().close();
    page = await open(accountant, '/registers/related-parties');
    await pick(page, 'Party', 'Director Family Ltd');
    await page.getByLabel('Relationship').selectOption('ENTITY_CONTROLLED_BY_DIRECTOR');
    await page.getByLabel('Description').fill('Owned by the director (synthetic)');
    await page.getByLabel('From', { exact: true }).first().fill('2026-01-01');
    await page.getByRole('button', { name: 'Record the party' }).click();
    await pw(page.getByTestId('parties').locator('tr[data-party="Director Family Ltd"]')).toContainText('ACTIVE');
    await pw(page.getByTestId('party-report').locator('tr[data-party="Director Family Ltd"]')).toBeVisible();
    await page.context().close();
  });

  it('the closing journal: the API\'s preview for 2026 posted', async () => {
    const page = await open(accountant, '/registers/close');
    await page.getByLabel('Year start').fill('2026-01-01');
    await page.getByLabel('Year end').fill('2026-12-31');
    // hand figure for 2026: depreciation 1,200.00 + provision 500.00 + insurance (released 300.00 less the 1,200.00 the prepayment set-up
    // credited to it = -900.00) = expenses of 800.00 and no income: a loss, shown negative, of -800.00. The screen shows the API's figure.
    const pre = await ok(call(reviewer, 'get', co('/year-end-closes/preview?yearStart=2026-01-01&yearEnd=2026-12-31')));
    expect(pre.profit).toBe('-800.00');
    await pw(page.getByTestId('close-profit')).toHaveText(pre.profit);
    await page.getByRole('button', { name: 'Post the closing journal' }).click();
    await pw(page.getByTestId('closes').locator('tr[data-close="2026-01-01"]').getByTestId('close-status')).toHaveText('POSTED');
    await page.context().close();
  });

  it('a reviewer sees every register and no action button', async () => {
    for (const p of ['/registers', '/registers/depreciation', '/registers/adjustments', '/registers/provisions', '/registers/close', '/registers/directors', '/registers/related-parties']) {
      const page = await open(reviewer, p);
      await pw(page.getByTestId('registers-nav')).toBeVisible();
      await pw(page.locator('main .card').first()).not.toContainText('You do not have access');
      await pw(page.locator('main').getByRole('button', { name: /Create|Add|Post|Reverse|Cancel|Record|Open the account|Set the|Close|End|Dispose|Change/ })).toHaveCount(0);
      await page.context().close();
    }
  });
});
