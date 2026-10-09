import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, roleId, startStack, type Stack, type TestUser } from '../helpers/stack';

/**
 * Reviewer enforcement under attack: identity can only come from the authenticated session, the rule holds on every path to the
 * database (API, other tenant context, system context, no context), and the review cannot be weakened by the person being reviewed.
 */
let s: Stack;
let owner: TestUser, worker: TestUser, reviewer: TestUser, mgr: TestUser, mallory: TestUser;
let co: { id: string };
let db: Database;

const call = (u: TestUser, m: 'get' | 'post' | 'patch' | 'delete' | 'put', p: string, b?: object, h: Record<string, string> = {}) =>
  s.api()[m](orgPath(owner, p)).set(bearer(u.token)).set(h).send(b);
const mk = async (b: Record<string, unknown> = {}) => {
  const r = await call(owner, 'post', '/tasks', { title: 'Sign-off', companyId: co.id, assigneeUserId: worker.userId, reviewerUserId: reviewer.userId, ...b });
  if (r.status !== 201) throw new Error(`task create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
};
const inReview = async () => { const t = await mk(); expect((await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_REVIEW' })).status).toBe(200); return t; };
const status = (id: string) => adminSql(`SELECT status::text FROM task WHERE id='${id}'`);
const memberId = async (u: TestUser) => ((await call(owner, 'get', '/members')).body.items as { id: string; user: { id: string } }[]).find((m) => m.user.id === u.userId)!.id;

beforeAll(async () => {
  s = await startStack();
  db = new Database(process.env.DATABASE_URL!);
  owner = await createUser(s, { type: 'BUSINESS' });
  co = await makeCompany(s, owner, 'Review Security Ltd');
  worker = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  mgr = await addMember(s, owner, 'accountant');
  mallory = await addMember(s, owner, 'accountant'); // a capable colleague who is NOT the reviewer
});
afterAll(async () => { await db.close(); await s.stop(); });

describe('identity cannot be supplied by the caller', () => {
  it('the review decision takes the reviewer from the session only: body fields naming a reviewer are rejected', async () => {
    const t = await inReview();
    for (const extra of [{ reviewerUserId: reviewer.userId }, { userId: reviewer.userId }, { actorUserId: reviewer.userId }, { reviewer: reviewer.userId }]) {
      const r = await call(mallory, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE', ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(422);
    }
    expect(status(t.id)).toBe('IN_REVIEW');
  });
  it('identity-looking headers are ignored', async () => {
    const t = await inReview();
    const headers = { 'X-User-Id': reviewer.userId, 'X-Reviewer-Id': reviewer.userId, 'X-Forwarded-User': reviewer.userId, 'X-Actor': reviewer.userId, 'X-Impersonate': reviewer.userId, 'X-Auth-User': reviewer.email };
    const r = await call(mallory, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' }, headers);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('not_reviewer');
    expect(status(t.id)).toBe('IN_REVIEW');
  });
  it('mass assignment: status/completedAt/reviewer cannot be forged through other endpoints', async () => {
    const t = await inReview();
    expect((await call(mgr, 'patch', `/tasks/${t.id}`, { completedAt: new Date().toISOString() })).status).toBe(422);
    expect((await call(mgr, 'patch', `/tasks/${t.id}`, { status: 'DONE' })).body.code).toBe('review_required');
    expect((await call(mgr, 'post', `/tasks/${t.id}/comments`, { body: 'x', kind: 'REVIEW_APPROVED' })).status).toBe(422); // a comment cannot pose as an approval
    const c = await call(mgr, 'post', `/tasks/${t.id}/comments`, { body: 'looks fine to me' });
    expect(c.body.kind).toBe('COMMENT');
    expect(status(t.id)).toBe('IN_REVIEW');
  });
  it('another organisation\'s session (even the same person\'s) cannot act on this organisation\'s task', async () => {
    const t = await inReview();
    const stranger = await createUser(s, { type: 'BUSINESS' });
    expect((await s.api().post(orgPath(owner, `/tasks/${t.id}/review`)).set(bearer(stranger.token)).send({ decision: 'APPROVE' })).status).toBe(404);
    expect((await s.api().post(`/api/v1/organisations/${stranger.organisationId}/tasks/${t.id}/review`).set(bearer(stranger.token)).send({ decision: 'APPROVE' })).status).toBe(404);
    expect(status(t.id)).toBe('IN_REVIEW');
  });
});

describe('the person being reviewed cannot weaken the review', () => {
  it('the assignee can neither self-approve, nor take over, nor remove the reviewer, nor complete directly', async () => {
    const t = await inReview();
    expect((await call(worker, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' })).body.code).toBe('not_reviewer');
    expect((await call(worker, 'patch', `/tasks/${t.id}`, { status: 'DONE' })).body.code).toBe('review_required');
    expect((await call(worker, 'patch', `/tasks/${t.id}`, { reviewerUserId: null })).body.code).toBe('reviewer_locked');
    // before submission the assignee still cannot clear or swap the reviewer (otherwise: clear, then complete)
    const fresh = await mk();
    const r = await call(worker, 'patch', `/tasks/${fresh.id}`, { reviewerUserId: null });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('assignee_cannot_change_reviewer');
    expect((await call(worker, 'patch', `/tasks/${fresh.id}`, { reviewerUserId: mgr.userId })).body.code).toBe('assignee_cannot_change_reviewer');
    expect((await call(worker, 'patch', `/tasks/${fresh.id}`, { status: 'DONE' })).body.code).toBe('review_required');
    // the same rule holds in the database, whoever calls it
    expect(() => adminSql(`UPDATE task SET reviewer_user_id = NULL WHERE id='${fresh.id}'`)).not.toThrow(); // no acting user (trusted admin/migration path)
    await expect(db.tenant({ organisationId: owner.organisationId, userId: worker.userId }, (tx) => tx.task.update({ where: { id: t.id }, data: { reviewerUserId: null } }))).rejects.toThrow(/reviewer cannot be changed/);
  });
  it('a manager who is not the assignee may change the reviewer outside review, and it is audited with before/after', async () => {
    const t = await mk();
    expect((await call(mgr, 'patch', `/tasks/${t.id}`, { reviewerUserId: mallory.userId })).status).toBe(200);
    const a = (await call(owner, 'get', '/audit-events?limit=100&action=task.updated')).body.items.find((e: { entityId: string; after: { reviewerUserId?: string } }) => e.entityId === t.id && e.after?.reviewerUserId === mallory.userId);
    expect(a).toMatchObject({ actorUserId: mgr.userId, before: { reviewerUserId: reviewer.userId } });
  });
  it('only people trusted to review can be named reviewer', async () => {
    const r = await call(owner, 'post', '/tasks', { title: 'x', companyId: co.id, reviewerUserId: worker.userId });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('invalid_reviewer');
  });
});

describe('the reviewer\'s authority is re-checked at decision time', () => {
  it('a reviewer whose review permission was withdrawn for the company can no longer decide', async () => {
    const t = await inReview();
    const demoted = await addMember(s, owner, 'reviewer');
    const t2 = await mk({ reviewerUserId: demoted.userId });
    await call(worker, 'patch', `/tasks/${t2.id}`, { status: 'IN_REVIEW' });
    expect((await call(owner, 'put', `/companies/${co.id}/access/${await memberId(demoted)}`, { roleId: await roleId(s, owner, 'bookkeeper') })).status).toBe(200);
    const r = await call(demoted, 'post', `/tasks/${t2.id}/review`, { decision: 'APPROVE' });
    expect(r.status).toBe(403);
    expect(status(t2.id)).toBe('IN_REVIEW');
    expect(status(t.id)).toBe('IN_REVIEW');
  });
  it('a reviewer who left the organisation cannot decide; the owner can return the task and nominate someone else (no dead end)', async () => {
    const leaver = await addMember(s, owner, 'reviewer');
    const t = await mk({ reviewerUserId: leaver.userId });
    await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_REVIEW' });
    expect((await call(owner, 'delete', `/members/${await memberId(leaver)}?reason=left`)).status).toBe(204);
    expect([401, 403, 404]).toContain((await call(leaver, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' })).status);
    expect(status(t.id)).toBe('IN_REVIEW');
    expect((await call(owner, 'patch', `/tasks/${t.id}`, { reviewerUserId: reviewer.userId })).body.code).toBe('reviewer_locked');
    expect((await call(owner, 'patch', `/tasks/${t.id}`, { status: 'IN_PROGRESS' })).status).toBe(200);
    expect((await call(owner, 'patch', `/tasks/${t.id}`, { reviewerUserId: reviewer.userId })).status).toBe(200);
    expect((await call(worker, 'patch', `/tasks/${t.id}`, { status: 'IN_REVIEW' })).status).toBe(200);
    expect((await call(reviewer, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' })).status).toBe(200);
  });
});

describe('simultaneous decisions', () => {
  it('approve and return at the same time: exactly one wins, the record is consistent', async () => {
    for (let i = 0; i < 4; i++) {
      const t = await inReview();
      const [a, b] = await Promise.all([
        call(reviewer, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' }),
        call(reviewer, 'post', `/tasks/${t.id}/review`, { decision: 'RETURN', comment: 'not yet' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const winner = a.status === 200 ? 'APPROVE' : 'RETURN';
      expect(status(t.id)).toBe(winner === 'APPROVE' ? 'DONE' : 'IN_PROGRESS');
      expect(adminSql(`SELECT count(*) FROM task_comment WHERE task_id='${t.id}' AND kind <> 'COMMENT'`)).toBe('1');
      expect(adminSql(`SELECT count(*) FROM audit_event WHERE entity_id='${t.id}' AND action IN ('task.review_approved','task.review_returned')`)).toBe('1');
    }
  });
  it('two approvals at once complete the task once', async () => {
    const t = await inReview();
    const rs = await Promise.all([1, 2, 3].map(() => call(reviewer, 'post', `/tasks/${t.id}/review`, { decision: 'APPROVE' })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(adminSql(`SELECT count(*) FROM task_comment WHERE task_id='${t.id}' AND kind='REVIEW_APPROVED'`)).toBe('1');
  });
});

describe('every database path enforces the rule', () => {
  it('other tenant contexts, the system context, user-only and context-free connections cannot complete a reviewed task', async () => {
    const t = await inReview();
    const other = (await createUser(s, { type: 'BUSINESS' })).organisationId;
    const complete = (tx: { task: { updateMany: (a: object) => Promise<{ count: number }> } }) => tx.task.updateMany({ where: { id: t.id }, data: { status: 'DONE' } });
    // reviewer's identity inside ANOTHER organisation's context: row security hides the task
    expect((await db.tenant({ organisationId: other, userId: reviewer.userId }, complete)).count).toBe(0);
    // the trusted system context cannot even see task rows (no system branch in the task policy), and it has no acting user anyway
    expect((await db.system(complete)).count).toBe(0);
    // right organisation, wrong or missing user
    await expect(db.tenant({ organisationId: owner.organisationId, userId: mallory.userId }, complete)).rejects.toThrow(/designated reviewer/);
    await expect(db.tenant({ organisationId: owner.organisationId }, complete)).rejects.toThrow(/designated reviewer/);
    // user-only context sees no tenant rows at all
    expect((await db.asUser(reviewer.userId, complete)).count).toBe(0);
    // no context at all
    expect((await complete(db.prisma as never)).count).toBe(0);
    expect(status(t.id)).toBe('IN_REVIEW');
    // and the genuine path still works
    expect((await db.tenant({ organisationId: owner.organisationId, userId: reviewer.userId }, complete)).count).toBe(1);
  });
  it('skipping the review step is impossible at the database, for any user', async () => {
    const t = await mk();
    for (const userId of [reviewer.userId, owner.userId, worker.userId]) {
      await expect(db.tenant({ organisationId: owner.organisationId, userId }, (tx) => tx.task.update({ where: { id: t.id }, data: { status: 'DONE' } }))).rejects.toThrow(/submitted for review/);
    }
  });
});
