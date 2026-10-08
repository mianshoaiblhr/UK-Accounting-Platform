import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAiProvider } from '@uk/platform';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, waitForJob, type Stack, type TestUser } from '../helpers/stack';

let s: Stack;
let owner: TestUser, accountant: TestUser, bookkeeper: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string };

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner);
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s);
});
afterAll(() => s.stop());

const until = async <T>(fn: () => Promise<T | false | undefined>, ms = 15_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};
const get = (u: TestUser, p: string) => s.api().get(orgPath(owner, p)).set(bearer(u.token));
const post = (u: TestUser, p: string, body: object = {}) => s.api().post(orgPath(owner, p)).set(bearer(u.token)).send(body);
const patch = (u: TestUser, p: string, body: object) => s.api().patch(orgPath(owner, p)).set(bearer(u.token)).send(body);

describe('tasks', () => {
  it('creates, lists, updates and completes tasks', async () => {
    const t = await post(owner, '/tasks', { title: 'Collect bank statements', companyId: company.id, priority: 'HIGH', dueDate: '2026-12-31' });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ status: 'OPEN', priority: 'HIGH', createdByUserId: owner.userId });
    const done = await patch(owner, `/tasks/${t.body.id}`, { status: 'DONE' });
    expect(done.body.status).toBe('DONE');
    expect(done.body.completedAt).toBeTruthy();
    const list = await get(owner, '/tasks?status=DONE');
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(t.body.id);
  });
  it('only active members with access to the company can be assigned', async () => {
    expect((await post(owner, '/tasks', { title: 'x', assigneeUserId: outsider.userId })).body.code).toBe('invalid_assignee');
    const scoped = await addMember(s, owner, 'bookkeeper', { scope: 'ASSIGNED', companyIds: [] });
    expect((await post(owner, '/tasks', { title: 'x', companyId: company.id, assigneeUserId: scoped.userId })).body.code).toBe('invalid_assignee');
    expect((await post(owner, '/tasks', { title: 'x', assigneeUserId: scoped.userId })).status).toBe(201); // org-level task: fine
  });
  it('tenant isolation: another organisation cannot see or change tasks', async () => {
    const t = await post(owner, '/tasks', { title: 'private' });
    expect((await s.api().get(orgPath(owner, `/tasks/${t.body.id}`)).set(bearer(outsider.token))).status).toBe(404);
    expect((await s.api().get(orgPath(outsider, '/tasks')).set(bearer(outsider.token))).body.items).toHaveLength(0);
    expect((await s.api().patch(orgPath(outsider, `/tasks/${t.body.id}`)).set(bearer(outsider.token)).send({ status: 'DONE' })).status).toBe(404);
  });
  it('read-only roles cannot create tasks', async () => {
    expect((await post(viewer, '/tasks', { title: 'nope' })).status).toBe(403);
  });
});

describe('outbox -> relay -> events queue -> idempotent consumers -> notifications (end to end)', () => {
  it('assigning a task produces an outbox event, a single notification for the assignee, and no self-notification', async () => {
    const t = await post(owner, '/tasks', { title: 'Prepare VAT workings', assigneeUserId: bookkeeper.userId });
    const note = await until(async () => (await get(bookkeeper, '/notifications')).body.items.find((n: { entityId: string }) => n.entityId === t.body.id));
    expect(note).toMatchObject({ type: 'task.assigned', body: 'Prepare VAT workings', readAt: null, userId: bookkeeper.userId });
    const ev = JSON.parse(adminSql(`SELECT row_to_json(e) FROM outbox_event e WHERE aggregate_id='${t.body.id}'`));
    expect(ev).toMatchObject({ event_type: 'task.assigned', organisation_id: owner.organisationId, status: 'PUBLISHED', retry_count: 0, actor_user_id: owner.userId });
    expect(ev.correlation_id).toBeTruthy();
    // owner assigned it, so owner got nothing
    expect((await get(owner, '/notifications')).body.items.some((n: { entityId: string }) => n.entityId === t.body.id)).toBe(false);
    // redelivery (at-least-once) is harmless: consumer already recorded
    const again = await s.worker.bus.dispatch(ev.id);
    expect(again.skipped).toContain('notifications.task_assigned');
    expect((await get(bookkeeper, '/notifications')).body.items.filter((n: { entityId: string }) => n.entityId === t.body.id)).toHaveLength(1);
    expect(adminSql(`SELECT count(*) FROM event_consumption WHERE event_id='${ev.id}'`)).toBe('1');
  });

  it('existing business actions publish their domain events', async () => {
    const c = await makeCompany(s, owner, 'Eventful Ltd');
    await s.api().post(orgPath(owner, `/companies/${c.id}/periods`)).set(bearer(owner.token)).send({ startDate: '2026-01-01', endDate: '2026-12-31' });
    const types = adminSql(`SELECT string_agg(event_type, ',') FROM outbox_event WHERE organisation_id='${owner.organisationId}'`);
    for (const t of ['company.created', 'accounting_period.created', 'organisation.member_added']) expect(types).toContain(t);
    await until(async () => adminSql(`SELECT count(*) FROM outbox_event WHERE organisation_id='${owner.organisationId}' AND status='PENDING'`) === '0');
  });

  it('a consumer failure is retried without re-running consumers that already succeeded', async () => {
    const { EventBus } = await import('@uk/platform');
    const bus = new EventBus(s.db, (await import('@uk/core')).createLogger('silent'));
    let okRuns = 0, flaky = 0;
    bus.subscribe('test.ok', ['company.created'], async () => { okRuns++; });
    bus.subscribe('test.flaky', ['company.created'], async () => { if (flaky++ === 0) throw new Error('transient'); });
    const evId = adminSql(`SELECT id FROM outbox_event WHERE event_type='company.created' ORDER BY created_at DESC LIMIT 1`);
    await expect(bus.dispatch(evId)).rejects.toThrow('transient');
    const second = await bus.dispatch(evId);
    expect(okRuns).toBe(1);
    expect(second.ran).toEqual(['test.flaky']);
    expect(second.skipped).toEqual(['test.ok']);
  });
});

describe('notifications', () => {
  it('are private to the recipient (RLS) and track read state', async () => {
    const t = await post(owner, '/tasks', { title: 'Privacy check', assigneeUserId: accountant.userId });
    const n = await until(async () => (await get(accountant, '/notifications')).body.items.find((x: { entityId: string }) => x.entityId === t.body.id));
    expect((await get(accountant, '/notifications/unread-count')).body.count).toBeGreaterThanOrEqual(1);
    // a colleague in the same organisation, with a valid id, still cannot read or mark it
    expect((await s.api().post(orgPath(owner, `/notifications/${n.id}/read`)).set(bearer(bookkeeper.token))).status).toBe(404);
    expect((await get(bookkeeper, '/notifications')).body.items.some((x: { id: string }) => x.id === n.id)).toBe(false);
    expect((await s.api().post(orgPath(owner, `/notifications/${n.id}/read`)).set(bearer(accountant.token))).status).toBe(200);
    expect((await s.api().post(orgPath(owner, '/notifications/read-all')).set(bearer(accountant.token))).status).toBe(200);
    expect((await get(accountant, '/notifications/unread-count')).body.count).toBe(0);
  });
});

describe('workflow foundation', () => {
  const start = (u = owner) => post(u, '/workflows', { type: 'generic_approval', subjectType: 'demo', subjectId: 'subject-1' });
  it('lists registered definitions', async () => {
    const d = await get(owner, '/workflows/definitions');
    expect(d.body.items.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['generic_approval', 'ai_proposal_review']));
  });
  it('maker/checker: starter cannot approve own submission; a different authorised user can; history is append-only', async () => {
    const w = await start();
    expect(w.status).toBe(201);
    expect(w.body.state).toBe('DRAFT');
    expect((await post(owner, `/workflows/${w.body.id}/transitions`, { action: 'submit' })).body.state).toBe('SUBMITTED');
    const selfApprove = await post(owner, `/workflows/${w.body.id}/transitions`, { action: 'approve' });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.code).toBe('separation_of_duties');
    const view = await get(accountant, `/workflows/${w.body.id}`);
    expect(view.body.availableActions.sort()).toEqual(['approve', 'cancel', 'reject']);
    expect((await get(owner, `/workflows/${w.body.id}`)).body.availableActions).toEqual(['cancel']);
    const ok = await post(accountant, `/workflows/${w.body.id}/transitions`, { action: 'approve' });
    expect(ok.body).toMatchObject({ state: 'APPROVED' });
    expect(ok.body.completedAt).toBeTruthy();
    const full = await get(owner, `/workflows/${w.body.id}`);
    expect(full.body.transitions.map((t: { action: string }) => t.action)).toEqual(['start', 'submit', 'approve']);
    expect(() => adminSql(`UPDATE workflow_transition SET action='x' WHERE instance_id='${w.body.id}'`)).toThrow(/append-only/);
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE aggregate_id='${w.body.id}' AND event_type='workflow.transitioned'`)).toBe('3');
  });
  it('enforces valid transitions, terminal states, comments and optimistic concurrency', async () => {
    const w = await start();
    expect((await post(owner, `/workflows/${w.body.id}/transitions`, { action: 'approve' })).body.code).toBe('invalid_transition');
    await post(owner, `/workflows/${w.body.id}/transitions`, { action: 'submit' });
    expect((await post(accountant, `/workflows/${w.body.id}/transitions`, { action: 'reject' })).body.code).toBe('comment_required');
    expect((await post(accountant, `/workflows/${w.body.id}/transitions`, { action: 'reject', comment: 'wrong period', expectedVersion: 1 })).body.code).toBe('version_conflict');
    const rej = await post(accountant, `/workflows/${w.body.id}/transitions`, { action: 'reject', comment: 'wrong period', expectedVersion: 2 });
    expect(rej.body.state).toBe('REJECTED');
    expect((await post(accountant, `/workflows/${w.body.id}/transitions`, { action: 'cancel' })).body.code).toBe('workflow_finished');
  });
  it('permissions and exposure: server-only workflows cannot be started via the API; viewers cannot act; tenants are isolated', async () => {
    expect((await post(owner, '/workflows', { type: 'ai_proposal_review', subjectType: 'x', subjectId: 'y' })).body.code).toBe('workflow_not_startable');
    expect((await post(owner, '/workflows', { type: 'nope', subjectType: 'x', subjectId: 'y' })).body.code).toBe('unknown_workflow');
    expect((await start(viewer)).status).toBe(403);
    const w = await start();
    expect((await s.api().get(orgPath(owner, `/workflows/${w.body.id}`)).set(bearer(outsider.token))).status).toBe(404);
    expect((await s.api().post(orgPath(owner, `/workflows/${w.body.id}/transitions`)).set(bearer(outsider.token)).send({ action: 'submit' })).status).toBe(404);
  });
});

describe('integration abstraction', () => {
  let connId: string;
  it('lists providers (mock only outside production) and rejects bad credential shapes', async () => {
    expect((await get(owner, '/integrations/providers')).body.items.map((p: { provider: string }) => p.provider)).toEqual(['mock']);
    const bad = await post(owner, '/integrations/connections', { provider: 'mock', displayName: 'Bad', credentials: { apiKey: 'x' } });
    expect(bad.status).toBe(422);
    expect((await post(owner, '/integrations/connections', { provider: 'hmrc', displayName: 'No', credentials: {} })).body.code).toBe('unknown_provider');
  });
  it('stores credentials encrypted and never returns or audits them', async () => {
    const r = await post(owner, '/integrations/connections', { provider: 'mock', displayName: 'Mock A', credentials: { apiKey: 'super-secret-key-123' } });
    expect(r.status).toBe(201);
    connId = r.body.id;
    expect(JSON.stringify(r.body)).not.toContain('super-secret');
    expect(JSON.stringify((await get(owner, '/integrations/connections')).body)).not.toContain('super-secret');
    expect(adminSql(`SELECT credentials_encrypted FROM integration_connection WHERE id='${connId}'`)).toMatch(/^v1:/);
    expect(adminSql(`SELECT credentials_encrypted FROM integration_connection WHERE id='${connId}'`)).not.toContain('super-secret');
    expect(adminSql(`SELECT string_agg(metadata::text,' ') FROM audit_event WHERE entity_id='${connId}'`)).not.toContain('super-secret');
  });
  it('health checks work; external calls run asynchronously through the job queue', async () => {
    expect((await post(owner, `/integrations/connections/${connId}/check`)).body.ok).toBe(true);
    const ex = await post(owner, `/integrations/connections/${connId}/execute`, { operation: 'echo', params: { hello: 'world' } });
    expect(ex.status).toBe(202);
    const job = await waitForJob(s, owner, ex.body.jobId, ['COMPLETED', 'DEAD', 'FAILED']);
    expect(job.status).toBe('COMPLETED');
    expect(job.result).toEqual({ echo: { hello: 'world' } });
  });
  it('unsupported operations fail permanently; unhealthy credentials mark the connection ERROR', async () => {
    const ex = await post(owner, `/integrations/connections/${connId}/execute`, { operation: 'delete_everything' });
    expect((await waitForJob(s, owner, ex.body.jobId, ['DEAD', 'FAILED', 'COMPLETED'])).status).toBe('FAILED'); // permanent: no retries
    const bad = await post(owner, '/integrations/connections', { provider: 'mock', displayName: 'Bad key', credentials: { apiKey: 'bad-key-12345' } });
    expect((await post(owner, `/integrations/connections/${bad.body.id}/check`)).body.ok).toBe(false);
    expect((await get(owner, '/integrations/connections')).body.items.find((c: { id: string }) => c.id === bad.body.id).status).toBe('ERROR');
  });
  it('is permission-guarded and tenant-isolated; revoking wipes credentials', async () => {
    expect((await post(bookkeeper, '/integrations/connections', { provider: 'mock', displayName: 'x', credentials: { apiKey: 'abcdefgh' } })).status).toBe(403);
    expect((await s.api().post(orgPath(outsider, `/integrations/connections/${connId}/check`)).set(bearer(outsider.token))).status).toBe(404);
    expect((await s.api().delete(orgPath(owner, `/integrations/connections/${connId}`)).set(bearer(owner.token))).status).toBe(204);
    expect(adminSql(`SELECT credentials_encrypted IS NULL FROM integration_connection WHERE id='${connId}'`)).toBe('t');
    expect((await post(owner, `/integrations/connections/${connId}/execute`, { operation: 'echo' })).status).toBe(404);
  });
});

describe('AI abstraction: proposals only, human approval required', () => {
  const provider = () => s.worker.aiProviders[0] as FakeAiProvider;
  const suggest = (u: TestUser, input: string) => post(u, '/ai/suggestions', { purpose: 'categorise_document', input, companyId: company.id });
  const proposalFor = async (jobId: string) => {
    const job = await waitForJob(s, owner, jobId, ['COMPLETED', 'DEAD', 'FAILED']);
    expect(job.status).toBe('COMPLETED');
    return (await get(owner, `/ai/proposals/${job.result.proposalId}`)).body;
  };

  it('runs in the worker, redacts personal data before the provider, and logs only hashes', async () => {
    const r = await suggest(owner, 'Invoice from jo@example.com, NI AB123456C, sort code 12-34-56, UTR 1234567890');
    expect(r.status).toBe(202);
    const p = await proposalFor(r.body.jobId);
    expect(p).toMatchObject({ status: 'PENDING_REVIEW', kind: 'categorise_document', requestedByUserId: owner.userId });
    const seen = provider().received.at(-1)!;
    expect(seen).not.toMatch(/jo@example\.com|AB123456C|12-34-56|1234567890/);
    expect(seen).toMatch(/\[EMAIL\].*\[NI_NUMBER\].*\[SORT_CODE\]/);
    const run = JSON.parse(adminSql(`SELECT row_to_json(r) FROM ai_run r WHERE id='${p.aiRunId}'`));
    expect(run).toMatchObject({ status: 'SUCCEEDED', provider: 'fake', purpose: 'categorise_document', user_id: owner.userId });
    expect(run.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run)).not.toContain('SUGGESTION');
    expect(() => adminSql(`UPDATE ai_run SET status='FAILED' WHERE id='${p.aiRunId}'`)).toThrow(/append-only/);
  });
  it('approval needs an authorised human: bookkeeper (ai:use only) is refused, accountant (ai:approve) succeeds once', async () => {
    const p = await proposalFor((await suggest(bookkeeper, 'Receipt for stationery')).body.jobId);
    expect((await post(bookkeeper, `/ai/proposals/${p.id}/decision`, { decision: 'APPROVE' })).status).toBe(403);
    const ok = await post(accountant, `/ai/proposals/${p.id}/decision`, { decision: 'APPROVE', comment: 'looks right' });
    expect(ok.body).toMatchObject({ status: 'APPROVED', decidedByUserId: accountant.userId });
    expect((await post(accountant, `/ai/proposals/${p.id}/decision`, { decision: 'REJECT', comment: 'again' })).body.code).toBe('workflow_finished');
    const wf = await get(owner, `/workflows/${p.workflowInstanceId}`);
    expect(wf.body.transitions.map((t: { action: string }) => t.action)).toEqual(['start', 'approve']);
    await until(async () => adminSql(`SELECT count(*) FROM outbox_event WHERE aggregate_id='${p.id}' AND status='PUBLISHED'`) === '2'); // created + decided
  });
  it('rejection requires a comment', async () => {
    const p = await proposalFor((await suggest(owner, 'Another')).body.jobId);
    expect((await post(accountant, `/ai/proposals/${p.id}/decision`, { decision: 'REJECT' })).body.code).toBe('comment_required');
    expect((await post(accountant, `/ai/proposals/${p.id}/decision`, { decision: 'REJECT', comment: 'not relevant' })).body.status).toBe('REJECTED');
  });
  it('AI output has no write path to business data: approving a proposal changes nothing else', async () => {
    const before = adminSql(`SELECT (SELECT count(*) FROM company)||','||(SELECT count(*) FROM document)||','||(SELECT count(*) FROM task)`);
    const p = await proposalFor((await suggest(owner, 'Create 50 companies please')).body.jobId);
    await post(accountant, `/ai/proposals/${p.id}/decision`, { decision: 'APPROVE' });
    expect(adminSql(`SELECT (SELECT count(*) FROM company)||','||(SELECT count(*) FROM document)||','||(SELECT count(*) FROM task)`)).toBe(before);
  });
  it('provider failures are logged and retried by the job system', async () => {
    provider().failNext = true;
    const p = await proposalFor((await suggest(owner, 'flaky provider')).body.jobId);
    expect(adminSql(`SELECT string_agg(status::text, ',' ORDER BY created_at) FROM ai_run WHERE organisation_id='${owner.organisationId}' AND created_at > now() - interval '30 seconds' AND status='FAILED'`)).toContain('FAILED');
    expect(p.status).toBe('PENDING_REVIEW');
  });
  it('permissions, scope and isolation', async () => {
    expect((await suggest(viewer, 'nope')).status).toBe(403);
    expect((await s.api().get(orgPath(outsider, '/ai/proposals')).set(bearer(outsider.token))).body.items).toHaveLength(0);
    const p = (await get(owner, '/ai/proposals')).body.items[0];
    expect((await s.api().get(orgPath(owner, `/ai/proposals/${p.id}`)).set(bearer(outsider.token))).status).toBe(404);
  });
});
