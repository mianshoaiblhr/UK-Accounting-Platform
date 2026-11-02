import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedYear } from '../helpers/approved-year';
import { bearer, createUser, makeCompany, orgPath, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * UI-1 (DEC-076): screenshots of the main screens over the real stack, at desktop (1440x900) and phone (390x844) widths, for the
 * design record in docs/design/screens/. Runs only when SCREENS_OUT names the folder to write (for example
 * SCREENS_OUT=docs/design/screens/after); otherwise it is skipped, so CI does not write files. Synthetic data only. UI-2 (DEC-103): a named firm
 * with several clients, deadlines in each state and a client ready to file, so the screens can be compared with the approved design.
 */
const OUT = process.env.SCREENS_OUT;
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m1-micro-synthetic.json'), 'utf8')).version as { lines: Record<string, unknown>[]; mapEntries: [string, string | null, string][] };
let w: WebStack, stack: Stack, browser: Browser, owner: TestUser, author: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const call = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = async (r: Promise<{ status: number; body: any }>, status = 200) => { const x = await r; expect(x.status, JSON.stringify(x.body)).toBe(status); return x.body; };
const co = (p = '') => `/companies/${company.id}${p}`;

describe.skipIf(!OUT)('UI-1 screenshots', () => {
  beforeAll(async () => {
    w = await startWeb();
    ({ stack, browser } = w);
    owner = await createUser(stack, { type: 'PRACTICE', orgName: 'Hartley & Webb' });
    const { addMember } = await import('../helpers/stack');
    author = await addMember(stack, owner, 'admin');
    company = await makeCompany(stack, owner, 'Northwind Joinery Ltd');
    await ok(call(owner, 'post', co('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' }), 201);
    for (const a of (await ok(call(owner, 'post', co('/accounts/initialise')), 201)).items) acc[a.code] = a.id;
    await ok(call(owner, 'post', co('/accounts'), { code: '6950', name: 'Profit or loss on disposal of fixed assets', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', reportingMapping: 'PL.OTHER_EXPENSES' }), 201);
    const cash = (direction: string, date: string, account: string, amount: string, description: string) => ok(call(owner, 'post', co('/cash-transactions'), { direction, transactionDate: date, bankAccountId: acc['1200'], description, lines: [{ description, accountId: acc[account], amount }] }), 201);
    await cash('RECEIPT', '2026-01-02', '3000', '10000.00', 'Shares issued');
    const laptops = await cash('PAYMENT', '2026-01-05', '0030', '3600.00', 'Laptops');
    await cash('RECEIPT', '2026-03-03', '4000', '6400.00', 'Fitted kitchen, Harrogate');
    await cash('PAYMENT', '2026-03-05', '6100', '1250.00', 'Workshop rent, March');
    await cash('PAYMENT', '2026-03-09', '6200', '480.00', 'Public liability insurance');
    const k = await ok(call(owner, 'post', co('/fixed-asset-classes'), { code: 'OFFICE', name: 'Office equipment', costAccountId: acc['0030'], depreciationAccountId: acc['0031'], expenseAccountId: acc['6900'],
      disposalAccountId: (await ok(call(owner, 'get', co('/accounts')))).items.find((a: any) => a.code === '6950').id, method: 'STRAIGHT_LINE', lifeMonths: 36, convention: 'MONTHLY' }), 201);
    await ok(call(owner, 'post', co('/fixed-assets'), { classId: k.id, description: 'Laptops', acquiredOn: '2026-01-05', cost: '3600.00', addition: { kind: 'LINKED', journalId: laptops.journalId } }), 201);
    const std = (await ok(call(author, 'post', co('/reporting-standards'), { code: 'SYN-UI', name: 'Synthetic standard for the screenshots' }), 201)).id;
    const ver = (await ok(call(author, 'post', co(`/reporting-standards/${std}/versions`), { label: 'Synthetic v1', effectiveFrom: '2020-01-01', source: { url: 'https://example.test/synthetic', provision: 'Synthetic test content', retrievedOn: '2026-10-25' } }), 201)).id;
    const v = co(`/reporting-standard-versions/${ver}`);
    for (const l of G.lines) await ok(call(author, 'post', `${v}/lines`, l), 201);
    for (const [sourceLine, accountSubtype, targetKey] of G.mapEntries) await ok(call(author, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey }), 201);
    await ok(call(owner, 'post', `${v}/verify`, { notes: 'Synthetic version for the screenshots' }));
    await ok(call(owner, 'put', co('/reporting-frameworks'), { yearStart: '2026-01-01', yearEnd: '2026-12-31', versionId: ver, entitySize: 'MICRO', reason: 'Synthetic' }));
    // UI-2 (DEC-103): more clients, deadlines in each state, one client ready to file (all synthetic)
    const ukToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const shift = (days: number) => { const d = new Date(`${ukToday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
    const clients: Record<string, { id: string }> = { 'Northwind Joinery Ltd': company };
    for (const [n, form] of [['Brightwater Cafe Ltd', 'LTD'], ['Oakfield Lettings LLP', 'LLP'], ['Kestrel Joinery Ltd', 'LTD'], ['Tom Fairley', 'SOLE_TRADER']] as const) {
      clients[n] = await makeCompany(stack, owner, n);
      if (form !== 'LTD') await ok(call(owner, 'patch', `/companies/${clients[n]!.id}`, { legalForm: form }));
    }
    clients['Marlow Dental Ltd'] = (await approvedYear(stack, owner, { name: 'Marlow Dental Ltd', companyNumber: '05678901', standardCode: 'SYN-UI2' })).company;
    const deadlines: [string, string, number, string, string?][] = [
      ['Tom Fairley', 'VAT_RETURN', -81, 'NOT_STARTED'], ['Brightwater Cafe Ltd', 'ACCOUNTS_FILING', 4, 'WAITING_ON_CLIENT'], ['Marlow Dental Ltd', 'CT_PAYMENT', 5, 'IN_PROGRESS'],
      ['Oakfield Lettings LLP', 'CONFIRMATION_STATEMENT', 7, 'NOT_STARTED'], ['Northwind Joinery Ltd', 'VAT_RETURN', 11, 'READY'], ['Kestrel Joinery Ltd', 'VAT_RETURN', 11, 'WAITING_ON_CLIENT'],
    ];
    for (const [n, kind, days, status] of deadlines) {
      const o = await ok(call(owner, 'post', `/companies/${clients[n]!.id}/compliance/obligations`, { kind, dueDate: shift(days), reason: 'Synthetic deadline for the screenshots' }), 201);
      if (status !== 'NOT_STARTED') await ok(call(owner, 'patch', `/companies/${clients[n]!.id}/compliance/obligations/${o.id}`, { version: 1, status }));
    }
  }, 300_000);
  afterAll(async () => { await stopWeb(w ?? {}); });

  it('captures the main screens at desktop and phone widths', async () => {
    mkdirSync(OUT!, { recursive: true });
    const base = `/org/${owner.organisationId}/companies/${company.id}`;
    const shots: [string, string][] = [
      ['companies', '/'], ['dashboard', `${base}?asOf=2026-06-30`], ['trial-balance', `${base}/trial-balance`], ['balance-sheet', `${base}/reports/balance-sheet`],
      ['journals', `${base}/journals`], ['year-end', `${base}/year-end?year=2026-01-01`], ['fixed-assets', `${base}/registers`],
      ['practice-overview', `/org/${owner.organisationId}/overview`], ['clients', `/org/${owner.organisationId}/clients`], ['deadlines', `/org/${owner.organisationId}/deadlines`],
      ['profit-and-loss', `${base}/reports/profit-and-loss`], ['sales', `${base}/sales`], ['purchases', `${base}/purchases`], ['bank', `${base}/bank`], ['ledger', `${base}/ledger`],
      ['vat-returns', `${base}/vat-returns`], ['compliance', `${base}/compliance`],
    ];
    for (const [width, height, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']] as const) {
      const page = await signIn(browser, owner.email);
      await page.setViewportSize({ width, height });
      for (const [name, path] of shots) {
        await page.goto(`${WEB}${path}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/${name}-${tag}.png`, fullPage: false });
      }
      await page.context().close();
      const anon = await (await browser.newContext({ baseURL: WEB, viewport: { width, height } })).newPage();
      await anon.goto('/login'); await anon.waitForLoadState('networkidle');
      await anon.screenshot({ path: `${OUT}/login-${tag}.png` });
      await anon.context().close();
    }
  });
});
