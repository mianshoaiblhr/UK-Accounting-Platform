import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

let s: Stack;
let a: TestUser, b: TestUser;           // owners of two unrelated organisations
let coA: { id: string }, coB: { id: string };
let docA: { documentId: string; versionId: string };

beforeAll(async () => {
  s = await startStack();
  a = await createUser(s, { type: 'PRACTICE', orgName: 'Practice A' });
  b = await createUser(s, { type: 'BUSINESS', orgName: 'Business B' });
  coA = await makeCompany(s, a, 'A Client Ltd', 'AAAA0001');
  coB = await makeCompany(s, b, 'B Trading Ltd', 'BBBB0001');
  docA = await uploadDoc(s, a, { companyId: coA.id });
  await waitForVersion(s, a, docA.documentId, docA.versionId);
});
afterAll(() => s.stop());

const get = (u: TestUser, path: string, orgOverride?: string) =>
  s.api().get(`/api/v1/organisations/${orgOverride ?? u.organisationId}${path}`).set(bearer(u.token));

describe('tenant isolation: user B probing organisation A', () => {
  const paths = ['', '/me', '/members', '/roles', '/invitations', '/companies', '/documents', '/jobs', '/audit-events'];
  it.each(paths)('GET /organisations/{A}%s => 404 (existence not revealed)', async (p) => {
    const r = await get(b, p, a.organisationId);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });
  it('write endpoints on organisation A are closed to B', async () => {
    const o = (p: string) => `/api/v1/organisations/${a.organisationId}${p}`;
    expect((await s.api().post(o('/companies')).set(bearer(b.token)).send({ name: 'x' })).status).toBe(404);
    expect((await s.api().post(o('/documents')).set(bearer(b.token)).send({ name: 'x', contentType: 'application/pdf', sizeBytes: 5 })).status).toBe(404);
    expect((await s.api().post(o('/invitations')).set(bearer(b.token)).send({ email: 'z@z.zz', roleId: '00000000-0000-4000-8000-0000000000a1' })).status).toBe(404);
    expect((await s.api().post(o('/jobs/echo')).set(bearer(b.token)).send({ message: 'x' })).status).toBe(404);
  });
  it('knowing a resource id from another tenant does not help (company, document, version, job)', async () => {
    expect((await get(b, `/companies/${coA.id}`)).status).toBe(404);
    expect((await get(b, `/companies/${coA.id}/periods`)).status).toBe(404);
    expect((await get(b, `/documents/${docA.documentId}`)).status).toBe(404);
    expect((await get(b, `/documents/${docA.documentId}/versions/${docA.versionId}/download`)).status).toBe(404);
    expect((await get(b, `/documents/${docA.documentId}/versions/${docA.versionId}/content`)).status).toBe(404);
    expect((await s.api().patch(orgPath(b, `/companies/${coA.id}`)).set(bearer(b.token)).send({ name: 'pwn' })).status).toBe(404);
    expect(adminSql(`SELECT name FROM company WHERE id='${coA.id}'`)).toBe('A Client Ltd');
  });
  it('cannot attach a document to, or create a period for, a foreign company', async () => {
    const d = await s.api().post(orgPath(b, '/documents')).set(bearer(b.token)).send({ name: 'x.pdf', companyId: coA.id, contentType: 'application/pdf', sizeBytes: 5 });
    expect(d.status).toBe(404);
    const p = await s.api().post(orgPath(b, `/companies/${coA.id}/periods`)).set(bearer(b.token)).send({ startDate: '2025-04-01', endDate: '2026-03-31' });
    expect(p.status).toBe(404);
  });
  it('list endpoints return only the callers tenant data', async () => {
    const la = await get(a, '/companies');
    const lb = await get(b, '/companies');
    expect(la.body.items.map((c: { id: string }) => c.id)).toEqual([coA.id]);
    expect(lb.body.items.map((c: { id: string }) => c.id)).toEqual([coB.id]);
    expect((await get(b, '/documents')).body.items).toHaveLength(0);
    expect((await get(a, '/documents')).body.items).toHaveLength(1);
  });
  it('audit log and job list never cross tenants', async () => {
    const auditB = await get(b, '/audit-events');
    expect(auditB.body.items.every((e: { organisationId: string }) => e.organisationId === b.organisationId)).toBe(true);
    expect(JSON.stringify(auditB.body)).not.toContain(coA.id);
    const jobsB = await get(b, '/jobs');
    expect(jobsB.body.items.every((j: { id: string }) => j.id !== undefined)).toBe(true);
    expect(adminSql(`SELECT count(*) FROM job_record WHERE organisation_id='${b.organisationId}' AND type='document.process'`)).toBe('0');
  });
  it('malformed or unknown organisation ids behave like non-membership', async () => {
    expect((await get(b, '', 'not-a-uuid')).status).toBe(404);
    expect((await get(b, '', '11111111-1111-4111-8111-111111111111')).status).toBe(404);
  });
  it('denied probes are audited inside the targeted organisation', async () => {
    await get(b, '/companies', a.organisationId);
    const audit = await get(a, '/audit-events?action=access.denied');
    expect(audit.body.items.some((e: { outcome: string; actorUserId: string }) => e.outcome === 'DENIED' && e.actorUserId === b.userId)).toBe(true);
  });
  it('unauthenticated callers get 401 before any tenant logic', async () => {
    expect((await s.api().get(orgPath(a, '/companies'))).status).toBe(401);
  });
});

describe('a user in two organisations (practice staff + own business)', () => {
  it('has separate roles and data per organisation', async () => {
    const staff = await addMember(s, a, 'accountant'); // staff.organisationId = A, but staff also owns its own org
    const own = await s.api().get('/api/v1/auth/me').set(bearer(staff.token));
    expect(own.body.organisations).toHaveLength(2);
    const ownOrgId = own.body.organisations.find((o: { id: string }) => o.id !== a.organisationId).id;
    const asOwner = await s.api().post(`/api/v1/organisations/${ownOrgId}/companies`).set(bearer(staff.token)).send({ name: 'Own Co' });
    expect(asOwner.status).toBe(201);
    const inA = await s.api().get(orgPath(a, '/companies')).set(bearer(staff.token));
    expect(inA.body.items.map((c: { name: string }) => c.name)).not.toContain('Own Co');
    const me = await s.api().get(orgPath(staff, '/me')).set(bearer(staff.token));
    expect(me.body.role).toBe('accountant');
  });
});

describe('practice-first: assigned-company scope', () => {
  it('an assigned-scope accountant sees only assigned clients and their documents', async () => {
    const c2 = await makeCompany(s, a, 'Second Client Ltd');
    const staff = await addMember(s, a, 'accountant', { scope: 'ASSIGNED', companyIds: [coA.id] });
    const list = await s.api().get(orgPath(a, '/companies')).set(bearer(staff.token));
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([coA.id]);
    expect((await s.api().get(orgPath(a, `/companies/${c2.id}`)).set(bearer(staff.token))).status).toBe(404);
    expect((await s.api().get(orgPath(a, `/companies/${coA.id}`)).set(bearer(staff.token))).status).toBe(200);
    const docs = await s.api().get(orgPath(a, '/documents')).set(bearer(staff.token));
    expect(docs.body.items).toHaveLength(1);
    const d2 = await uploadDoc(s, a, { companyId: c2.id, name: 'secret.pdf' });
    expect((await s.api().get(orgPath(a, `/documents/${d2.documentId}`)).set(bearer(staff.token))).status).toBe(404);
    expect((await s.api().post(orgPath(a, '/documents')).set(bearer(staff.token)).send({ name: 'x', companyId: c2.id, contentType: 'application/pdf', sizeBytes: 5 })).status).toBe(404);
    expect((await s.api().post(orgPath(a, `/companies/${c2.id}/periods`)).set(bearer(staff.token)).send({ startDate: '2025-04-01', endDate: '2026-03-31' })).status).toBe(404);
  });
  it('an assigned-scope member has no implicit reach: creating a company needs an explicit practice grant (deny by default)', async () => {
    const staff = await addMember(s, a, 'accountant', { scope: 'ASSIGNED', companyIds: [] });
    const r = await s.api().post(orgPath(a, '/companies')).set(bearer(staff.token)).send({ name: 'Staff Created Ltd' });
    expect(r.status).toBe(403);
  });
  it('a direct business is just a one-company organisation using the same API', async () => {
    const list = await get(b, '/companies');
    expect(list.body.items).toHaveLength(1);
    const me = await get(b, '/me');
    expect(me.body.role).toBe('owner');
  });
});
