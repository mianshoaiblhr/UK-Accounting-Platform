import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/**
 * V7-M2 through the public API (DEC-089): the open work by status and kind, the client list (visibility, search, filters, pages, the next
 * deadline) and the client manager on the compliance profile. Synthetic data; the deadlines are entered by hand, relative to the UK date.
 */
let s: Stack;
let owner: TestUser, manager: TestUser, bookkeeper: TestUser, assigned: TestUser, viewer: TestUser, outsider: TestUser;
const co: Record<string, { id: string }> = {};
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const deadline = (company: string, title: string, days: number) =>
  as(owner, 'post', `/companies/${co[company]!.id}/compliance/obligations`, { kind: 'OTHER', title, dueDate: shift(ukToday(), days), reason: 'Internal deadline for the test' });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  for (const n of ['Alder Ltd', 'Birch Ltd', 'Cedar Trading', 'Damson Ltd']) co[n] = await makeCompany(s, owner, n);
  await as(owner, 'patch', `/companies/${co['Cedar Trading']!.id}`, { legalForm: 'SOLE_TRADER' });
  manager = await addMember(s, owner, 'manager');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  viewer = await addMember(s, owner, 'client_viewer');
  assigned = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [co['Alder Ltd']!.id, co['Birch Ltd']!.id] });
  outsider = await createUser(s, { type: 'PRACTICE' });
  await deadline('Alder Ltd', 'Alder overdue', -3);
  await deadline('Alder Ltd', 'Alder later', 20);
  const w = (await deadline('Birch Ltd', 'Birch soon', 4)).body;
  await as(owner, 'patch', `/companies/${co['Birch Ltd']!.id}/compliance/obligations/${w.id}`, { version: 1, status: 'WAITING_ON_CLIENT' });
  const d = (await deadline('Damson Ltd', 'Damson done', -10)).body;
  await as(owner, 'patch', `/companies/${co['Damson Ltd']!.id}/compliance/obligations/${d.id}`, { version: 1, status: 'DONE', doneOn: ukToday() });
});
afterAll(() => s.stop());

describe('the client manager on the compliance profile', () => {
  it('is set with compliance:manage and a reason, must be an active member, and keeps the confirmation date', async () => {
    const p = `/companies/${co['Alder Ltd']!.id}/compliance/profile`;
    expect((await as(owner, 'put', p, { confirmationDate: '2025-05-20', reason: 'From the last confirmation statement' })).status).toBe(200);
    expect((await as(bookkeeper, 'put', p, { clientManagerUserId: manager.userId, reason: 'Manager for this client' })).status).toBe(403);
    expect((await as(owner, 'put', p, { clientManagerUserId: outsider.userId, reason: 'Manager for this client' })).body.code).toBe('invalid_assignee');
    const r = await as(owner, 'put', p, { clientManagerUserId: manager.userId, reason: 'Manager for this client' });
    expect(r.body).toMatchObject({ clientManagerUserId: manager.userId, confirmationDate: '2025-05-20' });
    expect((await as(owner, 'put', p, { reason: 'Nothing to change at all' })).status).toBe(422);
  });
});

describe('open work by status and kind', () => {
  it('counts open obligations of the readable clients only', async () => {
    const all = (await as(owner, 'get', '/compliance/work')).body;
    expect(all).toMatchObject({ byStatus: { NOT_STARTED: 2, WAITING_ON_CLIENT: 1 }, byKind: { OTHER: 3 }, total: 3 });
    expect(all.byStatus.DONE).toBeUndefined();
    const mine = (await as(assigned, 'get', '/compliance/work')).body;
    expect(mine.total).toBe(3);
    expect((await as(viewer, 'get', '/compliance/work')).status).toBe(403);
    expect((await s.api().get(orgPath(owner, '/compliance/work')).set(bearer(outsider.token))).status).toBe(404);
  });
});

describe('the client list', () => {
  it('lists the readable clients by name with year end, VAT, next deadline, counts and manager', async () => {
    const r = await as(owner, 'get', '/compliance/clients');
    expect(r.status).toBe(200);
    expect(r.body.items.map((c: { name: string }) => c.name)).toEqual(['Alder Ltd', 'Birch Ltd', 'Cedar Trading', 'Damson Ltd']);
    const alder = r.body.items[0];
    expect(alder).toMatchObject({ legalForm: 'LTD', vat: { registered: false }, openCount: 2, overdueCount: 1, clientManager: { userId: manager.userId } });
    expect(alder.nextDeadline).toMatchObject({ title: 'Alder overdue', overdue: true });
    expect(alder.clientManager.displayName).toBeTruthy();
    const damson = r.body.items[3];
    expect(damson).toMatchObject({ openCount: 0, overdueCount: 0, nextDeadline: null, clientManager: null });
  });
  it('an assigned accountant sees only their clients; search, legal form and manager filters narrow it', async () => {
    expect((await as(assigned, 'get', '/compliance/clients')).body.items.map((c: { name: string }) => c.name)).toEqual(['Alder Ltd', 'Birch Ltd']);
    expect((await as(owner, 'get', '/compliance/clients?q=bir')).body.items.map((c: { name: string }) => c.name)).toEqual(['Birch Ltd']);
    expect((await as(owner, 'get', '/compliance/clients?legalForm=SOLE_TRADER')).body.items.map((c: { name: string }) => c.name)).toEqual(['Cedar Trading']);
    expect((await as(manager, 'get', '/compliance/clients?manager=me')).body.items.map((c: { name: string }) => c.name)).toEqual(['Alder Ltd']);
    expect((await as(viewer, 'get', '/compliance/clients')).status).toBe(403);
  });
  it('pages by name with a cursor', async () => {
    const p1 = await as(owner, 'get', '/compliance/clients?limit=3');
    expect(p1.body.items).toHaveLength(3);
    const p2 = await as(owner, 'get', `/compliance/clients?limit=3&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items.map((c: { name: string }) => c.name)).toEqual(['Damson Ltd']);
    expect(p2.body.nextCursor).toBeNull();
    expect((await as(owner, 'get', '/compliance/clients?cursor=nonsense')).body.code).toBe('invalid_cursor');
  });
});
