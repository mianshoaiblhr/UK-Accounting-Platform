import { expect as pw } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * V5-M3 (DEC-092, DEC-050) in a real browser over the real stack: an accountant opens and prepares a synthetic quarter and explains its flags,
 * a partner reviews, records the client's approval (after a refusal shown in the API's words) and records the filing made elsewhere; a reader
 * sees the return with no action; with the feature off the page says so. SYNTHETIC rates, amounts and receipts; nothing is sent to HMRC.
 */
let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser, partner: TestUser, accountant: TestUser, reviewer: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const c = (p: string) => `/companies/${company.id}${p}`;
const call = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = async (r: Promise<{ status: number; body: any }> | { status: number; body: any }, status = 200) => { const x = await r; expect(x.status, JSON.stringify(x.body)).toBe(status); return x.body; };
const open = async (u: TestUser, path: string): Promise<Page> => { const p = await signIn(browser, u.email); await p.goto(`${WEB}/org/${owner.organisationId}/companies/${company.id}${path}`); return p; };
const SOURCE = { url: 'https://example.invalid/synthetic-rule', provision: 'Synthetic Act 2026 s.1 (test fixture)', retrievedOn: '2026-01-01' };
const sale = (net: string, date: string, taxPoint?: string) => ({ journalDate: date, ...(taxPoint ? { taxPoint } : {}), description: 'Synthetic sale',
  lines: [{ accountId: acc['1110'], debit: (Number(net) * 1.2).toFixed(2), credit: '0' }, { accountId: acc['4000'], debit: '0', credit: net, taxCodeId: acc.SX }] });
let returnPath = '';

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  company = await makeCompany(stack, owner, 'Screen VAT Client Ltd');
  partner = await addMember(stack, owner, 'partner');
  accountant = await addMember(stack, owner, 'accountant');
  reviewer = await addMember(stack, owner, 'reviewer');
  await ok(call(owner, 'post', c('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' }), 201);
  for (const a of (await ok(call(owner, 'post', c('/accounts/initialise')), 201)).items) acc[a.code] = a.id;
  acc['1150'] = (await ok(call(owner, 'post', c('/accounts'), { code: '1150', name: 'VAT recoverable', type: 'ASSET', subtype: 'CURRENT_ASSET_VAT', reportingMapping: 'BS.CURRENT_ASSETS.DEBTORS', taxTreatment: 'VAT_CONTROL' }), 201)).id;
  acc['2202'] = (await ok(call(owner, 'post', c('/accounts'), { code: '2202', name: 'VAT liability', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY_TAX', reportingMapping: 'BS.CREDITORS_WITHIN_ONE_YEAR' }), 201)).id;
  acc.SX = (await ok(call(accountant, 'post', c('/tax-codes'), { code: 'SX', name: 'Synthetic standard sales', treatment: 'STANDARD', direction: 'SALES' }), 201)).id;
  const rate = (await ok(call(accountant, 'post', c(`/tax-codes/${acc.SX}/rates`), { rate: '20', effectiveFrom: '2026-01-01', netBoxes: [6], vatBoxes: [1], source: SOURCE }), 201)).id;
  await ok(call(owner, 'post', c(`/tax-rates/${rate}/verify`), { notes: 'Checked against the synthetic test source' }));
  await ok(call(accountant, 'put', c('/vat-settings'), { registered: true, vrn: 'GB123456789', registeredFrom: '2026-01-01', scheme: 'STANDARD', periodMonths: 3, anchorPeriodEnd: '2026-03-31',
    outputAccountId: acc['2200'], inputAccountId: acc['1150'], liabilityAccountId: acc['2202'], reason: 'Registered from 1 January (synthetic)' }));
  const rule = (await ok(call(accountant, 'post', c('/vat-presentation-rules'), { method: 'TRUNCATE_PENCE', effectiveFrom: '2026-01-01', source: SOURCE }), 201)).id;
  await ok(call(owner, 'post', c(`/vat-presentation-rules/${rule}/verify`), { notes: 'Checked against the synthetic notice' }));
  await ok(call(accountant, 'post', c('/journals'), sale('1000.00', '2026-02-10')), 201);
  await ok(call(accountant, 'post', c('/journals'), sale('100.00', '2026-04-05', '2026-03-30')), 201);   // entered after the quarter: two flags
  await ok(call(owner, 'post', '/contacts', { companyId: company.id, kind: 'PERSON', name: 'Ruth Synthetic' }), 201);
  const d = await uploadDoc(stack, owner, { companyId: company.id, name: 'client-approval-and-hmrc-receipt.pdf' }); await waitForVersion(stack, owner, d.documentId, d.versionId);
});
afterAll(async () => { await stopWeb(w ?? {}); });

describe('V5-M3 the VAT return in the browser', () => {
  it('an accountant opens the return for the quarter, sees the boxes and their lines, prepares it and explains its flags', async () => {
    const p = await open(accountant, '/vat-returns');
    await pw(p.getByRole('navigation').getByRole('link', { name: 'VAT returns' })).toHaveAttribute('aria-current', 'page');
    await p.getByLabel('A day in the period').fill('2026-02-15');
    await p.getByRole('button', { name: 'Open the return' }).click();
    await pw(p.getByRole('heading', { name: 'VAT return for 2026-01-01 to 2026-03-31' })).toBeVisible();
    returnPath = new URL(p.url()).pathname;
    await pw(p.getByTestId('return-status')).toHaveText('Draft');
    await pw(p.getByTestId('box-1')).toHaveText('220.00');
    await pw(p.getByTestId('box-6')).toHaveText('1100.00');
    await p.locator('tr[data-box="1"] summary').click();
    await pw(p.getByTestId('box-1-lines').locator('tbody tr')).toHaveCount(2);
    await pw(p.getByTestId('reconciliation-difference')).toHaveText('-20.00');
    await pw(p.getByTestId('vat-flags').locator('li')).toHaveCount(2);
    await p.getByRole('button', { name: 'Mark as prepared' }).click();
    await pw(p.getByTestId('return-status')).toHaveText('Prepared');
    await pw(p.getByRole('button', { name: 'Record the review' })).toHaveCount(0);   // the accountant has no vat:review
    for (const key of ['reconciliation_difference', 'late_posting']) {
      const flag = p.locator(`li[data-flag^="${key}"]`);
      await flag.getByLabel('Explanation').fill('The sale was invoiced in March and entered in April (synthetic)');
      await flag.getByRole('button', { name: 'Save the explanation' }).click();
      await pw(flag.getByTestId('flag-explanation')).toBeVisible();
    }
    await pw(p.getByTestId('unexplained')).toHaveCount(0);
    await pw(p.getByTestId('sign-off').locator('tr[data-event="PREPARED"]')).toContainText(accountant.displayName);
    await p.context().close();
  });

  it('a partner reviews, is refused an approval dated inside the period in the API\'s words, records the approval and then the filing', async () => {
    const p = await signIn(browser, partner.email);
    await p.goto(`${WEB}${returnPath}`);
    await p.getByRole('button', { name: 'Record the review' }).click();
    await pw(p.getByTestId('return-status')).toHaveText('Reviewed');
    await p.getByLabel('Approved by').selectOption({ label: 'Ruth Synthetic' });
    await p.getByLabel('Evidence (the client\'s approval)').selectOption({ label: 'client-approval-and-hmrc-receipt.pdf' });
    await p.getByLabel('Approved on').fill('2026-03-31');
    await p.getByRole('button', { name: 'Record the approval and lock the period' }).click();
    await pw(p.locator('main').getByRole('alert')).toContainText('after the period ends');
    await p.getByLabel('Approved on').fill('2026-04-20');
    await p.getByRole('button', { name: 'Record the approval and lock the period' }).click();
    await pw(p.getByTestId('return-status')).toHaveText('Approved by the client');
    await pw(p.getByTestId('filed-6')).toHaveText('1100');
    await p.getByLabel('Submitted on').fill('2026-05-02');
    await p.getByLabel('HMRC receipt reference (form bundle number)').fill('123456789012');
    await p.getByLabel('Evidence (HMRC\'s receipt)').selectOption({ label: 'client-approval-and-hmrc-receipt.pdf' });
    await p.getByLabel(/submitted to HMRC as the client approved it/).check();
    await p.getByRole('button', { name: 'Record the filing' }).click();
    await pw(p.getByTestId('filings').locator('tr[data-filing="RECORDED"]')).toContainText('123456789012');
    await pw(p.getByTestId('filings').locator('tr[data-filing="RECORDED"]')).toContainText('liability posted');
    await pw(p.getByRole('button', { name: 'Record the filing' })).toHaveCount(0);
    await p.context().close();
  });

  it('a reviewer reads the return and its sign-off with no action', async () => {
    const p = await signIn(browser, reviewer.email);
    await p.goto(`${WEB}${returnPath}`);
    await pw(p.getByTestId('return-status')).toHaveText('Approved by the client');
    await pw(p.getByTestId('sign-off').locator('tr')).toHaveCount(3);
    await pw(p.getByRole('button')).toHaveCount(1);   // only "Sign out"
    await p.context().close();
  });

  it('with VAT returns off for the organisation, the page says so', async () => {
    const solo = await createUser(stack, { type: 'PRACTICE' });
    const co = await makeCompany(stack, solo, 'Flag Off VAT Ltd');
    expect((await stack.api().put(orgPath(solo, '/feature-flags/vat.returns')).set(bearer(solo.token)).send({ enabled: false, reason: 'Off for the test' })).status).toBe(200);
    const p = await signIn(browser, solo.email);
    await p.goto(`${WEB}/org/${solo.organisationId}/companies/${co.id}/vat-returns`);
    await pw(p.getByTestId('feature-off')).toContainText('VAT returns is not enabled');
    await p.context().close();
  });
});
