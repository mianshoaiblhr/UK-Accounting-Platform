import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, roleId, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/** Specification §8: actor, action, entity, before/after, IP/device (where lawful), timestamp, reason, source workflow. */
let s: Stack;
let owner: TestUser, reviewerA: TestUser;
let coA: { id: string }, coB: { id: string };
const call = (u: TestUser, m: 'get' | 'post' | 'patch' | 'put' | 'delete', p: string, b?: object) => s.api()[m](`/api/v1/organisations/${owner.organisationId}${p}`).set(bearer(u.token)).send(b);
const events = async (u: TestUser, qs = '') => (await call(u, 'get', `/audit-events?limit=100${qs}`)).body.items as Array<Record<string, any>>;
const mk = async (name: string) => (await call(owner, 'post', '/companies', { name })).body as { id: string };
const mid = async (u: TestUser) => ((await call(owner, 'get', '/members')).body.items as { id: string; user: { id: string } }[]).find((m) => m.user.id === u.userId)!.id;

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'BUSINESS' });
  coA = await mk('Audit A Ltd');
  coB = await mk('Audit B Ltd');
  reviewerA = await addMember(s, owner, 'client_viewer', { scope: 'ASSIGNED', companyIds: [] });
  expect((await call(owner, 'put', `/companies/${coA.id}/access/${await mid(reviewerA)}`, { roleId: await roleId(s, owner, 'reviewer') })).status).toBe(200);
});
afterAll(() => s.stop());

describe('before / after', () => {
  it('records only the changed fields, for the company concerned', async () => {
    await call(owner, 'patch', `/companies/${coA.id}`, { name: 'Audit A Renamed Ltd' });
    const e = (await events(owner, '&action=company.updated')).find((x) => x.entityId === coA.id)!;
    expect(e).toMatchObject({ before: { name: 'Audit A Ltd' }, after: { name: 'Audit A Renamed Ltd' }, companyId: coA.id, actorUserId: owner.userId, entityType: 'company' });
    expect(Object.keys(e.after)).toEqual(['name']);
  });
  it('member changes show the old and new role/status', async () => {
    const m = await addMember(s, owner, 'accountant');
    const id = await mid(m);
    expect((await call(owner, 'patch', `/members/${id}`, { status: 'SUSPENDED', reason: 'left the firm' })).status).toBe(200);
    const e = (await events(owner, '&action=member.updated')).find((x) => x.entityId === id)!;
    expect(e).toMatchObject({ before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' }, reason: 'left the firm' });
  });
  it('no secret ever reaches the trail (integration credentials, tokens)', async () => {
    await call(owner, 'post', '/integrations/connections', { provider: 'mock', displayName: 'Bank', credentials: { apiKey: 'super-secret-key-123' } });
    const all = adminSql(`SELECT string_agg(coalesce(before::text,'')||coalesce(after::text,'')||metadata::text, ' ') FROM audit_event WHERE organisation_id='${owner.organisationId}'`);
    expect(all).not.toContain('super-secret-key-123');
  });
});

describe('reason', () => {
  it('is recorded for sensitive actions: archive, access removal, member removal, integration revoke', async () => {
    const d = await uploadDoc(s, owner, { companyId: coA.id });
    await waitForVersion(s, owner, d.documentId, d.versionId);
    expect((await call(owner, 'post', `/documents/${d.documentId}/archive`, { reason: 'superseded by 2026 pack' })).status).toBe(200);
    const m = await addMember(s, owner, 'bookkeeper');
    const id = await mid(m);
    await call(owner, 'put', `/companies/${coB.id}/access/${id}`, { roleId: await roleId(s, owner, 'reviewer') });
    expect((await call(owner, 'delete', `/companies/${coB.id}/access/${id}?reason=${encodeURIComponent('project ended')}`)).status).toBe(204);
    expect((await call(owner, 'delete', `/members/${id}?reason=${encodeURIComponent('contract finished')}`)).status).toBe(204);
    const by = (action: string) => events(owner, `&action=${action}`);
    expect((await by('document.archived'))[0]).toMatchObject({ reason: 'superseded by 2026 pack', before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' }, companyId: coA.id });
    expect((await by('company.access_removed'))[0]).toMatchObject({ reason: 'project ended', companyId: coB.id });
    expect((await by('member.removed'))[0]).toMatchObject({ reason: 'contract finished', after: { status: 'REMOVED' } });
  });
  it('is bounded and validated', async () => {
    const r = await call(owner, 'delete', `/members/11111111-1111-4111-8111-111111111111?reason=${'x'.repeat(600)}`);
    expect(r.status).toBe(422);
  });
});

describe('source workflow', () => {
  it('every workflow step is an audit event pointing at its workflow, with the comment as reason', async () => {
    const w = (await call(owner, 'post', '/workflows', { type: 'generic_approval', subjectType: 'demo', subjectId: 'x', companyId: coA.id })).body;
    await call(owner, 'post', `/workflows/${w.id}/transitions`, { action: 'submit', comment: 'ready' });
    const trail = await events(owner, `&sourceWorkflowId=${w.id}`);
    expect(trail.map((e) => e.action).sort()).toEqual(['workflow.started', 'workflow.submit']);
    const submit = trail.find((e) => e.action === 'workflow.submit')!;
    expect(submit).toMatchObject({ before: { state: 'DRAFT' }, after: { state: 'SUBMITTED' }, reason: 'ready', companyId: coA.id, entityId: w.id, sourceWorkflowId: w.id });
  });
});

describe('per-company visibility of the trail', () => {
  it('a company-level auditor sees that company\'s events only - not other companies\' and not organisation-level ones', async () => {
    await call(owner, 'patch', `/companies/${coB.id}`, { name: 'Audit B Renamed Ltd' });
    const seen = await events(reviewerA);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.companyId === coA.id)).toBe(true);
    expect(seen.some((e) => e.action === 'company.updated' && e.entityId === coA.id)).toBe(true);
    expect(seen.some((e) => e.entityId === coB.id)).toBe(false);
    // filtering by a company they cannot audit yields nothing, not an error that reveals existence
    expect(await events(reviewerA, `&companyId=${coB.id}`)).toEqual([]);
  });
  it('the owner sees everything, including organisation-level events', async () => {
    const all = await events(owner);
    expect(all.some((e) => e.companyId === null)).toBe(true);
    expect(all.some((e) => e.companyId === coA.id)).toBe(true);
    expect(all.some((e) => e.companyId === coB.id)).toBe(true);
  });
  it('filters: by entity, actor, outcome and time window', async () => {
    expect((await events(owner, `&entityType=company&entityId=${coA.id}`)).every((e) => e.entityId === coA.id)).toBe(true);
    expect((await events(owner, `&actorUserId=${owner.userId}`)).every((e) => e.actorUserId === owner.userId)).toBe(true);
    expect((await events(owner, `&from=${encodeURIComponent('2999-01-01T00:00:00Z')}`))).toEqual([]);
    expect((await events(owner, '&outcome=DENIED')).every((e) => e.outcome === 'DENIED')).toBe(true);
  });
  it('denied access attempts are recorded against the company concerned', async () => {
    expect((await call(reviewerA, 'patch', `/companies/${coA.id}`, { name: 'nope' })).status).toBe(403); // a reviewer may not edit the company
    const denied = (await events(owner, '&outcome=DENIED')).find((e) => e.actorUserId === reviewerA.userId && e.companyId === coA.id);
    expect(denied).toBeTruthy();
  });
});

describe('integrity', () => {
  it('the trail stays append-only and the new columns cannot be edited', () => {
    const id = adminSql(`SELECT id FROM audit_event WHERE organisation_id='${owner.organisationId}' LIMIT 1`);
    expect(() => adminSql(`UPDATE audit_event SET reason='tamper' WHERE id='${id}'`)).toThrow(/append-only/);
    expect(() => adminSql(`DELETE FROM audit_event WHERE id='${id}'`)).toThrow(/append-only/);
  });
  it('an event may only name a company of its own organisation', async () => {
    const other = await createUser(s, { type: 'BUSINESS' });
    expect(() => adminSql(`INSERT INTO audit_event(organisation_id,company_id,action) VALUES ('${other.organisationId}','${coA.id}','x')`)).toThrow(/does not belong/);
    expect(() => adminSql(`INSERT INTO audit_event(company_id,action) VALUES ('${coA.id}','x')`)).toThrow(/does not belong/);
  });
});

describe('IP / device metadata only where lawful (AUDIT_CAPTURE_DEVICE_METADATA)', () => {
  it('captured by default for security-relevant events', () => {
    expect(Number(adminSql(`SELECT count(*) FROM audit_event WHERE organisation_id='${owner.organisationId}' AND ip IS NOT NULL`))).toBeGreaterThan(0);
  });
});
