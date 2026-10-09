import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V0-7.3 through the API and the real worker: preferences, opt-in e-mail delivery, and the privacy of the e-mail. */
let s: Stack;
let owner: TestUser, member: TestUser, other: TestUser;
let company: { id: string };
const as = (u: TestUser, m: 'get' | 'post' | 'put' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const view = (u: TestUser) => as(u, 'get', '/notifications/preferences');
const channel = (body: { channels: { channel: string; categories: { category: string; enabled: boolean }[] }[] }, name: string) => body.channels.find((c) => c.channel === name)!;
const assign = (title: string) => as(owner, 'post', '/tasks', { title, companyId: company.id, assigneeUserId: member.userId });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Prefs Client');
  member = await addMember(s, owner, 'accountant');
  other = await createUser(s, { type: 'PRACTICE' });
});
afterAll(() => s.stop());

describe('notification preferences', () => {
  it('lists every channel: in-app mandatory and on, e-mail available and off by default, sms/whatsapp unavailable', async () => {
    const r = await view(member);
    expect(r.status).toBe(200);
    expect(r.body.channels.map((c: { channel: string }) => c.channel)).toEqual(['in_app', 'email', 'sms', 'whatsapp']);
    expect(channel(r.body, 'in_app')).toMatchObject({ available: true, mandatory: true });
    expect(channel(r.body, 'in_app').categories.every((c: { enabled: boolean }) => c.enabled)).toBe(true);
    expect(channel(r.body, 'email')).toMatchObject({ available: true, mandatory: false });
    expect(channel(r.body, 'email').categories.map((c: { category: string; enabled: boolean }) => [c.category, c.enabled])).toEqual([['task', false], ['workflow', false], ['system', false]]);
    expect(channel(r.body, 'sms')).toMatchObject({ available: false });
    expect(channel(r.body, 'whatsapp')).toMatchObject({ available: false });
    expect(channel(r.body, 'sms').categories.every((c: { enabled: boolean }) => !c.enabled)).toBe(true);
  });

  it('a user opts in and out of e-mail per category; the change is audited with before/after', async () => {
    const on = await as(member, 'put', '/notifications/preferences', { channel: 'email', category: 'task', enabled: true });
    expect(on.status).toBe(200);
    expect(channel(on.body, 'email').categories.find((c: { category: string }) => c.category === 'task')!.enabled).toBe(true);
    expect(channel((await view(member)).body, 'email').categories.find((c: { category: string }) => c.category === 'workflow')!.enabled).toBe(false);
    expect((await as(member, 'put', '/notifications/preferences', { channel: 'email', category: 'task', enabled: true })).status).toBe(200); // idempotent, no second audit row
    const off = await as(member, 'put', '/notifications/preferences', { channel: 'email', category: 'task', enabled: false });
    expect(channel(off.body, 'email').categories.find((c: { category: string }) => c.category === 'task')!.enabled).toBe(false);
    const audit = adminSql(`SELECT count(*) FROM audit_event WHERE action='notification.preference_changed' AND actor_user_id='${member.userId}'`);
    expect(audit).toBe('2');
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action='notification.preference_changed' AND before IS NOT NULL AND after IS NOT NULL AND actor_user_id='${member.userId}'`)).toBe('2');
  });

  it('preferences are strictly personal: another member does not see them, and nobody can set another user\'s', async () => {
    await as(member, 'put', '/notifications/preferences', { channel: 'email', category: 'workflow', enabled: true });
    expect(channel((await view(owner)).body, 'email').categories.find((c: { category: string }) => c.category === 'workflow')!.enabled).toBe(false);
    expect((await as(owner, 'put', '/notifications/preferences', { channel: 'email', category: 'system', enabled: true, userId: member.userId })).status).toBe(422); // strict schema: no user in the body
    expect(adminSql(`SELECT count(*) FROM notification_preference WHERE user_id='${owner.userId}' AND category='workflow'`)).toBe('0');
  });

  it('in-app cannot be switched off; sms and whatsapp cannot be switched on; bad values are rejected', async () => {
    expect((await as(member, 'put', '/notifications/preferences', { channel: 'in_app', category: 'task', enabled: false })).body.code).toBe('channel_mandatory');
    expect((await as(member, 'put', '/notifications/preferences', { channel: 'in_app', category: 'task', enabled: true })).status).toBe(200);
    expect((await as(member, 'put', '/notifications/preferences', { channel: 'sms', category: 'task', enabled: true })).body.code).toBe('channel_unavailable');
    expect((await as(member, 'put', '/notifications/preferences', { channel: 'whatsapp', category: 'task', enabled: true })).body.code).toBe('channel_unavailable');
    expect((await as(member, 'put', '/notifications/preferences', { channel: 'sms', category: 'task', enabled: false })).status).toBe(200); // opting out of a stub is harmless
    expect((await as(member, 'put', '/notifications/preferences', { channel: 'pigeon', category: 'task', enabled: true })).status).toBe(422);
    expect((await as(member, 'put', '/notifications/preferences', { channel: 'email', category: 'billing', enabled: true })).status).toBe(422);
    expect(adminSql(`SELECT count(*) FROM notification_preference WHERE user_id='${member.userId}' AND channel IN ('sms','whatsapp') AND enabled`)).toBe('0');
  });

  it('is scoped to the organisation: an outsider cannot read or change them (404/403) and an unauthenticated call is 401', async () => {
    expect((await s.api().get(orgPath(owner, '/notifications/preferences')).set(bearer(other.token))).status).toBeGreaterThanOrEqual(403);
    expect((await s.api().put(orgPath(owner, '/notifications/preferences')).set(bearer(other.token)).send({ channel: 'email', category: 'task', enabled: true })).status).toBeGreaterThanOrEqual(403);
    expect((await s.api().get(orgPath(owner, '/notifications/preferences'))).status).toBe(401);
  });
});

describe('e-mail delivery through the real worker', () => {
  it('without an opt-in a task assignment produces the in-app notification and no e-mail', async () => {
    await as(member, 'put', '/notifications/preferences', { channel: 'email', category: 'task', enabled: false });
    const t = (await assign('Silent task SECRET-ONE')).body;
    const note = async () => (await as(member, 'get', '/notifications?limit=50')).body.items.find((n: { entityId: string }) => n.entityId === t.id);
    const deadline = Date.now() + 10_000;
    while (!(await note()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
    expect(await note()).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1_000)); // sweeper interval is 300 ms in tests
    expect(adminSql(`SELECT count(*) FROM notification_delivery WHERE user_id='${member.userId}' AND title='A task was assigned to you' AND notification_id=(SELECT id FROM notification WHERE entity_id='${t.id}')`)).toBe('0');
  });

  it('after opting in, the same event is e-mailed once, with the title and no task content; opting out stops it', async () => {
    await as(member, 'put', '/notifications/preferences', { channel: 'email', category: 'task', enabled: true });
    const t = (await assign('Prepare VAT return SECRET-TWO')).body;
    const mail = await s.mail.waitFor(member.email, /task was assigned to you/);
    expect(mail.text).toContain('A task was assigned to you');
    expect(mail.text).not.toContain('SECRET-TWO');
    expect(mail.text).not.toContain('VAT');
    const noteId = adminSql(`SELECT id FROM notification WHERE entity_id='${t.id}'`);
    const delivery = adminSql(`SELECT status||'|'||channel FROM notification_delivery WHERE notification_id='${noteId}'`);
    expect(delivery).toBe('SENT|email');
    expect(adminSql(`SELECT count(*) FROM job_record WHERE idempotency_key LIKE '%notification-delivery:%' AND organisation_id='${owner.organisationId}' AND status='COMPLETED'`)).not.toBe('0');
    // the in-app notification still has the body (it is private to the recipient)
    expect((await as(member, 'get', '/notifications?limit=50')).body.items.find((n: { entityId: string }) => n.entityId === t.id).body).toContain('SECRET-TWO');
    await as(member, 'put', '/notifications/preferences', { channel: 'email', category: 'task', enabled: false });
    const t2 = (await assign('After opt-out SECRET-THREE')).body;
    const deadline = Date.now() + 10_000;
    const planned = () => adminSql(`SELECT count(*) FROM notification n WHERE n.entity_id='${t2.id}'`) !== '0';
    while (!planned() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(adminSql(`SELECT count(*) FROM notification_delivery d JOIN notification n ON n.id = d.notification_id WHERE n.entity_id='${t2.id}'`)).toBe('0');
  });

});
