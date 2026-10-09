import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { adminSql } from '../helpers/db';

/** Task-engine schema guarantees, checked directly against the database (the API is bypassed on purpose). */
let db: Database;
let org: string, org2: string, u1: string, u2: string, company: string, task: string;
const q = (sql: string) => adminSql(sql);

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Task DB A'),('${org2}','BUSINESS','Task DB B')`);
  u1 = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('td1-${org}@t.test','U1') RETURNING id`).split('\n')[0]!;
  u2 = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('td2-${org}@t.test','U2') RETURNING id`).split('\n')[0]!;
  company = adminSql(`INSERT INTO company(organisation_id, name) VALUES ('${org}','TD Co') RETURNING id`).split('\n')[0]!;
  task = adminSql(`INSERT INTO task(organisation_id, company_id, title, created_by_user_id) VALUES ('${org}','${company}','t','${u1}') RETURNING id`).split('\n')[0]!;
});
afterAll(() => db.close());

describe('task schema', () => {
  it('existing-style tasks keep working: source defaults to MANUAL, no reviewer', () => {
    expect(q(`SELECT source||'|'||coalesce(reviewer_user_id::text,'-') FROM task WHERE id='${task}'`)).toBe('MANUAL|-');
  });
  it('rejects unknown sources, a reviewer equal to the assignee, and IN_REVIEW without a reviewer', () => {
    expect(() => q(`UPDATE task SET source='MAGIC' WHERE id='${task}'`)).toThrow(/task_source_ck/);
    expect(() => q(`UPDATE task SET assignee_user_id='${u1}', reviewer_user_id='${u1}' WHERE id='${task}'`)).toThrow(/task_reviewer_not_assignee_ck/);
    expect(() => q(`UPDATE task SET status='IN_REVIEW' WHERE id='${task}'`)).toThrow(/task_in_review_needs_reviewer_ck/);
  });
  it('a task\'s company must belong to the same organisation (composite FK)', () => {
    expect(() => q(`INSERT INTO task(organisation_id, company_id, title, created_by_user_id) VALUES ('${org2}','${company}','x','${u1}')`)).toThrow(/task_organisation_id_company_id_fkey/);
  });
  it('sub-resources cannot reference a task of another organisation (composite FKs) and are protected by forced RLS', async () => {
    expect(() => q(`INSERT INTO task_comment(organisation_id, task_id, author_user_id, body) VALUES ('${org2}','${task}','${u1}','x')`)).toThrow(/foreign key/);
    expect(() => q(`INSERT INTO task_reminder(organisation_id, task_id, recipient_user_id, remind_at, created_by_user_id) VALUES ('${org2}','${task}','${u1}', now(),'${u1}')`)).toThrow(/foreign key/);
    q(`INSERT INTO task_comment(organisation_id, task_id, author_user_id, body) VALUES ('${org}','${task}','${u1}','visible only to its tenant')`);
    expect(await db.tenant({ organisationId: org2 }, (tx) => tx.taskComment.count())).toBe(0);
    expect(await db.tenant({ organisationId: org }, (tx) => tx.taskComment.count({ where: { taskId: task } }))).toBe(1);
    expect(q(`SELECT relforcerowsecurity FROM pg_class WHERE relname IN ('task_attachment','task_comment','task_reminder') GROUP BY 1`)).toBe('t');
  });
  it('the runtime role cannot edit or delete comments (grants), even before the trigger is consulted', async () => {
    await expect(db.tenant({ organisationId: org }, (tx) => tx.taskComment.updateMany({ where: { taskId: task }, data: { body: 'x' } }))).rejects.toThrow(/permission denied/);
    await expect(db.tenant({ organisationId: org }, (tx) => tx.taskComment.deleteMany({ where: { taskId: task } }))).rejects.toThrow(/permission denied/);
  });
  it('review completion is bound to the acting user from the tenant context', async () => {
    const t = q(`INSERT INTO task(organisation_id, company_id, title, status, assignee_user_id, reviewer_user_id, created_by_user_id) VALUES ('${org}','${company}','rv','IN_REVIEW','${u1}','${u2}','${u1}') RETURNING id`).split('\n')[0]!;
    await expect(db.tenant({ organisationId: org, userId: u1 }, (tx) => tx.task.update({ where: { id: t }, data: { status: 'DONE' } }))).rejects.toThrow(/designated reviewer/);
    const done = await db.tenant({ organisationId: org, userId: u2 }, (tx) => tx.task.update({ where: { id: t }, data: { status: 'DONE' } }));
    expect(done.status).toBe('DONE');
  });
});
