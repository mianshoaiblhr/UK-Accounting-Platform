import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V0-4.7 through the public API: deadlines, the overdue flag and filter, permissions, tenant/company visibility, and the worker's one-time notification. */
let s: Stack;
let owner: TestUser, manager: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string }, otherCompany: { id: string };
const call = (u: TestUser, m: 'get' | 'post', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const TOKEN = 'wf-deadlines-metrics-token-0123456789';
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const start = (u: TestUser, extra: object = {}) => call(u, 'post', '/workflows', { type: 'generic_approval', subjectType: 'deadline', subjectId: `d-${Math.random()}`, companyId: company.id, ...extra });
const until = async <T>(fn: () => Promise<T | false | undefined>, ms = 15_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};

beforeAll(async () => {
  s = await startStack({ METRICS_TOKEN: TOKEN });
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Deadline Client');
  otherCompany = await makeCompany(s, owner, 'Deadline Other');
  manager = await addMember(s, owner, 'manager');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
});
afterAll(() => s.stop());

describe('workflow deadlines over the API', () => {
  it('a workflow can be started with a deadline; without one it has none; a past deadline is rejected', async () => {
    const due = iso(3_600_000);
    const a = await start(owner, { dueAt: due });
    expect(a.status).toBe(201);
    expect(new Date(a.body.dueAt).getTime()).toBe(new Date(due).getTime());
    expect(a.body.overdue).toBe(false);
    expect(a.body).not.toHaveProperty('overdueAttempts');
    expect(a.body).not.toHaveProperty('overdueLastError');
    expect((await start(owner)).body).toMatchObject({ dueAt: null, overdue: false });
    expect((await start(owner, { dueAt: iso(-60_000) })).status).toBe(422);
    expect((await start(owner, { dueAt: 'tomorrow' })).status).toBe(422);
    expect((await start(owner, { dueAt: '2099-01-01T00:00:00' })).status).toBe(422); // an offset is required: no guessing the time zone
  });

  it('the deadline can be set, moved and cleared; each change is in the history and the audit trail; the version moves', async () => {
    const w = (await start(owner)).body;
    const set = await call(manager, 'post', `/workflows/${w.id}/due-date`, { dueAt: iso(7_200_000), comment: 'agreed with client', expectedVersion: w.version });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ version: w.version + 1, overdue: false });
    expect(set.body.dueAt).toBeTruthy();
    expect((await call(manager, 'post', `/workflows/${w.id}/due-date`, { dueAt: iso(1000), expectedVersion: w.version })).body.code).toBe('version_conflict');
    const cleared = await call(manager, 'post', `/workflows/${w.id}/due-date`, { dueAt: null });
    expect(cleared.body.dueAt).toBeNull();
    const detail = (await call(owner, 'get', `/workflows/${w.id}`)).body;
    expect(detail.transitions.map((t: { action: string }) => t.action)).toEqual(['start', 'set_due_date', 'set_due_date']);
    expect(detail.transitions[1].comment).toBe('agreed with client');
    const audit = (await call(owner, 'get', `/audit-events?entityType=workflow_instance&entityId=${w.id}`)).body.items.filter((e: { action: string }) => e.action === 'workflow.due_date_changed');
    expect(audit).toHaveLength(2);
    expect(audit.some((e: { before: { dueAt: string | null }; after: { dueAt: string | null } }) => e.before.dueAt !== null && e.after.dueAt === null)).toBe(true);
    expect((await call(manager, 'post', `/workflows/${w.id}/due-date`, { dueAt: 'soon' })).status).toBe(422);
    expect((await call(manager, 'post', `/workflows/${w.id}/due-date`, { dueAt: null, state: 'COMPLETED' })).status).toBe(422); // strict schema
  });

  it('only people with workflow:manage for the workflow\'s company can change it; outsiders get 404', async () => {
    const w = (await start(owner, { dueAt: iso(3_600_000) })).body;
    expect((await call(viewer, 'post', `/workflows/${w.id}/due-date`, { dueAt: null })).status).toBe(403);
    expect((await s.api().post(orgPath(owner, `/workflows/${w.id}/due-date`)).set(bearer(outsider.token)).send({ dueAt: null })).status).toBe(404);
    expect((await call(owner, 'get', `/workflows/${w.id}`)).body.dueAt).toBeTruthy(); // unchanged
  });

  it('a finished workflow has no deadline to change', async () => {
    const w = (await start(owner)).body;
    await call(owner, 'post', `/workflows/${w.id}/transitions`, { action: 'cancel' });
    expect((await call(owner, 'post', `/workflows/${w.id}/due-date`, { dueAt: iso(60_000) })).body.code).toBe('workflow_finished');
  });

  it('overdue is computed from the deadline and the state, and filterable', async () => {
    const late = (await start(owner, { dueAt: iso(1_500) })).body;
    const future = (await start(owner, { dueAt: iso(86_400_000) })).body;
    const none = (await start(owner)).body;
    const finishedLate = (await start(owner, { dueAt: iso(1_500) })).body;
    await call(owner, 'post', `/workflows/${finishedLate.id}/transitions`, { action: 'cancel' });
    await new Promise((r) => setTimeout(r, 1_800));
    const ids = async (q: string) => (await call(owner, 'get', `/workflows?limit=100${q}`)).body.items.map((x: { id: string }) => x.id);
    const overdue = await ids('&overdue=true');
    expect(overdue).toContain(late.id);
    for (const w of [future, none, finishedLate]) expect(overdue).not.toContain(w.id);
    const rest = await ids('&overdue=false');
    expect(rest).not.toContain(late.id);
    for (const w of [future, none, finishedLate]) expect(rest).toContain(w.id);
    expect((await call(owner, 'get', `/workflows/${late.id}`)).body.overdue).toBe(true);
    expect((await call(owner, 'get', `/workflows/${finishedLate.id}`)).body.overdue).toBe(false);
    expect((await call(owner, 'get', '/workflows?overdue=maybe')).status).toBe(422);
  });

  it('the overdue filter respects company visibility', async () => {
    const mine = (await call(owner, 'post', '/workflows', { type: 'generic_approval', subjectType: 'deadline', subjectId: 'oc', companyId: otherCompany.id, dueAt: iso(1_200) })).body;
    await new Promise((r) => setTimeout(r, 1_500));
    // a member assigned only to `company` cannot see (or filter their way to) a workflow of otherCompany
    const restricted = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [company.id] });
    const seen = (await s.api().get(orgPath(owner, '/workflows?overdue=true&limit=100')).set(bearer(restricted.token))).body.items.map((x: { id: string }) => x.id);
    expect(seen).not.toContain(mine.id);
    expect((await call(owner, 'get', '/workflows?overdue=true&limit=100')).body.items.map((x: { id: string }) => x.id)).toContain(mine.id);
  });

  it('the worker notifies the assignee once; moving the deadline re-arms it; nothing about the workflow is in the notification', async () => {
    const w = (await start(owner, { dueAt: iso(1_000) })).body;
    await call(owner, 'post', `/workflows/${w.id}/reassign`, { assigneeUserId: manager.userId });
    const mine = async () => (await s.api().get(orgPath(owner, '/notifications?limit=100')).set(bearer(manager.token))).body.items.filter((n: { entityId: string; type: string }) => n.entityId === w.id && n.type === 'workflow.overdue');
    const first = await until(async () => { const n = await mine(); return n.length ? n : false; });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ title: 'A workflow is overdue', entityType: 'workflow_instance' });
    expect(JSON.stringify(first[0])).not.toMatch(/generic_approval/);
    expect((await call(owner, 'get', `/workflows/${w.id}`)).body.overdueNotifiedAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await mine()).toHaveLength(1); // one-time
    // the starter is not the recipient while there is an assignee
    expect((await s.api().get(orgPath(owner, '/notifications?limit=100')).set(bearer(owner.token))).body.items.some((n: { entityId: string }) => n.entityId === w.id)).toBe(false);
    // re-arm: new deadline in the past-to-be
    await call(manager, 'post', `/workflows/${w.id}/due-date`, { dueAt: iso(1_000) });
    expect((await call(owner, 'get', `/workflows/${w.id}`)).body.overdueNotifiedAt).toBeNull();
    await until(async () => (await mine()).length === 2);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action='workflow.overdue_notified' AND entity_id='${w.id}'`)).toBe('2');
  });

  it('definitions expose the service level (none of the shipped definitions has one)', async () => {
    const defs = (await call(owner, 'get', '/workflows/definitions')).body.items;
    expect(defs.every((d: { slaHours: number | null }) => d.slaHours === null)).toBe(true);
  });

  it('the overdue gauge counts open instances past their deadline', async () => {
    await start(owner, { dueAt: iso(1_000) });
    await new Promise((r) => setTimeout(r, 1_300));
    const text = (await s.api().get('/api/v1/metrics').set('Authorization', `Bearer ${TOKEN}`)).text;
    expect(text).toMatch(/\nworkflows_overdue [1-9]/);
  });
});
