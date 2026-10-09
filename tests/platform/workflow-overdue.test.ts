import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { MAX_OVERDUE_ATTEMPTS, NotificationService, WorkflowEngine, WorkflowOverdueSweeper, WorkflowRegistry } from '@uk/platform';
import { adminSql } from '../helpers/db';

/** The overdue sweeper in isolation (no worker running): exactly-once notification, crash safety, failure accounting, re-arming, SLA. */
let db: Database;
let orgA: string, orgB: string, userA: string, userB: string, assignee: string;
const log = createLogger('silent');
const sweeper = (batchSize = 100, notifications: NotificationService = new NotificationService()) => new WorkflowOverdueSweeper(db, notifications, log, { batchSize });

const mkInstance = (org: string, starter: string, o: { due?: string | null; assignee?: string; completed?: boolean } = {}) =>
  adminSql(`INSERT INTO workflow_instance(organisation_id, type, definition_version, state, subject_type, subject_id, started_by_user_id, assignee_user_id, due_at, completed_at)
            VALUES ('${org}','generic_approval',1,'DRAFT','test','${uuidv7()}','${starter}',${o.assignee ? `'${o.assignee}'` : 'NULL'},
                    ${o.due === null ? 'NULL' : `now() - interval '${o.due ?? '1 minute'}'`}, ${o.completed ? 'now()' : 'NULL'}) RETURNING id`).split('\n')[0]!;
const notified = (id: string) => adminSql(`SELECT overdue_notified_at IS NOT NULL FROM workflow_instance WHERE id='${id}'`) === 't';
const notes = (org: string, id: string) => Number(adminSql(`SELECT count(*) FROM notification WHERE organisation_id='${org}' AND entity_id='${id}' AND type='workflow.overdue'`));
const row = (id: string) => adminSql(`SELECT overdue_attempts||'|'||coalesce(overdue_last_error,'')||'|'||(overdue_retry_at IS NOT NULL) FROM workflow_instance WHERE id='${id}'`);

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  orgA = uuidv7(); orgB = uuidv7();
  const u = (n: string, o: string) => adminSql(`INSERT INTO "user"(email, display_name) VALUES ('wo-${n}-${o}@t.test','${n}') RETURNING id`).split('\n')[0]!;
  userA = u('a', orgA); userB = u('b', orgB); assignee = u('assignee', orgA);
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${orgA}','BUSINESS','Overdue A'),('${orgB}','BUSINESS','Overdue B')`);
  adminSql(`UPDATE workflow_instance SET overdue_notified_at = now() WHERE due_at IS NOT NULL AND overdue_notified_at IS NULL`); // isolate from other files
});
afterAll(() => db.close());

describe('WorkflowOverdueSweeper', () => {
  it('notifies the assignee (else the starter) once per overdue open instance, in its own tenant, and ignores everything else', async () => {
    const withAssignee = mkInstance(orgA, userA, { assignee }), noAssignee = mkInstance(orgB, userB);
    const future = adminSql(`INSERT INTO workflow_instance(organisation_id, type, definition_version, state, subject_type, subject_id, started_by_user_id, due_at)
      VALUES ('${orgA}','generic_approval',1,'DRAFT','t','${uuidv7()}','${userA}', now() + interval '1 day') RETURNING id`).split('\n')[0]!;
    const noDue = mkInstance(orgA, userA, { due: null }), finished = mkInstance(orgA, userA, { completed: true });
    const r = await sweeper().sweepOnce();
    expect(r.notified).toBe(2);
    expect(adminSql(`SELECT user_id FROM notification WHERE entity_id='${withAssignee}' AND type='workflow.overdue'`)).toBe(assignee);
    expect(adminSql(`SELECT user_id FROM notification WHERE entity_id='${noAssignee}' AND type='workflow.overdue'`)).toBe(userB);
    expect(adminSql(`SELECT organisation_id FROM notification WHERE entity_id='${noAssignee}'`)).toBe(orgB);
    expect([future, noDue, finished].map((id) => notified(id))).toEqual([false, false, false]);
    expect(notes(orgA, future) + notes(orgA, noDue) + notes(orgA, finished)).toBe(0);
    // the notification carries no workflow content (no type, subject, ids other than the entity link)
    expect(adminSql(`SELECT title||'|'||body FROM notification WHERE entity_id='${withAssignee}'`)).not.toMatch(/generic_approval|test/);
    // audited, with the workflow as the source
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action='workflow.overdue_notified' AND entity_id='${withAssignee}' AND source_workflow_id='${withAssignee}'`)).toBe('1');
  });

  it('is one-time: sweeping again does not notify again', async () => {
    const id = mkInstance(orgA, userA);
    await sweeper().sweepOnce();
    await sweeper().sweepOnce();
    expect(notes(orgA, id)).toBe(1);
  });

  it('many sweepers at once notify each instance exactly once', async () => {
    const ids = Array.from({ length: 25 }, () => mkInstance(orgA, userA));
    await Promise.all(Array.from({ length: 6 }, () => sweeper(10).sweepOnce()));
    for (let i = 0; i < 3; i++) await Promise.all(Array.from({ length: 4 }, () => sweeper(10).sweepOnce()));
    expect(ids.every(notified)).toBe(true);
    expect(ids.map((id) => notes(orgA, id))).toEqual(ids.map(() => 1));
  });

  it('a crash after the notification was written but before commit rolls both back; the next sweep delivers once', async () => {
    const id = mkInstance(orgA, userA);
    const crashing = { notify: async (tx: Parameters<NotificationService['notify']>[0], n: Parameters<NotificationService['notify']>[1]) => { await new NotificationService().notify(tx, n); throw new Error('worker crashed'); } } as never;
    const r1 = await sweeper(100, crashing).sweepOnce();
    expect(r1.failed).toBeGreaterThanOrEqual(1);
    expect(notes(orgA, id)).toBe(0);              // the notification rolled back with the marker
    expect(notified(id)).toBe(false);
    expect(row(id)).toMatch(/^1\|worker crashed\|true$/); // counted and backed off
    adminSql(`UPDATE workflow_instance SET overdue_retry_at = now() - interval '1 second' WHERE id='${id}'`);
    await sweeper().sweepOnce();
    expect(notes(orgA, id)).toBe(1);
    expect(notified(id)).toBe(true);
    expect(adminSql(`SELECT overdue_last_error IS NULL FROM workflow_instance WHERE id='${id}'`)).toBe('t');
  });

  it('a poisoned instance backs off, is abandoned (audited) after the attempt limit, and never blocks newer ones', async () => {
    const bad = mkInstance(orgB, userB, { due: '2 hours' });
    const poison = { notify: async (_tx: unknown, n: { entityId?: string }) => { if (n.entityId === bad) throw new Error('boom'); } } as never;
    for (let i = 1; i <= MAX_OVERDUE_ATTEMPTS; i++) {
      adminSql(`UPDATE workflow_instance SET overdue_retry_at = now() - interval '3 hours' WHERE id='${bad}'`);
      const good = mkInstance(orgB, userB);
      const r = await sweeper(1, poison).sweepOnce(); // batch of one: the oldest (poisoned) first
      expect(r.failed + r.abandoned).toBe(1);
      expect(row(bad).startsWith(`${i}|boom`)).toBe(true);
      await sweeper(100, poison).sweepOnce();           // the newer ones are still delivered
      expect(notified(good)).toBe(true);
    }
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action='workflow.overdue_notification_failed' AND entity_id='${bad}'`)).toBe('1');
    const again = await sweeper().sweepOnce();
    expect(again.notified).toBe(0);                      // abandoned: not retried
    expect(notified(bad)).toBe(false);
    expect(notes(orgB, bad)).toBe(0);
  });

  it('finishing the workflow before the sweep prevents the notification', async () => {
    const id = mkInstance(orgA, userA);
    adminSql(`UPDATE workflow_instance SET completed_at = now() WHERE id='${id}'`);
    await sweeper().sweepOnce();
    expect(notes(orgA, id)).toBe(0);
  });

  it('moving the due date through the engine re-arms the notification', async () => {
    const engine = new WorkflowEngine(new WorkflowRegistry());
    const id = mkInstance(orgA, userA);
    await sweeper().sweepOnce();
    expect(notes(orgA, id)).toBe(1);
    const actor = { userId: userA, permissions: new Set(['workflow:manage']) };
    const future = new Date(Date.now() + 3_600_000);
    const moved = await db.tenant({ organisationId: orgA, userId: userA }, (tx) => engine.setDueDate(tx, { organisationId: orgA, instanceId: id, dueAt: future, actor }));
    expect(moved.dueAt?.getTime()).toBe(future.getTime());
    expect(moved.overdueNotifiedAt).toBeNull();
    await sweeper().sweepOnce();
    expect(notes(orgA, id)).toBe(1);                 // not due yet
    adminSql(`UPDATE workflow_instance SET due_at = now() - interval '1 second' WHERE id='${id}'`);
    await sweeper().sweepOnce();
    expect(notes(orgA, id)).toBe(2);                 // re-armed and notified once more
  });

  it('the database enforces the failure counter is never negative', () => {
    const id = mkInstance(orgA, userA);
    expect(() => adminSql(`UPDATE workflow_instance SET overdue_attempts = -1 WHERE id='${id}'`)).toThrow(/overdue_attempts_ck/);
  });
});

describe('deadline defaults and rules (engine)', () => {
  const actor = (permissions: string[]) => ({ userId: userA, permissions: new Set(permissions) });
  const reg = () => new WorkflowRegistry([{ type: 'sla_flow', version: 1, initialState: 'OPEN', terminalStates: ['DONE'], slaHours: 48, transitions: [{ action: 'finish', from: ['OPEN'], to: 'DONE', permission: 'workflow:manage' }] }]);

  it('a definition with an SLA gives new instances a deadline; an explicit deadline wins; no SLA means no deadline', async () => {
    const engine = new WorkflowEngine(reg());
    const before = Date.now();
    const a = await db.tenant({ organisationId: orgA, userId: userA }, (tx) => engine.start(tx, { type: 'sla_flow', organisationId: orgA, subjectType: 's', subjectId: '1', actorUserId: userA }));
    expect(a.dueAt!.getTime()).toBeGreaterThanOrEqual(before + 48 * 3_600_000 - 1000);
    expect(a.dueAt!.getTime()).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000 + 1000);
    const explicit = new Date(Date.now() + 5 * 3_600_000);
    const b = await db.tenant({ organisationId: orgA, userId: userA }, (tx) => engine.start(tx, { type: 'sla_flow', organisationId: orgA, subjectType: 's', subjectId: '2', actorUserId: userA, dueAt: explicit }));
    expect(b.dueAt!.getTime()).toBe(explicit.getTime());
    const plain = new WorkflowEngine(new WorkflowRegistry());
    const c = await db.tenant({ organisationId: orgA, userId: userA }, (tx) => plain.start(tx, { type: 'generic_approval', organisationId: orgA, subjectType: 's', subjectId: '3', actorUserId: userA }));
    expect(c.dueAt).toBeNull();
  });

  it('changing the deadline needs workflow:manage, respects optimistic concurrency, is recorded, and is refused once finished', async () => {
    const engine = new WorkflowEngine(reg());
    const inst = await db.tenant({ organisationId: orgA, userId: userA }, (tx) => engine.start(tx, { type: 'sla_flow', organisationId: orgA, subjectType: 's', subjectId: '4', actorUserId: userA }));
    const set = (a: ReturnType<typeof actor>, dueAt: Date | null, extra: { expectedVersion?: number; comment?: string } = {}) =>
      db.tenant({ organisationId: orgA, userId: userA }, (tx) => engine.setDueDate(tx, { organisationId: orgA, instanceId: inst.id, dueAt, actor: a, ...extra }));
    await expect(set(actor(['workflow:read']), new Date())).rejects.toMatchObject({ status: 403 });
    await expect(set(actor(['workflow:manage']), new Date(), { expectedVersion: 99 })).rejects.toMatchObject({ code: 'version_conflict' });
    const moved = await set(actor(['workflow:manage']), new Date(Date.now() + 1000), { comment: 'client asked for more time', expectedVersion: inst.version });
    expect(moved.version).toBe(inst.version + 1);
    const cleared = await set(actor(['workflow:manage']), null);
    expect(cleared.dueAt).toBeNull();
    const hist = adminSql(`SELECT string_agg(action||':'||coalesce(comment,''), ' / ' ORDER BY occurred_at) FROM workflow_transition WHERE instance_id='${inst.id}'`);
    expect(hist).toContain('set_due_date:client asked for more time');
    expect(hist).toContain('Due date cleared');
    const audit = adminSql(`SELECT count(*) FROM audit_event WHERE action='workflow.due_date_changed' AND entity_id='${inst.id}' AND before IS NOT NULL AND after IS NOT NULL`);
    expect(audit).toBe('2');
    await db.tenant({ organisationId: orgA, userId: userA }, (tx) => engine.transition(tx, { organisationId: orgA, instanceId: inst.id, action: 'finish', actor: actor(['workflow:manage']) }));
    await expect(set(actor(['workflow:manage']), new Date())).rejects.toMatchObject({ code: 'workflow_finished' });
  });
});
