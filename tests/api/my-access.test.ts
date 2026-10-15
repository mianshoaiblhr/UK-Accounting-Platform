import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** M9 (DEC-049): GET .../companies/{id}/my-access tells a screen what the caller may do there and which features are on. The guards still enforce. */
let s: Stack;
let owner: TestUser, bookkeeper: TestUser, viewer: TestUser, assigned: TestUser, outsider: TestUser;
let company: { id: string }, other: { id: string };
const as = (u: TestUser, m: 'get' | 'post' | 'put', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const access = (u: TestUser, c: string) => as(u, 'get', `/companies/${c}/my-access`);

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Access Client');
  other = await makeCompany(s, owner, 'Other Client');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  viewer = await addMember(s, owner, 'client_viewer');
  assigned = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [company.id] });
  outsider = await createUser(s, { type: 'PRACTICE' });
});
afterAll(() => s.stop());

describe('my-access (M9, DEC-049)', () => {
  it('returns the effective permissions per role, sorted, with every feature flag resolved', async () => {
    const o = await access(owner, company.id);
    expect(o.status).toBe(200);
    expect(o.body.companyId).toBe(company.id);
    expect(o.body.permissions).toEqual([...o.body.permissions].sort());
    expect(o.body.permissions).toEqual(expect.arrayContaining(['ledger:read', 'journal:post', 'period:lock', 'sales:approve', 'bank:reconcile']));
    expect(o.body.features).toMatchObject({ 'bookkeeping.core': true, 'ai.beta': true, 'documents.ocr': false });
    const b = (await access(bookkeeper, company.id)).body.permissions as string[];
    expect(b).toEqual(expect.arrayContaining(['sales:manage', 'ledger:read']));
    expect(b).not.toContain('sales:approve');
    expect(b).not.toContain('period:lock');
    const v = (await access(viewer, company.id)).body.permissions as string[];
    expect(v).not.toContain('ledger:read');
    expect(v).not.toContain('journal:post');
  });

  it('matches what the guards decide: a permission the response lacks is refused by the route itself', async () => {
    const b = (await access(bookkeeper, company.id)).body.permissions as string[];
    expect(b).not.toContain('period:lock');
    expect((await as(bookkeeper, 'post', `/companies/${company.id}/periods/11111111-1111-4111-8111-111111111111/lock`, { reason: 'Trying without the permission' })).status).toBe(403);
    expect(b).toContain('sales:read');
    expect((await as(bookkeeper, 'get', `/companies/${company.id}/sales/documents`)).status).toBe(200);
  });

  it('a company outside the caller\'s reach is 404, as is another organisation; a malformed id is refused', async () => {
    expect((await access(assigned, company.id)).status).toBe(200);
    expect((await access(assigned, other.id)).status).toBe(404);
    expect((await s.api().get(orgPath(owner, `/companies/${company.id}/my-access`)).set(bearer(outsider.token))).status).toBe(404);
    expect((await access(owner, 'not-a-uuid')).status).toBe(400);
  });

  it('follows the organisation override of a flag', async () => {
    expect((await as(owner, 'put', '/feature-flags/bookkeeping.core', { enabled: false, reason: 'Screens off for this test' })).status).toBe(200);
    expect((await access(bookkeeper, company.id)).body.features['bookkeeping.core']).toBe(false);
    expect((await as(owner, 'put', '/feature-flags/bookkeeping.core', { enabled: true, reason: 'Screens back on' })).status).toBe(200);
    expect((await access(bookkeeper, company.id)).body.features['bookkeeping.core']).toBe(true);
  });
});
