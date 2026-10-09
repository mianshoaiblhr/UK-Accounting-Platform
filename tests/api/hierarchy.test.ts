import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, roleId, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/**
 * D1/D6: Platform -> Organisation -> Practice -> Company -> Period, with organisation / practice / company level
 * roles. Every scenario asserts the API outcome; ownership integrity is asserted in tests/db/hierarchy.test.ts.
 */
let s: Stack;
let owner: TestUser;      // practice organisation "Firm"
let other: TestUser;      // a completely separate practice organisation
let biz: TestUser;        // a direct business
let P1: string, P2: string;
let coA: { id: string }, coB: { id: string }, coC: { id: string };   // A,B in P1; C in P2

const auth = (u: TestUser) => bearer(u.token);
const api = (u: TestUser, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: object, org = owner.organisationId) =>
  s.api()[method](`/api/v1/organisations/${org}${path}`).set(auth(u)).send(body);
const company = async (u: TestUser, name: string, practiceId?: string) => {
  const r = await api(u, 'post', '/companies', { name, ...(practiceId ? { practiceId } : {}) });
  if (r.status !== 201) throw new Error(`company ${name} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; practiceId: string | null };
};
const membershipOf = async (u: TestUser) => {
  const list = (await api(owner, 'get', '/members')).body.items as { id: string; user: { id: string } }[];
  return list.find((m) => m.user.id === u.userId)!.id;
};
const grantPractice = (practiceId: string, m: string, roleKey: string, as: TestUser = owner) =>
  roleId(s, owner, roleKey).then((rid) => api(as, 'put', `/practices/${practiceId}/members/${m}`, { roleId: rid }));
const grantCompany = (companyId: string, m: string, roleKey: string, as: TestUser = owner) =>
  roleId(s, owner, roleKey).then((rid) => api(as, 'put', `/companies/${companyId}/access/${m}`, { roleId: rid }));

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE', orgName: 'Firm LLP' });
  other = await createUser(s, { type: 'PRACTICE', orgName: 'Other Firm' });
  biz = await createUser(s, { type: 'BUSINESS', orgName: 'Direct Ltd' });
  P1 = (await api(owner, 'get', '/practices')).body.items[0].id;
  const p2 = await api(owner, 'post', '/practices', { name: 'Second Office' });
  expect(p2.status).toBe(201);
  P2 = p2.body.id;
  coA = await company(owner, 'Client A', P1);
  coB = await company(owner, 'Client B', P1);
  coC = await company(owner, 'Client C', P2);
});
afterAll(() => s.stop());

describe('D1 — one hierarchy for practices and direct businesses', () => {
  it('a practice organisation gets a default practice at registration; companies must name their managing practice', async () => {
    const fresh = await createUser(s, { type: 'PRACTICE' });
    const list = await api(fresh, 'get', '/practices', undefined, fresh.organisationId);
    expect(list.body.items).toHaveLength(1);
    // exactly one practice: it is used by default
    const c = await api(fresh, 'post', '/companies', { name: 'Defaulted Ltd' }, fresh.organisationId);
    expect(c.status).toBe(201);
    expect(c.body.practiceId).toBe(list.body.items[0].id);
    // two practices: the caller must choose
    await api(fresh, 'post', '/practices', { name: 'Branch' }, fresh.organisationId);
    const amb = await api(fresh, 'post', '/companies', { name: 'Which Ltd' }, fresh.organisationId);
    expect(amb.status).toBe(422);
    expect(amb.body.code).toBe('practice_required');
  });
  it('a direct business has no practice and "does not pretend" to be one — same company/period API', async () => {
    expect((await api(biz, 'get', '/practices', undefined, biz.organisationId)).body.items).toEqual([]);
    const denied = await api(biz, 'post', '/practices', { name: 'Fake Practice' }, biz.organisationId);
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe('practice_not_allowed');
    const c = await api(biz, 'post', '/companies', { name: 'Solo Trading Ltd' }, biz.organisationId);
    expect(c.status).toBe(201);
    expect(c.body.practiceId).toBeNull();
    const withPractice = await api(biz, 'post', '/companies', { name: 'X', practiceId: P1 }, biz.organisationId);
    expect(withPractice.status).toBe(422);
    const period = await api(biz, 'post', `/companies/${c.body.id}/periods`, { startDate: '2025-04-01', endDate: '2026-03-31' }, biz.organisationId);
    expect(period.status).toBe(201);
    expect((await api(biz, 'get', '/me', undefined, biz.organisationId)).body).toMatchObject({ organisationType: 'BUSINESS', practiceIds: [] });
  });
  it('a company cannot be placed in another organisation\'s practice', async () => {
    const foreign = (await api(other, 'get', '/practices', undefined, other.organisationId)).body.items[0].id;
    const r = await api(owner, 'post', '/companies', { name: 'Smuggled Ltd', practiceId: foreign });
    expect(r.status).toBe(404);
  });
  it('the company reports its managing practice (canonical ownership: organisation owns, practice manages)', async () => {
    const r = await api(owner, 'get', `/companies/${coC.id}`);
    expect(r.body).toMatchObject({ id: coC.id, organisationId: owner.organisationId, practiceId: P2 });
  });
});

describe('D6 — practice to client access: an explicit relationship is required', () => {
  let staff: TestUser, staffM: string;
  beforeAll(async () => {
    staff = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [] });
    staffM = await membershipOf(staff);
  });
  it('organisation membership alone gives no access to practices or companies (deny by default)', async () => {
    expect((await api(staff, 'get', '/companies')).body.items).toEqual([]);
    for (const c of [coA, coB, coC]) expect((await api(staff, 'get', `/companies/${c.id}`)).status).toBe(404);
    expect((await api(staff, 'get', '/practices')).body.items).toEqual([]);
    expect((await api(staff, 'get', `/practices/${P1}`)).status).toBe(404);
  });
  it('a practice grant opens exactly that practice\'s companies; the other practice stays invisible', async () => {
    expect((await grantPractice(P1, staffM, 'accountant')).status).toBe(200);
    expect((await api(staff, 'get', '/companies')).body.items.map((c: { id: string }) => c.id).sort()).toEqual([coA.id, coB.id].sort());
    expect((await api(staff, 'get', `/companies/${coA.id}`)).status).toBe(200);
    expect((await api(staff, 'get', `/companies/${coC.id}`)).status).toBe(404);
    expect((await api(staff, 'get', `/practices/${P2}`)).status).toBe(404);
    expect((await api(staff, 'post', `/companies/${coC.id}/periods`, { startDate: '2025-04-01', endDate: '2026-03-31' })).status).toBe(404);
    expect((await api(staff, 'post', `/companies/${coA.id}/periods`, { startDate: '2025-04-01', endDate: '2026-03-31' })).status).toBe(201);
  });
  it('a practice-level user can create client companies only inside their own practice', async () => {
    expect((await api(staff, 'post', '/companies', { name: 'Staff Client', practiceId: P1 })).status).toBe(201);
    const wrong = await api(staff, 'post', '/companies', { name: 'Wrong Practice', practiceId: P2 });
    expect([403, 404]).toContain(wrong.status);
    expect((await api(staff, 'get', '/companies')).body.items.map((c: { name: string }) => c.name)).toContain('Staff Client'); // sees what they created
  });
  it('revoking the practice grant removes access immediately', async () => {
    expect((await api(owner, 'delete', `/practices/${P1}/members/${staffM}`)).status).toBe(204);
    expect((await api(staff, 'get', `/companies/${coA.id}`)).status).toBe(404);
    expect((await api(staff, 'get', '/companies')).body.items).toEqual([]);
  });
});

describe('D6 — a user belonging to several companies with different roles', () => {
  let multi: TestUser, multiM: string;
  beforeAll(async () => {
    multi = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    multiM = await membershipOf(multi);
    expect((await grantCompany(coA.id, multiM, 'partner')).status).toBe(200);
    expect((await grantCompany(coB.id, multiM, 'reviewer')).status).toBe(200);
  });
  it('lists exactly the companies they hold a grant on', async () => {
    expect((await api(multi, 'get', '/companies')).body.items.map((c: { id: string }) => c.id).sort()).toEqual([coA.id, coB.id].sort());
    expect((await api(multi, 'get', `/companies/${coC.id}`)).status).toBe(404);
    const me = (await api(multi, 'get', '/me')).body;
    expect(me.companyIds.sort()).toEqual([coA.id, coB.id].sort());
    expect(me.companyScope).toBe('ASSIGNED');
  });
  it('the same user is a partner on A and a reviewer on B', async () => {
    // A: partner => may manage tasks and rename; B: reviewer => read/review only
    expect((await api(multi, 'post', '/tasks', { title: 'on A', companyId: coA.id })).status).toBe(201);
    const denied = await api(multi, 'post', '/tasks', { title: 'on B', companyId: coB.id });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('permission_denied');
    expect((await api(multi, 'patch', `/companies/${coA.id}`, { name: 'Client A (renamed)' })).status).toBe(200);
    expect((await api(multi, 'patch', `/companies/${coB.id}`, { name: 'nope' })).status).toBe(403);
    expect((await api(multi, 'get', `/companies/${coB.id}`)).status).toBe(200);
    expect((await api(multi, 'post', '/tasks', { title: 'on C', companyId: coC.id })).status).toBe(404);
  });
  it('company-level permissions are enforced on workflows too (approve on A, not on B)', async () => {
    const wa = (await api(owner, 'post', '/workflows', { type: 'standard_workflow', subjectType: 'x', subjectId: 'a', companyId: coA.id })).body.id;
    const wb = (await api(owner, 'post', '/workflows', { type: 'standard_workflow', subjectType: 'x', subjectId: 'b', companyId: coB.id })).body.id;
    for (const w of [wa, wb]) {
      expect((await api(owner, 'post', `/workflows/${w}/transitions`, { action: 'begin' })).status).toBe(201);
      expect((await api(owner, 'post', `/workflows/${w}/transitions`, { action: 'submit_for_review' })).status).toBe(201);
    }
    expect((await api(multi, 'get', `/workflows/${wa}`)).body.availableActions.sort()).toEqual(['pass_review', 'reject', 'request_changes']);
    expect((await api(multi, 'post', `/workflows/${wa}/transitions`, { action: 'pass_review' })).body.state).toBe('APPROVAL');
    // multi reviewed A so segregation of duties stops them approving the same attempt
    expect((await api(multi, 'post', `/workflows/${wa}/transitions`, { action: 'approve' })).body.code).toBe('separation_of_duties');
    // on B the reviewer role can review but never approve
    expect((await api(multi, 'post', `/workflows/${wb}/transitions`, { action: 'pass_review' })).body.state).toBe('APPROVAL');
    const approveB = await api(multi, 'post', `/workflows/${wb}/transitions`, { action: 'approve' });
    expect(approveB.status).toBe(403);
    expect(approveB.body.code).toBe('permission_denied');
  });
  it('changing or removing a company grant takes effect immediately', async () => {
    expect((await grantCompany(coB.id, multiM, 'accountant')).status).toBe(200);
    expect((await api(multi, 'post', '/tasks', { title: 'now allowed on B', companyId: coB.id })).status).toBe(201);
    expect((await api(owner, 'delete', `/companies/${coB.id}/access/${multiM}`)).status).toBe(204);
    expect((await api(multi, 'get', `/companies/${coB.id}`)).status).toBe(404);
    expect((await api(multi, 'get', `/companies/${coA.id}`)).status).toBe(200); // other grants unaffected
  });
  it('the access list of a company shows who holds what', async () => {
    const r = await api(owner, 'get', `/companies/${coA.id}/access`);
    expect(r.body.items.find((g: { membershipId: string }) => g.membershipId === multiM).role.key).toBe('partner');
  });
});

describe('D6 — a company grant can also restrict', () => {
  it('an organisation-wide accountant is limited to read-only on one sensitive company', async () => {
    const acc = await addMember(s, owner, 'accountant'); // reach ALL
    const m = await membershipOf(acc);
    expect((await api(acc, 'post', '/tasks', { title: 't', companyId: coC.id })).status).toBe(201);
    expect((await grantCompany(coC.id, m, 'reviewer')).status).toBe(200);
    expect((await api(acc, 'post', '/tasks', { title: 't2', companyId: coC.id })).status).toBe(403);
    expect((await api(acc, 'post', '/tasks', { title: 't3', companyId: coA.id })).status).toBe(201); // other companies unchanged
  });
});

describe('D6 — unauthorised document access', () => {
  let viewer: TestUser, viewerM: string;
  let docB: { documentId: string; versionId: string }, docC: { documentId: string; versionId: string };
  beforeAll(async () => {
    docB = await uploadDoc(s, owner, { companyId: coB.id, name: 'b.pdf' });
    docC = await uploadDoc(s, owner, { companyId: coC.id, name: 'c.pdf' });
    await waitForVersion(s, owner, docB.documentId, docB.versionId);
    await waitForVersion(s, owner, docC.documentId, docC.versionId);
    viewer = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    viewerM = await membershipOf(viewer);
    await grantCompany(coB.id, viewerM, 'client_viewer');
  });
  it('a company without a grant: document is invisible at every endpoint', async () => {
    const d = `/documents/${docC.documentId}`;
    expect((await api(viewer, 'get', d)).status).toBe(404);
    expect((await api(viewer, 'get', `${d}/versions/${docC.versionId}/download`)).status).toBe(404);
    expect((await api(viewer, 'get', `${d}/versions/${docC.versionId}/content`)).status).toBe(404);
    // Writes the viewer role never holds are refused before the document is even looked up, so a document that exists
    // in a company they cannot see answers exactly like one that does not exist (no existence oracle).
    const ghost = '11111111-1111-4111-8111-111111111111';
    for (const [path, body] of [[`/versions`, { contentType: 'application/pdf', sizeBytes: 10 }], [`/archive`, undefined]] as const) {
      const real = await api(viewer, 'post', `${d}${path}`, body);
      const none = await api(viewer, 'post', `/documents/${ghost}${path}`, body);
      expect(real.status, path).toBe(none.status);
      expect([403, 404]).toContain(real.status);
    }
    expect((await api(viewer, 'get', '/documents')).body.items.map((x: { id: string }) => x.id)).toEqual([docB.documentId]);
  });
  it('a company with a read-only grant: may read and download, may not upload or archive', async () => {
    const d = `/documents/${docB.documentId}`;
    expect((await api(viewer, 'get', d)).status).toBe(200);
    expect((await api(viewer, 'get', `${d}/versions/${docB.versionId}/download`)).status).toBe(200);
    expect((await api(viewer, 'post', `${d}/versions`, { contentType: 'application/pdf', sizeBytes: 10 })).status).toBe(403);
    expect((await api(viewer, 'post', `${d}/archive`)).status).toBe(403);
    expect((await api(viewer, 'post', '/documents', { name: 'x.pdf', companyId: coB.id, contentType: 'application/pdf', sizeBytes: 5 })).status).toBe(403);
  });
  it('denials are audited', async () => {
    const n = adminSql(`SELECT count(*) FROM audit_event WHERE organisation_id='${owner.organisationId}' AND action='access.denied' AND actor_user_id='${viewer.userId}'`);
    expect(Number(n)).toBeGreaterThan(0);
  });
});

describe('D6 — revoked memberships', () => {
  it('removing the member removes every grant and all access; suspension is reversible', async () => {
    const m = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [coA.id] });
    const mid = await membershipOf(m);
    await grantPractice(P2, mid, 'reviewer');
    expect((await api(m, 'get', `/companies/${coA.id}`)).status).toBe(200);
    expect((await api(m, 'get', `/companies/${coC.id}`)).status).toBe(200);
    expect((await api(owner, 'patch', `/members/${mid}`, { status: 'SUSPENDED' })).status).toBe(200);
    expect((await api(m, 'get', `/companies/${coA.id}`)).status).toBe(404);
    expect((await api(owner, 'patch', `/members/${mid}`, { status: 'ACTIVE' })).status).toBe(200);
    expect((await api(m, 'get', `/companies/${coA.id}`)).status).toBe(200);
    expect((await api(owner, 'delete', `/members/${mid}`)).status).toBe(204);
    expect((await api(m, 'get', `/companies/${coA.id}`)).status).toBe(404);
    expect((await api(m, 'get', `/companies/${coC.id}`)).status).toBe(404);
    expect(adminSql(`SELECT (SELECT count(*) FROM company_membership WHERE membership_id='${mid}') + (SELECT count(*) FROM practice_membership WHERE membership_id='${mid}')`)).toBe('0');
  });
});

describe('D6 — anti-escalation at every level', () => {
  it('a manager at company level cannot grant a role with permissions they lack', async () => {
    // custom role: may manage access to the company, but cannot approve workflows
    const mk = await api(owner, 'post', '/roles', { key: 'access_admin', name: 'Access admin', permissions: ['org:read', 'company:read', 'company:access:manage', 'workflow:manage'] });
    expect(mk.status).toBe(201);
    const u = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    const target = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    await api(owner, 'put', `/companies/${coA.id}/access/${await membershipOf(u)}`, { roleId: mk.body.id });
    const tm = await membershipOf(target);
    const partnerRole = await roleId(s, owner, 'partner');
    const esc = await api(u, 'put', `/companies/${coA.id}/access/${tm}`, { roleId: partnerRole });
    expect(esc.status).toBe(403);
    expect(esc.body.code).toBe('privilege_escalation');
    // ...but may grant a role that is within their own rights
    const ok = await api(u, 'put', `/companies/${coA.id}/access/${tm}`, { roleId: mk.body.id });
    expect(ok.status).toBe(200);
    // and has no say over other companies
    expect((await api(u, 'put', `/companies/${coB.id}/access/${tm}`, { roleId: mk.body.id })).status).toBe(404);
  });
  it('a practice partner manages access inside their practice only', async () => {
    const pp = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    const ppM = await membershipOf(pp);
    await grantPractice(P1, ppM, 'partner');
    const colleague = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    const cm = await membershipOf(colleague);
    expect((await grantCompany(coA.id, cm, 'accountant', pp)).status).toBe(200);
    expect((await grantPractice(P1, cm, 'reviewer', pp)).status).toBe(200);
    expect((await grantPractice(P2, cm, 'reviewer', pp)).status).toBe(404); // not their practice
    expect((await grantCompany(coC.id, cm, 'reviewer', pp)).status).toBe(404);
    // may not grant organisation-wide authority: member management stays organisation level
    expect((await api(pp, 'patch', `/members/${cm}`, { roleId: await roleId(s, owner, 'admin') })).status).toBe(403);
  });
  it('organisation roles still cannot be escalated (existing rule preserved)', async () => {
    const admin = await addMember(s, owner, 'admin');
    const r = await api(admin, 'post', '/invitations', { email: 'x@example.test', roleId: await roleId(s, owner, 'owner') });
    expect(r.body.code).toBe('privilege_escalation');
  });
});

describe('D6 — cross-organisation isolation of the new levels', () => {
  it('another organisation cannot see or touch practices, grants or company access', async () => {
    for (const path of ['/practices', `/practices/${P1}`, `/practices/${P1}/members`, `/companies/${coA.id}/access`]) {
      expect((await api(other, 'get', path)).status, path).toBe(404);
    }
    const aMember = await membershipOf(await addMember(s, owner, 'client_viewer'));
    const rid = await roleId(s, owner, 'accountant');
    expect((await api(other, 'put', `/practices/${P1}/members/${aMember}`, { roleId: rid })).status).toBe(404);
    expect((await api(other, 'put', `/companies/${coA.id}/access/${aMember}`, { roleId: rid })).status).toBe(404);
  });
  it('grants cannot reference another organisation\'s member, role or company', async () => {
    const otherUserM = (await api(other, 'get', '/members', undefined, other.organisationId)).body.items[0].id;
    const rid = await roleId(s, owner, 'accountant');
    expect((await api(owner, 'put', `/practices/${P1}/members/${otherUserM}`, { roleId: rid })).status).toBe(404);
    expect((await api(owner, 'put', `/companies/${coA.id}/access/${otherUserM}`, { roleId: rid })).status).toBe(404);
    const foreignRole = await api(other, 'post', '/roles', { key: 'foreign_role', name: 'F', permissions: ['org:read'] }, other.organisationId);
    const mine = await membershipOf(await addMember(s, owner, 'client_viewer'));
    expect((await api(owner, 'put', `/companies/${coA.id}/access/${mine}`, { roleId: foreignRole.body.id })).status).toBe(422);
  });
  it('a platform role does not open any organisation', async () => {
    adminSql(`UPDATE "user" SET platform_role='ADMIN' WHERE id='${other.userId}'`);
    expect((await api(other, 'get', '/companies')).status).toBe(404);
    expect((await api(other, 'get', `/companies/${coA.id}`)).status).toBe(404);
    // ...and does not enlarge the rights of a member either
    const v = await addMember(s, owner, 'client_viewer');
    adminSql(`UPDATE "user" SET platform_role='ADMIN' WHERE id='${v.userId}'`);
    expect((await api(v, 'post', '/companies', { name: 'nope', practiceId: P1 })).status).toBe(403);
  });
});

describe('D5/D6 — organisation role changes and implicit company grants', () => {
  it('assigned companies follow the organisation role; explicitly different roles are left alone', async () => {
    const m = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [coA.id, coB.id] });
    const mid = await membershipOf(m);
    expect((await grantCompany(coB.id, mid, 'manager')).status).toBe(200); // explicit, different
    expect((await api(owner, 'patch', `/members/${mid}`, { roleId: await roleId(s, owner, 'reviewer') })).status).toBe(200);
    const roles = Object.fromEntries(adminSql(`SELECT cm.company_id||'='||r.key FROM company_membership cm JOIN role r ON r.id=cm.role_id WHERE cm.membership_id='${mid}'`).split('\n').map((l) => l.split('=')));
    expect(roles[coA.id]).toBe('reviewer'); // followed the organisation role (downgrade took effect)
    expect(roles[coB.id]).toBe('manager');  // explicit grant untouched
    expect((await api(m, 'post', '/tasks', { title: 'x', companyId: coA.id })).status).toBe(403);
  });
  it('changing the assigned set needs company:access:manage on each affected company', async () => {
    const m = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    const mid = await membershipOf(m);
    const lim = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
    await grantCompany(coA.id, await membershipOf(lim), 'partner');
    const hr = await addMember(s, owner, 'admin'); // org admin can manage everything
    expect((await api(hr, 'patch', `/members/${mid}`, { companyIds: [coA.id, coC.id] })).status).toBe(200);
    expect((await api(m, 'get', `/companies/${coC.id}`)).status).toBe(200);
    expect(adminSql(`SELECT count(*) FROM company_membership WHERE membership_id='${mid}'`)).toBe('2');
  });
});
