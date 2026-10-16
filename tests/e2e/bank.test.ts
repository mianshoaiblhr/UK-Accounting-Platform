import { expect as pw } from '@playwright/test';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, type Stack, type TestUser } from '../helpers/stack';
import { signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * M9c (plan 13.3) in a real browser over the real stack, with the real worker importing the statement. Synthetic April 2026:
 *   statement opens at 0.00 on 31 March; 1 April CUSTOMER RECEIPT 500.00 in; 3 April BANK CHARGE 5.00 out -> 495.00
 *   ledger: a cash receipt of 500.00 into the bank on 1 April (matched from the suggestion); the charge posted from its line
 *   proof at 30 April: statement 495.00 = ledger 495.00, difference 0.00; signed off against the bank's closing balance 495.00
 */
let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser, bookkeeper: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
let bankId = '';
const call = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const co = (p: string) => `/companies/${company.id}${p}`;
const ws = (p = '') => `/org/${owner.organisationId}/companies/${company.id}${p}`;
const CSV = 'Date,Description,Paid in,Paid out,Balance\r\n01/04/2026,CUSTOMER RECEIPT,500.00,,500.00\r\n03/04/2026,BANK CHARGE,,5.00,495.00\r\n';

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  company = await makeCompany(stack, owner, 'Bank Screens Ltd');
  bookkeeper = await addMember(stack, owner, 'bookkeeper');
  accountant = await addMember(stack, owner, 'accountant');
  reviewer = await addMember(stack, owner, 'reviewer');
  expect((await call(owner, 'post', co('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' })).status).toBe(201);
  expect((await call(owner, 'post', co('/accounts/initialise'))).status).toBe(201);
  for (const [code, direction] of [['INS', 'SALES'], ['INP', 'PURCHASES']]) {
    expect((await call(owner, 'post', co('/tax-codes'), { code, name: `Synthetic ${direction.toLowerCase()}`, treatment: 'STANDARD', direction, reverseCharge: false })).status).toBe(201);
  }
});
afterAll(async () => { await stopWeb(w ?? {}); });

describe('M9c bank, cash and reconciliation in the browser', () => {
  it('a bookkeeper adds a bank account (details shown masked only) and imports a CSV statement through the screen', async () => {
    const page = await signIn(browser, bookkeeper.email);
    await page.goto(ws('/bank'));
    const form = page.getByTestId('new-bank-account');
    await form.getByLabel('Ledger account').selectOption({ label: '1200 Bank current account' });
    await form.getByLabel('Name', { exact: true }).fill('Main account');
    await form.getByLabel('Bank', { exact: true }).fill('Synthetic Bank');
    await form.getByLabel('Statement opening date').fill('2026-03-31');
    await form.getByLabel('Statement opening balance').fill('0.00');
    await form.getByLabel('Sort code (stored encrypted)').fill('112233');
    await form.getByLabel('Account number (stored encrypted)').fill('44556677');
    await form.getByLabel('Account for bank charges').selectOption({ label: '6800 Bank charges' });
    await form.getByRole('button', { name: 'Add bank account' }).click();
    await pw(form.getByRole('status')).toContainText('Bank account added');
    const table = page.getByTestId('bank-accounts');
    await pw(table).toContainText('Main account');
    await pw(table).not.toContainText('44556677');
    await pw(table).not.toContainText('112233');
    bankId = (await call(bookkeeper, 'get', co('/bank-accounts'))).body.items[0].id;

    await table.getByRole('link', { name: 'Main account' }).click();
    await page.getByLabel('Statement file (CSV)').setInputFiles({ name: 'april.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    // the columns are offered from the file's header row and guessed by name
    await pw(page.getByLabel('Money in column')).toHaveValue('Paid in');
    await pw(page.getByLabel('Balance column')).toHaveValue('Balance');
    await page.getByRole('button', { name: 'Import statement' }).click();
    await pw(page.getByRole('status')).toContainText('Imported 2 line(s)', { timeout: 30_000 });
    await pw(page.getByTestId('statement-lines')).toContainText('BANK CHARGE');
    await pw(page.getByTestId('imports')).toContainText('COMPLETED');
    await page.context().close();
  });

  it('an accountant records money in (only codes of its direction are offered), matches the line from the suggestion, posts the charge and signs off at zero difference', async () => {
    const page = await signIn(browser, accountant.email);
    await page.goto(ws('/cash'));
    const form = page.getByTestId('record-cash');
    await form.getByLabel('Direction').selectOption({ label: 'Money in' });
    const vat = form.getByLabel('Cash line 1 VAT code');
    await pw(vat.locator('option', { hasText: /^INS / })).toHaveCount(1); // waits for the codes to load
    await pw(vat.locator('option', { hasText: /^INP / })).toHaveCount(0);
    await form.getByLabel('Date').fill('2026-04-01');
    await form.getByLabel('Bank or cash account').selectOption({ label: '1200 Bank current account' });
    await form.getByLabel('Description', { exact: true }).fill('Customer paid in full');
    await form.getByLabel('Cash line 1 description').fill('Synthetic sale');
    await form.getByLabel('Cash line 1 account').selectOption({ label: '4000 Sales - standard rated' });
    await form.getByLabel('Cash line 1 amount').fill('500.00');
    await form.getByRole('button', { name: 'Record', exact: true }).click();
    await pw(page.getByRole('status')).toContainText('Recorded');
    await pw(page.getByTestId('cash')).toContainText('Customer paid in full');

    await page.goto(ws(`/bank/${bankId}/reconcile`));
    await page.getByLabel('As at').fill('2026-04-30');
    const s = page.getByTestId('suggestions');
    await s.locator('tr[data-line="CUSTOMER RECEIPT"]').getByRole('button', { name: 'Match' }).click();
    await pw(page.getByTestId('rec-msg')).toContainText('Matched');
    await s.locator('tr[data-line="BANK CHARGE"]').getByRole('button', { name: 'Post as bank charge' }).click();
    await pw(page.getByTestId('rec-msg')).toContainText('Posted as charge');
    const proof = (await call(accountant, 'get', co(`/bank-accounts/${bankId}/reconciliation?asOf=2026-04-30`))).body;
    expect([proof.statementBalance, proof.ledgerBalance, proof.difference, proof.reconciled]).toEqual(['495.00', '495.00', '0.00', true]);
    await pw(page.getByTestId('proof-difference')).toHaveText('0.00');
    await pw(page.getByTestId('proof-status')).toContainText('Reconciled');
    await page.getByLabel(/Closing balance on the bank/).fill('495.00');
    await page.getByTestId('sign-off').getByRole('button', { name: 'Sign off' }).click();
    await pw(page.getByTestId('sign-offs')).toContainText('2026-04-30');
    // a match can be undone with a reason; the line is unmatched again
    await page.getByTestId('matched-lines').locator('tr', { hasText: 'CUSTOMER RECEIPT' }).getByRole('button', { name: 'Show matches' }).click();
    await page.getByLabel('Reason to undo the match').fill('Matched to the wrong receipt (synthetic)');
    await page.getByRole('button', { name: 'Undo match' }).click();
    await pw(page.getByTestId('rec-msg')).toContainText('Match undone');
    await pw(page.getByTestId('open-statement')).toContainText('CUSTOMER RECEIPT');
    await page.context().close();
  });

  it('a transfer from the bank to cash in hand is recorded and then reversed with a reason', async () => {
    const page = await signIn(browser, accountant.email);
    await page.goto(ws('/bank/transfers'));
    const form = page.getByTestId('record-transfer');
    await form.getByLabel('From').selectOption({ label: '1200 Bank current account' });
    await form.getByLabel('To', { exact: true }).selectOption({ label: '1220 Cash in hand' });
    await form.getByLabel('Amount').fill('50.00');
    await form.getByLabel('Description').fill('Petty cash float');
    await form.getByRole('button', { name: 'Record transfer' }).click();
    await pw(page.getByRole('status')).toContainText('Transfer recorded');
    await page.getByLabel('Reason to reverse Petty cash float').fill('Float not needed (synthetic)');
    await page.getByTestId('transfers').getByRole('button', { name: 'Reverse' }).click();
    await pw(page.getByRole('status')).toContainText('Transfer reversed');
    await pw(page.getByTestId('transfers')).toContainText('REVERSED');
    await page.context().close();
  });

  it('a reviewer reads bank, reconciliation and cash without any action, and the API refuses a match anyway', async () => {
    const page = await signIn(browser, reviewer.email);
    await page.goto(ws('/bank'));
    await pw(page.getByTestId('bank-accounts')).toContainText('Main account');
    await pw(page.getByTestId('new-bank-account')).toHaveCount(0);
    await page.goto(ws(`/bank/${bankId}`));
    await pw(page.getByTestId('statement-lines')).toBeVisible();
    await pw(page.getByTestId('import-form')).toHaveCount(0);
    await page.goto(ws(`/bank/${bankId}/reconcile`));
    await pw(page.getByTestId('proof')).toBeVisible();
    await pw(page.getByRole('button', { name: /^(Match|Post as bank charge|Sign off|Match the selected pair)$/ })).toHaveCount(0);
    await page.goto(ws('/cash'));
    await pw(page.getByTestId('cash')).toBeVisible();
    await pw(page.getByTestId('record-cash')).toHaveCount(0);
    const line = (await call(owner, 'get', co(`/bank-accounts/${bankId}/statement-lines?status=UNMATCHED`))).body.items[0];
    expect((await call(reviewer, 'post', co('/bank-matches'), { statementLineId: line.id, journalLineId: '11111111-1111-4111-8111-111111111111' })).status).toBe(403);
    await page.context().close();
  });
});
