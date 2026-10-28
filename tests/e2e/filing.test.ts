import { expect as pw } from '@playwright/test';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedYear, type ApprovedYear } from '../helpers/approved-year';
import { bearer, createUser, orgPath, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * V3-M4 (DEC-096, DEC-050) in a real browser over the real stack: the practice verifies a synthetic taxonomy mapping; an accountant generates
 * the iXBRL document of the approved year; a partner starts and validates the filing and is refused the authority in the API's words; the owner
 * records the authority, submits and reads the status (the fake adapter accepts); a reviewer reads with no action. Nothing reaches Companies House.
 */
let w: WebStack, stack: Stack, browser: Browser;
let owner: TestUser;
let y: ApprovedYear;
let versionId: string;
const SOURCE = { url: 'https://example.invalid/synthetic-taxonomy', provision: 'Synthetic taxonomy 2026 (test fixture)', retrievedOn: '2026-01-01' };
const call = (u: TestUser, m: 'get' | 'post', p: string, b?: object) => stack.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const open = async (u: TestUser, path: string): Promise<Page> => { const p = await signIn(browser, u.email); await p.goto(`${WEB}/org/${owner.organisationId}${path}`); return p; };

beforeAll(async () => {
  w = await startWeb();
  ({ stack, browser } = w);
  owner = await createUser(stack, { type: 'PRACTICE' });
  y = await approvedYear(stack, owner, { name: 'Screen Filing Ltd', companyNumber: '01234567' });
  const v = await call(y.author, 'post', '/ixbrl/taxonomy-versions', { label: 'Synthetic screen mapping', standardCode: y.standardCode, entryPoint: 'https://example.invalid/tax/entry.xsd',
    namespaces: { core: 'https://example.invalid/core', bus: 'https://example.invalid/bus' }, entityScheme: 'https://example.invalid/registry', effectiveFrom: '2020-01-01', source: SOURCE });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  versionId = v.body.id;
  for (const e of [{ sourceKind: 'COMPANY', sourceKey: 'company.name', concept: 'bus:EntityName', dataType: 'TEXT', periodType: 'DURATION', mandatory: true },
    { sourceKind: 'LINE', sourceKey: 'B.NA', concept: 'core:NetAssets', dataType: 'MONETARY', periodType: 'INSTANT', decimals: 2, mandatory: true }]) {
    expect((await call(y.author, 'post', `/ixbrl/taxonomy-versions/${versionId}/entries`, e)).status).toBe(201);
  }
}, 300_000);
afterAll(async () => { await stopWeb(w ?? {}); });

describe('V3-M4 the taxonomy mapping and the accounts filing in the browser', () => {
  it('a reviewer reads the mapping with no verification; the owner verifies it', async () => {
    const r = await open(y.reviewer, '/taxonomy');
    await r.getByRole('link', { name: 'Synthetic screen mapping' }).click();
    await pw(r.getByTestId('version-entries').locator('tbody tr')).toHaveCount(2);
    await pw(r.getByRole('button', { name: 'Verify this version' })).toHaveCount(0);
    await r.context().close();
    const p = await open(owner, '/taxonomy');
    await pw(p.getByRole('navigation', { name: 'Practice' }).getByRole('link', { name: 'Taxonomy mapping' })).toHaveAttribute('aria-current', 'page');
    await p.getByRole('link', { name: 'Synthetic screen mapping' }).click();
    await p.getByLabel('What you checked against the taxonomy').fill('Checked against the synthetic taxonomy');
    await p.getByRole('button', { name: 'Verify this version' }).click();
    await pw(p.getByTestId('version-status')).toHaveText('VERIFIED');
    await p.context().close();
  });

  it('an accountant generates the iXBRL document; the checks pass; the filing is not offered to them', async () => {
    const p = await open(y.accountant, `/companies/${y.company.id}/filing`);
    await p.getByRole('button', { name: 'Generate the iXBRL document' }).click();
    await pw(p.getByTestId('document-status')).toHaveText('Checks passed');
    await pw(p.getByRole('link', { name: 'Open the document' })).toHaveAttribute('href', /\/ixbrl-documents\/.+\/content$/);
    await pw(p.getByRole('button', { name: 'Start the Companies House filing' })).toHaveCount(0);
    await p.context().close();
  });

  it('a partner starts and validates the filing and is refused the authority in the API\'s words', async () => {
    const p = await open(y.partner, `/companies/${y.company.id}/filing`);
    await p.getByRole('button', { name: 'Start the Companies House filing' }).click();
    await pw(p.getByTestId('ch-filing')).toHaveAttribute('data-status', 'DRAFT');
    await p.getByRole('button', { name: 'Validate' }).click();
    await pw(p.getByTestId('ch-filing')).toHaveAttribute('data-status', 'VALIDATED');
    await p.getByLabel('Authorised by').selectOption({ label: 'Synthetic Director' });
    await p.getByLabel('Authorised on').fill('2026-03-20');
    await p.getByLabel('Evidence of the authority').selectOption({ index: 1 });
    await p.getByRole('button', { name: 'Record the authority' }).click();
    await pw(p.locator('main').getByRole('alert')).toContainText('someone other than the person who validated');
    await p.context().close();
  });

  it('the owner records the authority, submits and reads the status: accepted with the reference', async () => {
    const p = await open(owner, `/companies/${y.company.id}/filing`);
    await p.getByLabel('Authorised by').selectOption({ label: 'Synthetic Director' });
    await p.getByLabel('Authorised on').fill('2026-03-20');
    await p.getByLabel('Evidence of the authority').selectOption({ index: 1 });
    await p.getByRole('button', { name: 'Record the authority' }).click();
    await pw(p.getByTestId('ch-filing')).toHaveAttribute('data-status', 'AUTHORISED');
    await p.getByRole('button', { name: 'Submit to Companies House' }).click();
    await pw(p.getByTestId('ch-filing')).toHaveAttribute('data-status', 'SUBMITTED');
    await p.getByRole('button', { name: 'Read the status' }).click();
    await pw(p.getByTestId('ch-filing')).toHaveAttribute('data-status', 'ACCEPTED');
    await pw(p.getByTestId('ch-reference')).toHaveText(/^FAKE-[0-9A-F]{16}-ACC$/);
    await pw(p.getByTestId('filing-events').locator('tbody tr')).toHaveCount(5);
    await p.context().close();
  });

  it('a reviewer reads the accepted filing with no action', async () => {
    const p = await open(y.reviewer, `/companies/${y.company.id}/filing`);
    await pw(p.getByTestId('ch-filing')).toHaveAttribute('data-status', 'ACCEPTED');
    await pw(p.locator('main').getByRole('button')).toHaveCount(0);
    await p.context().close();
  });
});
