import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/** Specification V0 §5: owner, reviewer, due date, priority, status, company, source, attachments, comments, reminders. */
let s: Stack;
let owner: TestUser, worker: TestUser, reviewer: TestUser, other: TestUser, outsider: TestUser;
let co: { id: string }, coB: { id: string };

const call = (u: TestUser, m: 'get' | 'post' | 'patch' | 'delete', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const mk = async (b: Record<string, unknown> = {}) => {
  const r = await call(owner, 'post', '/tasks', { title: 'Prepare VAT workings', companyId: co.id, assigneeUserId: worker.userId, reviewerUserId: reviewer.userId, ...b });
  if (r.status !== 201) throw new Error(`task create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; status: string };
};
const until = async <T>(fn: () => Promise<T | false | undefined>, ms = 15_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'BUSINESS' });
  co = await makeCompany(s, owner, 'Task Co Ltd');
  coB = await makeCompany(s, owner, 'Task Other Ltd');
  worker = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  other = await addMember(s, owner, 'accountant');
  outsider = await addMember(s, owner, 'client_viewer');
});
afterAll(() => s.stop());

describe('reviewer and the review flow', () => {
  it('a task with a reviewer cannot be completed directly, not even by the owner', async () => {
    const t = await mk();
    const r = await call(owner, 'patch', `/tasks/${t.id}`, { status: 'DONE' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('review_required');
  });

  it('assignee submits, designated reviewer approves => DONE with a recorded comment, audit and notifications', async () => {
    const t = await mk();
    expect((await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_PROGRESS' })).status).toBe(200);
    const sub = await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_REVIEW' });
    expect(sub.body.status).toBe('IN_REVIEW');
    await until(async () => (await call(reviewer, 'get', '/notifications')).body.items.find((n: { entityId: string; type: string }) => n.entityId === t.id && n.type === 'task.review_requested'));
    const done = await call(reviewer, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE', comment: 'Checked to the return' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'DONE', completedAt: expect.any(String) });
    const comments = (await call(reviewer, 'get', `/tasks/${t.id}/comments`)).body.items;
    expect(comments.map((c: { kind: string }) => c.kind)).toEqual(['REVIEW_APPROVED']);
    const audit = (await call(owner, 'get', '/audit-events?limit=100&action=task.review_approved')).body.items.find((e: { entityId: string }) => e.entityId === t.id);
    expect(audit).toMatchObject({ actorUserId: reviewer.userId, before: { status: 'IN_REVIEW' }, after: { status: 'DONE' }, reason: 'Checked to the return', companyId: co.id });
    await until(async () => (await call(worker, 'get', '/notifications')).body.items.find((n: { entityId: string; type: string }) => n.entityId === t.id && n.type === 'task.approved'));
  });

  it('returning needs a comment and sends the task back to IN_PROGRESS', async () => {
    const t = await mk();
    await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_REVIEW' });
    expect((await call(reviewer, 'post', `/tasks/${t.id}/review`, { decision: 'RETURN' })).status).toBe(422);
    const r = await call(reviewer, 'post', `/tasks/${t.id}/review`, { decision: 'RETURN', comment: 'Box 6 does not agree' });
    expect(r.body.status).toBe('IN_PROGRESS');
    expect((await call(reviewer, 'get', `/tasks/${t.id}/comments`)).body.items[0]).toMatchObject({ kind: 'REVIEW_RETURNED', body: 'Box 6 does not agree', authorUserId: reviewer.userId });
  });

  it('only the designated reviewer may review, and only while the task is IN_REVIEW', async () => {
    const t = await mk();
    expect((await call(reviewer, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' })).body.code).toBe('not_in_review');
    await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_REVIEW' });
    for (const u of [owner, other, worker]) {
      const r = await call(u, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' });
      expect(r.status, 'non-reviewer').toBe(403);
      expect(r.body.code).toBe('not_reviewer');
    }
    expect((await call(owner, 'get', `/tasks/${t.id}`)).body.status).toBe('IN_REVIEW');
  });

  it('the database enforces the same rule even if the API were bypassed', async () => {
    const t = await mk();
    expect(() => adminSql(`UPDATE task SET status='DONE' WHERE id='${t.id}'`)).toThrow(/submitted for review/);
    await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_REVIEW' });
    expect(() => adminSql(`UPDATE task SET status='DONE' WHERE id='${t.id}'`)).toThrow(/designated reviewer/); // no acting user
  });

  it('reviewer rules: not the assignee, must have access to the company, needed before review, locked during review', async () => {
    expect((await call(owner, 'post', '/tasks', { title: 'x', companyId: co.id, assigneeUserId: worker.userId, reviewerUserId: worker.userId })).status).toBe(422);
    expect((await call(owner, 'post', '/tasks', { title: 'x', companyId: co.id, reviewerUserId: outsider.userId })).body.code).toBe('invalid_reviewer'); // client_viewer cannot read tasks
    const noReviewer = await mk({ reviewerUserId: undefined });
    expect((await call(worker, 'patch', `/tasks/${noReviewer.id}`, { status: 'IN_REVIEW' })).body.code).toBe('reviewer_required');
    expect((await call(worker, 'patch', `/tasks/${noReviewer.id}`, { status: 'DONE' })).status).toBe(200); // backward compatible: no reviewer => direct completion
    const t = await mk();
    expect((await call(owner, 'patch', `/tasks/${t.id}`, { reviewerUserId: worker.userId })).body.code).toBe('reviewer_is_assignee');
    await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_REVIEW' });
    expect((await call(owner, 'patch', `/tasks/${t.id}`, { reviewerUserId: other.userId })).body.code).toBe('reviewer_locked');
  });
});

describe('source', () => {
  it('is stored and listed; a non-manual source must point at a record of the same company', async () => {
    const d = await uploadDoc(s, owner, { companyId: co.id });
    const ok = await call(owner, 'post', '/tasks', { title: 'Review upload', companyId: co.id, source: 'DOCUMENT', sourceId: d.documentId });
    expect(ok.body).toMatchObject({ source: 'DOCUMENT', sourceId: d.documentId });
    expect((await call(owner, 'get', '/tasks?source=DOCUMENT')).body.items.some((t: { id: string }) => t.id === ok.body.id)).toBe(true);
    expect((await call(owner, 'post', '/tasks', { title: 'x', companyId: coB.id, source: 'DOCUMENT', sourceId: d.documentId })).body.code).toBe('invalid_source');
    expect((await call(owner, 'post', '/tasks', { title: 'x', source: 'WORKFLOW' })).status).toBe(422);
    expect((await call(owner, 'post', '/tasks', { title: 'x', source: 'WORKFLOW', sourceId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('invalid_source');
    expect((await call(owner, 'post', '/tasks', { title: 'x', source: 'SYSTEM', sourceId: 'x' })).status).toBe(422); // reserved for the platform
    expect((await mk({ reviewerUserId: undefined })).status).toBe('OPEN');
  });
});

describe('comments', () => {
  it('assignee, reviewer and managers may comment; the thread is append-only and notifies the other participants', async () => {
    const t = await mk();
    const c = await call(worker, 'post', `/tasks/${t.id}/comments`, { body: 'Started on the workings' });
    expect(c.status).toBe(201);
    expect((await call(owner, 'post', `/tasks/${t.id}/comments`, { body: 'Thanks' })).status).toBe(201);
    expect((await call(reviewer, 'post', `/tasks/${t.id}/comments`, { body: 'Please attach the VAT return' })).status).toBe(201);
    expect((await call(reviewer, 'get', `/tasks/${t.id}/comments`)).body.items.map((x: { body: string }) => x.body)).toEqual(['Started on the workings', 'Thanks', 'Please attach the VAT return']);
    await until(async () => (await call(reviewer, 'get', '/notifications')).body.items.find((n: { entityId: string; type: string }) => n.entityId === t.id && n.type === 'task.commented'));
    expect(() => adminSql(`UPDATE task_comment SET body='edited' WHERE id='${c.body.id}'`)).toThrow(/append-only/);
    expect(() => adminSql(`DELETE FROM task_comment WHERE id='${c.body.id}'`)).toThrow(/append-only/);
    expect((await call(worker, 'post', `/tasks/${t.id}/comments`, { body: '   ' })).status).toBe(422);
  });

  it('someone who is neither a participant nor a manager of the company cannot comment', async () => {
    const t = await mk();
    expect((await call(other, 'post', `/tasks/${t.id}/comments`, { body: 'hi' })).status).toBe(201); // accountant: task:manage
    const bystander = await addMember(s, owner, 'reviewer'); // task:read only, not a participant
    const r = await call(bystander, 'post', `/tasks/${t.id}/comments`, { body: 'hi' });
    expect(r.status).toBe(403);
    expect((await call(bystander, 'get', `/tasks/${t.id}/comments`)).status).toBe(200);
  });
});

describe('attachments', () => {
  it('links documents of the same company, once, and the link follows document permissions', async () => {
    const t = await mk();
    const d = await uploadDoc(s, owner, { companyId: co.id, name: 'bank-statement.pdf' });
    await waitForVersion(s, owner, d.documentId, d.versionId);
    const a = await call(worker, 'post', `/tasks/${t.id}/attachments`, { documentId: d.documentId });
    expect(a.status).toBe(201);
    expect((await call(worker, 'post', `/tasks/${t.id}/attachments`, { documentId: d.documentId })).body.code).toBe('attachment_exists');
    const list = (await call(reviewer, 'get', `/tasks/${t.id}/attachments`)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ documentId: d.documentId, documentName: 'bank-statement.pdf' });
    expect((await call(worker, 'delete', `/tasks/${t.id}/attachments/${d.documentId}`)).status).toBe(204);
    expect((await call(worker, 'delete', `/tasks/${t.id}/attachments/${d.documentId}`)).status).toBe(404);
  });

  it('refuses a document of another company or an organisation-level document, and archived documents', async () => {
    const t = await mk();
    const other = await uploadDoc(s, owner, { companyId: coB.id });
    expect((await call(owner, 'post', `/tasks/${t.id}/attachments`, { documentId: other.documentId })).body.code).toBe('attachment_company_mismatch');
    const orgLevel = await uploadDoc(s, owner, {});
    expect((await call(owner, 'post', `/tasks/${t.id}/attachments`, { documentId: orgLevel.documentId })).status).toBe(422);
    const arch = await uploadDoc(s, owner, { companyId: co.id });
    await call(owner, 'post', `/documents/${arch.documentId}/archive`, { reason: 'duplicate' });
    expect((await call(owner, 'post', `/tasks/${t.id}/attachments`, { documentId: arch.documentId })).body.code).toBe('document_archived');
    expect(() => adminSql(`INSERT INTO task_attachment(organisation_id, task_id, document_id, added_by_user_id) VALUES ('${owner.organisationId}','${t.id}','${other.documentId}','${owner.userId}')`)).toThrow(/own company/);
  });

  it('a restricted member cannot link a document they cannot read', async () => {
    const restricted = await addMember(s, owner, 'bookkeeper', { scope: 'ASSIGNED', companyIds: [co.id] });
    const t = await mk();
    const d = await uploadDoc(s, owner, { companyId: coB.id });
    expect((await call(restricted, 'post', `/tasks/${t.id}/attachments`, { documentId: d.documentId })).status).toBe(404);
  });
});

describe('reminders', () => {
  it('a due reminder becomes one in-app notification (without task content) exactly once', async () => {
    const t = await mk();
    const at = new Date(Date.now() + 1500).toISOString();
    const r = await call(worker, 'post', `/tasks/${t.id}/reminders`, { remindAt: at });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ recipientUserId: worker.userId, sentAt: null });
    const note = await until(async () => (await call(worker, 'get', '/notifications')).body.items.find((n: { entityId: string; type: string }) => n.entityId === t.id && n.type === 'task.reminder'));
    expect(JSON.stringify(note)).not.toContain('VAT workings');
    await new Promise((res) => setTimeout(res, 1200)); // several more sweeps
    expect((await call(worker, 'get', '/notifications')).body.items.filter((n: { type: string; entityId: string }) => n.type === 'task.reminder' && n.entityId === t.id)).toHaveLength(1);
    expect((await call(worker, 'get', `/tasks/${t.id}/reminders`)).body.items[0].sentAt).toBeTruthy();
    expect((await call(owner, 'get', '/audit-events?limit=100&action=task.reminder_sent')).body.items.some((e: { entityId: string }) => e.entityId === t.id)).toBe(true);
  });

  it('a reminder for a task that finished meanwhile is cancelled instead of sent', async () => {
    const t = await mk({ reviewerUserId: undefined });
    await call(worker, 'post', `/tasks/${t.id}/reminders`, { remindAt: new Date(Date.now() + 1500).toISOString() });
    await call(worker, 'patch', `/tasks/${t.id}`, { status: 'DONE' });
    const rem = await until(async () => { const x = (await call(worker, 'get', `/tasks/${t.id}/reminders`)).body.items[0]; return x.cancelledAt ? x : false; });
    expect(rem.sentAt).toBeNull();
    expect((await call(worker, 'get', '/notifications')).body.items.some((n: { entityId: string; type: string }) => n.entityId === t.id && n.type === 'task.reminder')).toBe(false);
  });

  it('validation: future only, bounded, recipients need access, cancel only while pending', async () => {
    const t = await mk();
    expect((await call(worker, 'post', `/tasks/${t.id}/reminders`, { remindAt: new Date(Date.now() - 1000).toISOString() })).body.code).toBe('reminder_in_past');
    expect((await call(worker, 'post', `/tasks/${t.id}/reminders`, { remindAt: new Date(Date.now() + 3 * 365 * 864e5).toISOString() })).body.code).toBe('reminder_too_far');
    expect((await call(worker, 'post', `/tasks/${t.id}/reminders`, { remindAt: new Date(Date.now() + 864e5).toISOString(), recipientUserId: outsider.userId })).body.code).toBe('invalid_recipient');
    const ok = await call(worker, 'post', `/tasks/${t.id}/reminders`, { remindAt: new Date(Date.now() + 864e5).toISOString(), recipientUserId: reviewer.userId });
    expect(ok.status).toBe(201);
    expect((await call(worker, 'delete', `/tasks/${t.id}/reminders/${ok.body.id}`)).status).toBe(204);
    expect((await call(worker, 'delete', `/tasks/${t.id}/reminders/${ok.body.id}`)).status).toBe(404);
    expect(() => adminSql(`UPDATE task_reminder SET remind_at = now() WHERE id='${ok.body.id}'`)).toThrow(/retargeted/);
  });
});

describe('filters', () => {
  it('filters by reviewer, company, priority, due date and overdue', async () => {
    const t1 = await mk({ title: 'Overdue one', priority: 'HIGH', dueDate: '2020-01-01' });
    const t2 = await mk({ title: 'Later one', companyId: coB.id, dueDate: '2099-01-01', priority: 'LOW' });
    const ids = async (qs: string) => ((await call(owner, 'get', `/tasks?limit=100&${qs}`)).body.items as { id: string }[]).map((x) => x.id);
    expect(await ids('overdue=true')).toContain(t1.id);
    expect(await ids('overdue=true')).not.toContain(t2.id);
    expect(await ids(`companyId=${coB.id}`)).toContain(t2.id);
    expect(await ids(`companyId=${coB.id}`)).not.toContain(t1.id);
    expect(await ids('priority=HIGH')).toContain(t1.id);
    expect(await ids('dueBefore=2030-01-01')).toContain(t1.id);
    expect(await ids('dueBefore=2030-01-01')).not.toContain(t2.id);
    const mine = ((await call(reviewer, 'get', '/tasks?reviewer=me&limit=100')).body.items as { reviewerUserId: string }[]);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.reviewerUserId === reviewer.userId)).toBe(true);
  });
});

describe('isolation', () => {
  it('another organisation sees nothing; a member limited to other companies gets 404 for the task and all of its sub-resources', async () => {
    const t = await mk();
    const stranger = await createUser(s, { type: 'BUSINESS' });
    expect((await s.api().get(orgPath(owner, `/tasks/${t.id}/comments`)).set(bearer(stranger.token))).status).toBe(404); // not a member: the organisation's existence is not revealed
    const restricted = await addMember(s, owner, 'bookkeeper', { scope: 'ASSIGNED', companyIds: [coB.id] });
    for (const p of ['', '/comments', '/attachments', '/reminders']) expect((await call(restricted, 'get', `/tasks/${t.id}${p}`)).status, p).toBe(404);
    expect((await call(restricted, 'post', `/tasks/${t.id}/comments`, { body: 'x' })).status).toBe(404);
    expect((await call(restricted, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' })).status).toBe(404);
    expect((await call(restricted, 'post', `/tasks/${t.id}/reminders`, { remindAt: new Date(Date.now() + 864e5).toISOString() })).status).toBe(404);
  });
});
