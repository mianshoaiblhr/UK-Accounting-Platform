import { expect as pw } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * V7-M2 (DEC-089, DEC-050) in a real browser over the real stack: the practice shell, the overview with the API's counts, deadlines and open
 * work, and the client list with its search and the manager filter. Deadlines are entered through the API relative to the UK date; the
 * pages count nothing themselves. A client viewer, who may read no deadlines, is told so by the API.
 */
let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser, manager: TestUser, viewer: TestUser;
let alder: { id: string }, birch: { id: string };
const call = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = async (r: Promise<{ status: number; body: any }> | { status: number; body: any }, status = 200) => { const x = await r; expect(x.status, JSON.stringify(x.body)).toBe(status); return x.body; };
const page = async (u: TestUser, path: string): Promise<Page> => { const p = await signIn(browser, u.email); await p.goto(`${WEB}${path}`); return p; };
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (days: number) => { const d = new Date(`${ukToday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const org = (p: string) => `/org/${owner.organisationId}${p}`;

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  alder = await makeCompany(stack, owner, 'Alder Screens Ltd');
  birch = await makeCompany(stack, owner, 'Birch Screens Ltd');
  manager = await addMember(stack, owner, 'manager');
  viewer = await addMember(stack, owner, 'client_viewer');
  const late = await ok(call(owner, 'post', `/companies/${alder.id}/compliance/obligations`, { kind: 'OTHER', title: 'Alder board pack', dueDate: shift(-2), reason: 'Internal deadline for the test' }), 201);
  await ok(call(owner, 'patch', `/companies/${alder.id}/compliance/obligations/${late.id}`, { version: 1, status: 'IN_PROGRESS' }));
  const soon = await ok(call(owner, 'post', `/companies/${birch.id}/compliance/obligations`, { kind: 'OTHER', title: 'Birch records', dueDate: shift(5), reason: 'Internal deadline for the test' }), 201);
  await ok(call(owner, 'patch', `/companies/${birch.id}/compliance/obligations/${soon.id}`, { version: 1, status: 'WAITING_ON_CLIENT' }));
  await ok(call(owner, 'put', `/companies/${birch.id}/compliance/profile`, { clientManagerUserId: manager.userId, reason: 'Manager for this client' }));
});
afterAll(async () => { await stopWeb(w ?? {}); });

describe('V7-M2 practice overview and client list in the browser', () => {
  it('the overview shows the API\'s counts, the deadlines due soon, the open work and the connections as they stand', async () => {
    const p = await page(owner, org('/overview'));
    await pw(p.getByRole('navigation', { name: 'Practice' }).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await pw(p.getByTestId('count-overdue')).toHaveText('1');
    await pw(p.getByTestId('count-waiting')).toHaveText('1');
    const deadlines = p.getByTestId('overview-deadlines');
    await pw(deadlines.locator('tr', { hasText: 'Alder board pack' })).toContainText('Overdue');
    await pw(deadlines.locator('tr', { hasText: 'Birch records' }).getByTestId('obligation-status')).toHaveText('Waiting on the client');
    await pw(p.getByTestId('work-by-status').locator('tr', { hasText: 'In progress' })).toContainText('1');
    await pw(p.getByTestId('work-by-status').locator('tr', { hasText: 'Waiting on the client' })).toContainText('1');
    await pw(p.getByTestId('connections')).toContainText('Not connected');
    await p.context().close();
  });

  it('the client list shows each client with its next deadline and manager; search and the manager filter go to the API', async () => {
    const p = await page(manager, org('/clients'));
    await pw(p.getByRole('navigation', { name: 'Practice' }).getByRole('link', { name: 'Clients' })).toHaveAttribute('aria-current', 'page');
    const alderRow = p.getByTestId('clients').locator('tr', { hasText: 'Alder Screens Ltd' });
    await pw(alderRow).toContainText('Alder board pack');
    await pw(alderRow).toContainText('Overdue');
    await pw(p.getByTestId('clients').locator('tr', { hasText: 'Birch Screens Ltd' })).toContainText('Birch records');
    await p.getByLabel('Find a client').fill('birch');
    await pw(p.getByTestId('clients').locator('tbody tr')).toHaveCount(1);
    await p.getByLabel('Find a client').fill('');
    await p.getByLabel('Only clients I manage').check();
    await pw(p.getByTestId('clients').locator('tbody tr')).toHaveCount(1);
    await pw(p.getByTestId('clients')).toContainText('Birch Screens Ltd');
    await p.context().close();
  });

  it('a client viewer is told by the API that they cannot read the practice\'s deadlines', async () => {
    const p = await page(viewer, org('/overview'));
    await pw(p.locator('main').getByRole('alert')).toContainText('You do not have permission');
    await p.context().close();
  });
});
