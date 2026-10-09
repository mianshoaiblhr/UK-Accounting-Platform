import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { MAX_REMINDER_ATTEMPTS, NotificationService, TaskReminderSweeper } from '@uk/platform';
import { adminSql } from '../helpers/db';

/** The reminder sweeper in isolation (no worker running): exactly-once delivery across concurrent sweepers, per-tenant handling. */
let db: Database;
let orgA: string, orgB: string, userA: string, userB: string;
const log = createLogger('silent');
const sweeper = (batchSize = 100) => new TaskReminderSweeper(db, new NotificationService(), log, { batchSize });

const mkTask = (org: string, user: string, status = 'OPEN') => adminSql(`INSERT INTO task(organisation_id, title, status, created_by_user_id) VALUES ('${org}','Sweep me','${status}','${user}') RETURNING id`).split('\n')[0]!;
/** Inserts a reminder due in the past (the trigger only forbids changing remind_at later, not inserting one). */
const mkReminder = (org: string, task: string, user: string, offsetSql = "now() - interval '1 minute'") =>
  adminSql(`INSERT INTO task_reminder(organisation_id, task_id, recipient_user_id, remind_at, created_by_user_id) VALUES ('${org}','${task}','${user}',${offsetSql},'${user}') RETURNING id`).split('\n')[0]!;
const state = (id: string) => adminSql(`SELECT (sent_at IS NOT NULL)||'|'||(cancelled_at IS NOT NULL) FROM task_reminder WHERE id='${id}'`);
const notes = (org: string, task: string) => Number(adminSql(`SELECT count(*) FROM notification WHERE organisation_id='${org}' AND entity_id='${task}' AND type='task.reminder'`));

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  orgA = uuidv7(); orgB = uuidv7();
  userA = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('tr-a-${orgA}@t.test','A') RETURNING id`).split('\n')[0]!;
  userB = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('tr-b-${orgB}@t.test','B') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${orgA}','BUSINESS','Reminder A'),('${orgB}','BUSINESS','Reminder B')`);
  adminSql(`UPDATE task_reminder SET cancelled_at = now() WHERE sent_at IS NULL AND cancelled_at IS NULL`); // isolate from other files
});
afterAll(() => db.close());

describe('TaskReminderSweeper', () => {
  it('delivers due reminders in every tenant, and leaves future ones alone', async () => {
    const ta = mkTask(orgA, userA), tb = mkTask(orgB, userB);
    const ra = mkReminder(orgA, ta, userA), rb = mkReminder(orgB, tb, userB), later = mkReminder(orgA, ta, userA, "now() + interval '1 day'");
    const r = await sweeper().sweepOnce();
    expect(r.sent).toBe(2);
    expect(state(ra)).toBe('true|false');
    expect(state(rb)).toBe('true|false');
    expect(state(later)).toBe('false|false');
    expect(notes(orgA, ta)).toBe(1);
    expect(notes(orgB, tb)).toBe(1);
    // a notification is only ever created inside its own tenant
    expect(adminSql(`SELECT count(*) FROM notification WHERE entity_id='${ta}' AND organisation_id <> '${orgA}'`)).toBe('0');
  });

  it('many sweepers running at once deliver each reminder exactly once', async () => {
    const task = mkTask(orgA, userA);
    const ids = Array.from({ length: 25 }, () => mkReminder(orgA, task, userA));
    const results = await Promise.all(Array.from({ length: 6 }, () => sweeper(10).sweepOnce()));
    for (let i = 0; i < 3; i++) await Promise.all(Array.from({ length: 4 }, () => sweeper(10).sweepOnce()));
    expect(results.reduce((n, r) => n + r.sent, 0)).toBeLessThanOrEqual(25);
    expect(ids.map(state).every((x) => x === 'true|false')).toBe(true);
    expect(notes(orgA, task)).toBe(25);
  });

  it('cancels reminders of finished tasks instead of notifying', async () => {
    const done = mkTask(orgA, userA, 'DONE'), cancelled = mkTask(orgA, userA, 'CANCELLED');
    const r1 = mkReminder(orgA, done, userA), r2 = mkReminder(orgA, cancelled, userA);
    const r = await sweeper().sweepOnce();
    expect(r.cancelled).toBe(2);
    expect([state(r1), state(r2)]).toEqual(['false|true', 'false|true']);
    expect(notes(orgA, done) + notes(orgA, cancelled)).toBe(0);
  });

  it('a reminder is final once sent: it cannot be re-armed or cancelled afterwards', async () => {
    const task = mkTask(orgA, userA);
    const id = mkReminder(orgA, task, userA);
    await sweeper().sweepOnce();
    expect(() => adminSql(`UPDATE task_reminder SET sent_at = NULL WHERE id='${id}'`)).toThrow(/final/);
    expect(() => adminSql(`UPDATE task_reminder SET cancelled_at = now() WHERE id='${id}'`)).toThrow(/final|one_outcome/);
  });

  it('one failing reminder does not stop the others, and is retried by the next sweep', async () => {
    const task = mkTask(orgB, userB);
    const bad = mkReminder(orgB, task, userB), good = mkReminder(orgB, task, userB);
    let failFor: string | null = bad;
    const flaky = new TaskReminderSweeper(db, { notify: async (_tx: unknown, n: { entityId?: string }) => { void n; if (failFor) { const f = failFor; failFor = null; throw new Error(`boom ${f}`); } } } as never, log);
    const first = await flaky.sweepOnce();
    expect(first.sent).toBe(1);
    expect(['true|false', 'false|false'].sort()).toEqual([state(bad), state(good)].sort());
    adminSql(`UPDATE task_reminder SET retry_at = NULL WHERE id='${bad}'`); // the failed one is backed off; let the backoff elapse
    await sweeper().sweepOnce();
    expect([state(bad), state(good)]).toEqual(['true|false', 'true|false']);
  });

  it('the runtime role can neither delete reminders nor read other tenants\' reminders', async () => {
    const task = mkTask(orgA, userA);
    const id = mkReminder(orgA, task, userA, "now() + interval '1 day'");
    expect(await db.tenant({ organisationId: orgB }, (tx) => tx.taskReminder.findUnique({ where: { id } }))).toBeNull();
    await expect(db.tenant({ organisationId: orgA }, (tx) => tx.taskReminder.deleteMany({ where: { id } }))).rejects.toThrow();
    expect(await db.prisma.taskReminder.count()).toBe(0); // no context => no visibility
  });
});

/** Crash and retry behaviour: the notification and the `sent_at` marker commit together or not at all. */
describe('TaskReminderSweeper: failures, retries and crashes', () => {
  const attempts = (id: string) => adminSql(`SELECT attempts||'|'||coalesce(left(last_error,40),'-')||'|'||(retry_at IS NOT NULL) FROM task_reminder WHERE id='${id}'`);
  /** Wraps the real notification service; `hook` runs AFTER the notification row was written, inside the sweeper's transaction. */
  const afterNotify = (hook: () => Promise<void>) => {
    const real = new NotificationService();
    return { notify: async (tx: never, n: never) => { await real.notify(tx, n); await hook(); } } as unknown as NotificationService;
  };
  const clearBackoff = (id: string) => adminSql(`UPDATE task_reminder SET retry_at = NULL WHERE id='${id}'`);
  beforeEach(() => { adminSql(`UPDATE task_reminder SET cancelled_at = now() WHERE sent_at IS NULL AND cancelled_at IS NULL`); }); // each case starts from an empty queue

  it('crash after the notification was written but before commit: both roll back, then exactly one notification is delivered', async () => {
    const task = mkTask(orgA, userA), id = mkReminder(orgA, task, userA);
    const crashing = new TaskReminderSweeper(db, afterNotify(async () => { throw new Error('worker died here'); }), log);
    const r = await crashing.sweepOnce();
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(notes(orgA, task)).toBe(0);                      // the half-written notification did not survive
    expect(state(id)).toBe('false|false');                  // still pending
    expect(attempts(id)).toBe('1|worker died here|true');   // counted and backed off
    expect((await sweeper().sweepOnce()).sent).toBe(0);     // backoff: not retried immediately
    clearBackoff(id);
    expect((await sweeper().sweepOnce()).sent).toBe(1);
    expect(notes(orgA, task)).toBe(1);
    expect(state(id)).toBe('true|false');
  });

  it('the database connection is killed mid-transaction: lock released, nothing delivered twice, next sweep delivers', async () => {
    const task = mkTask(orgA, userA), id = mkReminder(orgA, task, userA);
    const appName = `crashing-worker-${uuidv7()}`;
    const dbA = new Database(`${process.env.DATABASE_URL!}${process.env.DATABASE_URL!.includes('?') ? '&' : '?'}application_name=${appName}`); // the "crashing worker": its own pool, identifiable in pg_stat_activity
    let entered!: () => void; const inTx = new Promise<void>((res) => { entered = res; });
    let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
    const stuck = new TaskReminderSweeper(dbA, afterNotify(async () => { entered(); await gate; }), log);
    const running = stuck.sweepOnce();
    await inTx;                                              // notification written, row locked, transaction open
    // a second worker meanwhile neither waits for the lock nor delivers a duplicate
    const t0 = Date.now();
    expect((await sweeper().sweepOnce()).sent).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(notes(orgA, task)).toBe(0);                        // uncommitted work is invisible
    // the first worker's host dies: PostgreSQL terminates its backend
    const killed = adminSql(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = current_database() AND usename='uk_app' AND application_name='${appName}' AND state = 'idle in transaction'`);
    expect(Number(killed)).toBeGreaterThanOrEqual(1);
    release();
    const r = await running;                                  // the sweeper survives and reports the failure
    expect(r.sent).toBe(0);
    await dbA.close().catch(() => undefined);
    expect(notes(orgA, task)).toBe(0);
    expect(state(id)).toBe('false|false');
    clearBackoff(id);
    expect((await sweeper().sweepOnce()).sent).toBe(1);
    expect((await sweeper().sweepOnce()).sent).toBe(0);
    expect(notes(orgA, task)).toBe(1);
  });

  it('a poisoned reminder is backed off and finally abandoned (audited) and cannot starve newer reminders', async () => {
    const task = mkTask(orgB, userB);
    const poison = mkReminder(orgB, task, userB, "now() - interval '2 hours'");
    const healthy = mkReminder(orgB, task, userB, "now() - interval '1 minute'");
    const failing = { notify: async () => { throw new Error('mail relay exploded'); } } as unknown as NotificationService;
    // batch of ONE: the poisoned (older) reminder is picked first, fails, and moves behind the healthy one
    const first = await new TaskReminderSweeper(db, failing, log, { batchSize: 1 }).sweepOnce();
    expect(first.failed).toBe(1);
    const second = await new TaskReminderSweeper(db, new NotificationService(), log, { batchSize: 1 }).sweepOnce();
    expect(second.sent).toBe(1);
    expect(state(healthy)).toBe('true|false');
    // keep failing the poisoned one until the limit
    for (let i = 1; i < MAX_REMINDER_ATTEMPTS; i++) { clearBackoff(poison); await new TaskReminderSweeper(db, failing, log).sweepOnce(); }
    expect(state(poison)).toBe('false|true');                 // abandoned = cancelled, never sent
    expect(attempts(poison).startsWith(`${MAX_REMINDER_ATTEMPTS}|mail relay exploded`)).toBe(true);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action='task.reminder_failed' AND metadata->>'reminderId'='${poison}'`)).toBe('1');
    expect((await sweeper().sweepOnce()).sent).toBe(0);
  });

  it('cancelling while workers sweep never produces a reminder that is both sent and cancelled, nor a cancelled reminder that notified', async () => {
    const task = mkTask(orgA, userA);
    const ids = Array.from({ length: 12 }, () => mkReminder(orgA, task, userA));
    const cancel = (id: string) => db.tenant({ organisationId: orgA, userId: userA }, (tx) => tx.taskReminder.updateMany({ where: { id, sentAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } }));
    await Promise.all([...ids.map(cancel), sweeper(5).sweepOnce(), sweeper(5).sweepOnce(), sweeper(5).sweepOnce()]);
    for (let i = 0; i < 3; i++) await sweeper(5).sweepOnce();
    const states = ids.map(state);
    expect(states.every((x) => x === 'true|false' || x === 'false|true')).toBe(true);
    expect(notes(orgA, task)).toBe(states.filter((x) => x === 'true|false').length);
  });
});
