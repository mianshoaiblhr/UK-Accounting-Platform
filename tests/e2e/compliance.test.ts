import { expect as pw } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * V7-M1 (DEC-088, DEC-050) in a real browser over the real stack: a manager creates a client's deadlines from a verified (SYNTHETIC) rule,
 * moves one to waiting on the client, is refused in the API's words, and sees it on the practice deadlines page with the API's counts;
 * a reviewer sees the deadlines without any action; with the feature off the pages say so. The screens compute nothing.
 */
let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser, admin: TestUser, manager: TestUser, reviewer: TestUser;
let company: { id: string };
const call = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = async (r: Promise<{ status: number; body: any }> | { status: number; body: any }, status = 200) => { const x = await r; expect(x.status, JSON.stringify(x.body)).toBe(status); return x.body; };
const page = async (u: TestUser, path: string): Promise<Page> => { const p = await signIn(browser, u.email); await p.goto(`${WEB}${path}`); return p; };
const client = (p = '') => `/org/${owner.organisationId}/companies/${company.id}${p}`;
const SOURCE = { url: 'https://example.test/synthetic-deadline', provision: 'Synthetic Filing Act 2026 s.1 (test fixture)', retrievedOn: '2026-10-27' };

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  company = await makeCompany(stack, owner, 'Deadline Screens Ltd');
  admin = await addMember(stack, owner, 'admin');
  manager = await addMember(stack, owner, 'manager');
  reviewer = await addMember(stack, owner, 'reviewer');
  await ok(call(owner, 'post', `/companies/${company.id}/periods`, { startDate: '2025-01-01', endDate: '2025-12-31' }), 201);
  const rule = await ok(call(owner, 'post', '/compliance/deadline-rules', { kind: 'ACCOUNTS_FILING', legalForms: ['LTD'], months: 9, monthEndRule: true, effectiveFrom: '2000-01-01', source: SOURCE }), 201);
  await ok(call(admin, 'post', `/compliance/deadline-rules/${rule.id}/verify`, { notes: 'Synthetic rule checked for the screens test' }));
});
afterAll(async () => { await stopWeb(w ?? {}); });

describe('V7-M1 compliance calendar in the browser', () => {
  it('a manager creates the client\'s deadlines from the verified rule and is told what does not apply', async () => {
    const p = await page(manager, client('/compliance'));
    await pw(p.getByRole('heading', { name: 'Deadlines', exact: true })).toBeVisible();
    await pw(p.getByRole('link', { name: 'Deadlines', exact: true })).toHaveAttribute('aria-current', 'page');
    await p.getByLabel('From (optional)').fill('2025-01-01');
    await p.getByLabel('Through').fill('2025-12-31');
    await p.getByRole('button', { name: 'Create deadlines' }).click();
    await pw(p.getByRole('status').filter({ hasText: 'created' })).toContainText('1 created, 0 already there.');
    const row = p.getByTestId('obligations').locator('tr', { hasText: 'Annual accounts to Companies House' });
    await pw(row).toContainText('2025-01-01 to 2025-12-31');
    await pw(row).toContainText('2026-09-30');
    await pw(p.getByTestId('generation-notes')).toContainText('VAT return: The client is not VAT registered');
    await p.context().close();
  });

  it('a refusal is shown in the API\'s words; a change is saved against its version', async () => {
    const p = await page(manager, client('/compliance'));
    const row = p.getByTestId('obligations').locator('tr', { hasText: 'Annual accounts to Companies House' });
    await row.getByRole('combobox').selectOption('NOT_REQUIRED');
    await row.getByRole('button', { name: 'Save' }).click();
    await pw(row.getByRole('alert')).toContainText('Marking an obligation not required needs a reason');
    await row.getByRole('combobox').selectOption('WAITING_ON_CLIENT');
    await row.getByRole('button', { name: 'Save' }).click();
    await pw(p.getByTestId('obligations').locator('tr', { hasText: 'Annual accounts to Companies House' }).getByTestId('obligation-status')).toHaveText('Waiting on the client');
    await p.context().close();
  });

  it('the practice deadlines page shows the API\'s counts and the client\'s deadline with a link back', async () => {
    const p = await page(manager, `/org/${owner.organisationId}/deadlines`);
    await pw(p.getByTestId('count-waiting')).toHaveText('1');
    await p.getByRole('link', { name: 'All open' }).click();
    const row = p.getByTestId('practice-deadlines').locator('tr', { hasText: 'Deadline Screens Ltd' });
    await pw(row).toContainText('Annual accounts to Companies House');
    await pw(row.getByTestId('obligation-status')).toHaveText('Waiting on the client');
    await row.getByRole('link', { name: 'Deadline Screens Ltd' }).click();
    await p.waitForURL(`${WEB}${client('/compliance')}`);
    await p.context().close();
  });

  it('a reviewer reads the deadlines and has no action', async () => {
    const p = await page(reviewer, client('/compliance'));
    await pw(p.getByTestId('obligations')).toContainText('Annual accounts to Companies House');
    await pw(p.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await pw(p.getByRole('button', { name: 'Create deadlines' })).toHaveCount(0);
    await pw(p.getByRole('button', { name: 'Add the deadline' })).toHaveCount(0);
    await p.context().close();
  });

  it('with practice management off, both pages say so and the sidebar has no deadlines', async () => {
    await ok(call(owner, 'put', '/feature-flags/practice.management', { enabled: false, reason: 'Screens off for the e2e test' }));
    try {
      let p = await page(manager, client('/compliance'));
      await pw(p.getByTestId('feature-off')).toContainText('Practice management is not enabled');
      await pw(p.getByRole('link', { name: 'Deadlines', exact: true })).toHaveCount(0);
      await p.context().close();
      p = await page(manager, `/org/${owner.organisationId}/deadlines`);
      await pw(p.getByTestId('feature-off')).toContainText('Practice management is not enabled');
      await p.context().close();
    } finally {
      await call(owner, 'put', '/feature-flags/practice.management', { enabled: true, reason: 'Screens back on' });
    }
  });
});
