import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLES } from '@uk/contracts';
import { ORIGIN, addMember, bearer, createUser, makeCompany, orgPath, roleId, startStack, type Stack, type TestUser } from '../helpers/stack';

let s: Stack;
let owner: TestUser;
const members: Record<string, TestUser> = {};
let company: { id: string };

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner);
  for (const key of ['admin', 'partner', 'manager', 'accountant', 'bookkeeper', 'reviewer', 'client_viewer']) members[key] = await addMember(s, owner, key);
  members.owner = owner;
});
afterAll(() => s.stop());

type Call = { name: string; perm: string; run: (u: TestUser) => Promise<number> };
const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object) => async (u: TestUser) => {
  const r = await s.api()[method](orgPath(owner, path)).set(bearer(u.token)).send(body);
  return r.status;
};

// One probe per permission-guarded capability. Expected: allowed iff role holds the permission.
const probes: Call[] = [
  { name: 'read org', perm: 'org:read', run: call('get', '') },
  { name: 'list members', perm: 'member:read', run: call('get', '/members') },
  { name: 'list roles', perm: 'role:read', run: call('get', '/roles') },
  { name: 'create role', perm: 'role:manage', run: (u) => call('post', '/roles', { key: `r${Math.random().toString(36).slice(2, 8)}`, name: 'R', permissions: ['org:read'] })(u) },
  { name: 'list companies', perm: 'company:read', run: call('get', '/companies') },
  { name: 'create company', perm: 'company:create', run: () => Promise.resolve(0) }, // replaced below (needs unique name)
  { name: 'list periods', perm: 'period:read', run: (u) => call('get', `/companies/${company.id}/periods`)(u) },
  { name: 'list documents', perm: 'document:read', run: call('get', '/documents') },
  { name: 'read audit', perm: 'audit:read', run: call('get', '/audit-events') },
  { name: 'list jobs', perm: 'job:read', run: call('get', '/jobs') },
  { name: 'invite member', perm: 'member:invite', run: (u) => call('post', '/invitations', { email: `nobody-${Math.random().toString(36).slice(2)}@example.test`, roleId: '00000000-0000-4000-8000-0000000000a6' })(u) },
  { name: 'enqueue job', perm: 'job:manage', run: call('post', '/jobs/echo', { message: 'x' }) },
  { name: 'list tasks', perm: 'task:read', run: call('get', '/tasks') },
  { name: 'create task', perm: 'task:manage', run: call('post', '/tasks', { title: 'perm probe' }) },
  { name: 'list workflows', perm: 'workflow:read', run: call('get', '/workflows') },
  { name: 'start workflow', perm: 'workflow:manage', run: call('post', '/workflows', { type: 'generic_approval', subjectType: 'probe', subjectId: 'p' }) },
  { name: 'list integrations', perm: 'integration:read', run: call('get', '/integrations/connections') },
  { name: 'create connection', perm: 'integration:manage', run: call('post', '/integrations/connections', { provider: 'mock', displayName: 'p', credentials: { apiKey: 'abcdefgh' } }) },
  { name: 'list AI proposals', perm: 'ai:use', run: call('get', '/ai/proposals') },
  { name: 'decide AI proposal', perm: 'ai:approve', run: call('post', '/ai/proposals/11111111-1111-4111-8111-111111111111/decision', { decision: 'ACCEPT' }) },
  { name: 'create document', perm: 'document:upload', run: call('post', '/documents', { name: 'p.pdf', contentType: 'application/pdf', sizeBytes: 10 }) },
];
const GHOST = '11111111-1111-4111-8111-111111111111';
probes.push(
  { name: 'list practices', perm: 'practice:read', run: call('get', '/practices') },
  { name: 'list contacts', perm: 'contact:read', run: call('get', '/contacts') },
  { name: 'create contact', perm: 'contact:manage', run: (u) => call('post', '/contacts', { kind: 'PERSON', name: `Perm ${Math.random()}` })(u) },
  { name: 'update practice', perm: 'practice:manage', run: call('patch', `/practices/${GHOST}`, { name: 'x' }) },
  { name: 'grant practice role', perm: 'practice:member:manage', run: (u) => s.api().put(orgPath(owner, `/practices/${GHOST}/members/${GHOST}`)).set(bearer(u.token)).send({ roleId: GHOST }).then((r) => r.status) },
  { name: 'list company access', perm: 'company:access:manage', run: (u) => call('get', `/companies/${company.id}/access`)(u) },
  { name: 'list restricted-document access', perm: 'document:confidential', run: call('get', `/documents/${GHOST}/access`) },
  { name: 'list evidence links', perm: 'evidence:read', run: call('get', `/evidence-links?entityType=document&entityId=${GHOST}`) },
  { name: 'create evidence link', perm: 'evidence:manage', run: call('post', '/evidence-links', { sourceType: 'document', sourceId: GHOST, targetType: 'task', targetId: GHOST, kind: 'SUPPORTS' }) },
  { name: 'lock filing evidence', perm: 'evidence:lock', run: call('post', `/documents/${GHOST}/evidence-lock`, { versionId: GHOST, reason: 'probe' }) },
);
probes.push(
  { name: 'read chart of accounts', perm: 'account:read', run: (u) => call('get', `/companies/${company.id}/accounts`)(u) },
  { name: 'initialise chart of accounts', perm: 'account:manage', run: (u) => call('post', `/companies/${company.id}/accounts/initialise`)(u) },
  { name: 'read journals', perm: 'ledger:read', run: (u) => call('get', `/companies/${company.id}/journals`)(u) },
  { name: 'post journal', perm: 'journal:post', run: (u) => call('post', `/companies/${company.id}/journals`, {})(u) },
  { name: 'lock period', perm: 'period:lock', run: (u) => call('post', `/companies/${company.id}/periods/${GHOST}/lock`, { reason: 'probe' })(u) },
);
probes.find((p) => p.name === 'create company')!.run = (u) => call('post', '/companies', { name: `Perm ${Math.random()}` })(u);
probes.push({ name: 'create period', perm: 'period:manage', run: (u) => call('post', `/companies/${company.id}/periods`, { startDate: `${2000 + Math.floor(Math.random() * 90)}-01-01`, endDate: `${2000 + Math.floor(Math.random() * 90)}-12-31` })(u) });

describe('RBAC matrix: every system role x every guarded capability', () => {
  for (const role of SYSTEM_ROLES) {
    describe(`role ${role.key}`, () => {
      for (const p of probes) {
        const allowed = (role.permissions as string[]).includes(p.perm);
        it(`${allowed ? 'ALLOWED' : 'DENIED '} ${p.name} (${p.perm})`, async () => {
          const status = await p.run(members[role.key]!);
          // allowed => the permission check passed (a 404 from a probe's placeholder id is fine: org membership is proven by the DENIED cases)
          if (allowed) expect([401, 403], `${role.key}/${p.name} got ${status}`).not.toContain(status);
          else expect(status).toBe(403);
        });
      }
    });
  }
  it('probe list covers every permission that guards an endpoint (except the ones with dedicated tests below)', () => {
    const covered = new Set(probes.map((p) => p.perm));
    const untested = PERMISSIONS.filter((p) => !covered.has(p));
    expect(untested.sort()).toEqual(['company:update', 'document:archive', 'member:manage', 'org:manage', 'workflow:approve', 'workflow:review']);
  });
});

describe('other guarded actions', () => {
  it('company:update / member:manage / document:archive are enforced', async () => {
    const viewer = members.client_viewer!, bk = members.bookkeeper!;
    expect((await s.api().patch(orgPath(owner, `/companies/${company.id}`)).set(bearer(bk.token)).send({ name: 'x' })).status).toBe(403);
    expect((await s.api().patch(orgPath(owner, `/companies/${company.id}`)).set(bearer(members.accountant!.token)).send({ name: 'Renamed Ltd' })).status).toBe(200);
    expect((await s.api().patch(orgPath(owner, `/members/${owner.userId}`)).set(bearer(viewer.token)).send({ status: 'SUSPENDED' })).status).toBe(403);
    expect((await s.api().post(orgPath(owner, `/documents/11111111-1111-4111-8111-111111111111/archive`)).set(bearer(bk.token))).status).toBe(403);
  });
});

describe('privilege escalation & integrity guards', () => {
  it('an admin cannot create a role with permissions beyond their own', async () => {
    const admin = members.admin!; // lacks org:manage
    const r = await s.api().post(orgPath(owner, '/roles')).set(bearer(admin.token)).send({ key: 'sneaky', name: 'S', permissions: ['org:manage'] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('privilege_escalation');
  });
  it('an admin cannot invite someone as owner', async () => {
    const r = await s.api().post(orgPath(owner, '/invitations')).set(bearer(members.admin!.token))
      .send({ email: 'x@example.test', roleId: await roleId(s, owner, 'owner') });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('privilege_escalation');
  });
  it('an admin cannot promote themselves or others to owner', async () => {
    const me = (await s.api().get(orgPath(owner, '/members')).set(bearer(owner.token))).body.items.find((m: { user: { id: string } }) => m.user.id === members.admin!.userId);
    const r = await s.api().patch(orgPath(owner, `/members/${me.id}`)).set(bearer(members.admin!.token)).send({ roleId: await roleId(s, owner, 'owner') });
    expect(r.status).toBe(403);
  });
  it('the last owner cannot be demoted, suspended or removed', async () => {
    const list = (await s.api().get(orgPath(owner, '/members')).set(bearer(owner.token))).body.items;
    const ownerMembership = list.find((m: { user: { id: string } }) => m.user.id === owner.userId).id;
    const demote = await s.api().patch(orgPath(owner, `/members/${ownerMembership}`)).set(bearer(owner.token)).send({ roleId: await roleId(s, owner, 'admin') });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('last_owner');
    expect((await s.api().patch(orgPath(owner, `/members/${ownerMembership}`)).set(bearer(owner.token)).send({ status: 'SUSPENDED' })).status).toBe(409);
    expect((await s.api().delete(orgPath(owner, `/members/${ownerMembership}`)).set(bearer(owner.token))).status).toBe(409);
  });
  it('a removed member loses access immediately', async () => {
    const m = await addMember(s, owner, 'reviewer');
    expect((await s.api().get(orgPath(owner, '/companies')).set(bearer(m.token))).status).toBe(200);
    const list = (await s.api().get(orgPath(owner, '/members')).set(bearer(owner.token))).body.items;
    const mid = list.find((x: { user: { id: string } }) => x.user.id === m.userId).id;
    expect((await s.api().delete(orgPath(owner, `/members/${mid}`)).set(bearer(owner.token))).status).toBe(204);
    expect((await s.api().get(orgPath(owner, '/companies')).set(bearer(m.token))).status).toBe(404);
  });
  it('a suspended member loses access; reinstating restores it', async () => {
    const m = await addMember(s, owner, 'reviewer');
    const mid = (await s.api().get(orgPath(owner, '/members')).set(bearer(owner.token))).body.items.find((x: { user: { id: string } }) => x.user.id === m.userId).id;
    await s.api().patch(orgPath(owner, `/members/${mid}`)).set(bearer(owner.token)).send({ status: 'SUSPENDED' });
    expect((await s.api().get(orgPath(owner, '/companies')).set(bearer(m.token))).status).toBe(404);
    await s.api().patch(orgPath(owner, `/members/${mid}`)).set(bearer(owner.token)).send({ status: 'ACTIVE' });
    expect((await s.api().get(orgPath(owner, '/companies')).set(bearer(m.token))).status).toBe(200);
  });
  it('custom roles work and are tenant-private', async () => {
    const r = await s.api().post(orgPath(owner, '/roles')).set(bearer(owner.token)).send({ key: 'doc_clerk', name: 'Doc clerk', permissions: ['org:read', 'document:read'] });
    expect(r.status).toBe(201);
    const other = await createUser(s);
    const roles = await s.api().get(orgPath(other, '/roles')).set(bearer(other.token));
    expect(roles.body.items.some((x: { key: string }) => x.key === 'doc_clerk')).toBe(false);
    // cannot use another tenant's role in an invitation
    const inv = await s.api().post(orgPath(other, '/invitations')).set(bearer(other.token)).send({ email: 'y@example.test', roleId: r.body.id });
    expect(inv.status).toBe(422);
  });
  it('custom role keys cannot shadow system roles; unknown permissions are rejected', async () => {
    expect((await s.api().post(orgPath(owner, '/roles')).set(bearer(owner.token)).send({ key: 'owner', name: 'x', permissions: ['org:read'] })).status).toBe(409);
    expect((await s.api().post(orgPath(owner, '/roles')).set(bearer(owner.token)).send({ key: 'bogus', name: 'x', permissions: ['everything:all'] })).status).toBe(422);
  });
});

describe('invitations', () => {
  it('only the invited, verified address can accept; tokens are single-use', async () => {
    const invitee = await createUser(s);
    const stranger = await createUser(s);
    const inv = await s.api().post(orgPath(owner, '/invitations')).set(bearer(owner.token)).send({ email: invitee.email, roleId: await roleId(s, owner, 'reviewer') });
    expect(inv.status).toBe(201);
    const token = s.mail.tokenFrom((await s.mail.waitFor(invitee.email, /invited/)).text);
    expect((await s.api().post('/api/v1/invitations/accept').set(bearer(stranger.token)).send({ token })).status).toBe(400);
    expect((await s.api().post('/api/v1/invitations/accept').set(bearer(invitee.token)).send({ token })).status).toBe(200);
    expect((await s.api().post('/api/v1/invitations/accept').set(bearer(invitee.token)).send({ token })).status).toBe(400);
  });
  it('revoked and unknown tokens fail', async () => {
    const invitee = await createUser(s);
    const inv = await s.api().post(orgPath(owner, '/invitations')).set(bearer(owner.token)).send({ email: invitee.email, roleId: await roleId(s, owner, 'reviewer') });
    const token = s.mail.tokenFrom((await s.mail.waitFor(invitee.email, /invited/)).text);
    expect((await s.api().delete(orgPath(owner, `/invitations/${inv.body.id}`)).set(bearer(owner.token))).status).toBe(204);
    expect((await s.api().post('/api/v1/invitations/accept').set(bearer(invitee.token)).send({ token })).status).toBe(400);
    expect((await s.api().post('/api/v1/invitations/accept').set(bearer(invitee.token)).send({ token: 'z'.repeat(43) })).status).toBe(400);
  });
  it('duplicate member invitations are refused', async () => {
    const r = await s.api().post(orgPath(owner, '/invitations')).set(bearer(owner.token)).send({ email: members.reviewer!.email, roleId: await roleId(s, owner, 'reviewer') });
    expect(r.status).toBe(409);
  });
});

describe('every permission denial is audited', () => {
  it('records access.denied with the missing permission', async () => {
    await s.api().post(orgPath(owner, '/companies')).set(bearer(members.client_viewer!.token)).send({ name: 'nope' });
    const audit = await s.api().get(orgPath(owner, '/audit-events?action=access.denied')).set(bearer(owner.token));
    expect(audit.body.items.some((e: { metadata: { missing?: string[] } }) => e.metadata.missing?.includes('company:create'))).toBe(true);
  });
  it('Origin header is irrelevant to RBAC but required hygiene: bad origin blocked first', async () => {
    const r = await s.api().post(orgPath(owner, '/companies')).set({ Authorization: `Bearer ${owner.token}`, Origin: 'https://evil.example' }).send({ name: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('origin_not_allowed');
    void ORIGIN;
  });
});
