import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { parseNotificationChannels, notificationCategoryOf } from '@uk/contracts';
import { EmailChannel, InAppChannel, MAX_DELIVERY_ATTEMPTS, NotificationChannelRegistry, NotificationDeliverySweeper, NotificationService, UnavailableChannel, createNotificationChannels, type DeferredChannel, type DeferredDelivery } from '@uk/platform';
import { adminSql } from '../helpers/db';

/** V0-7.3 / ADR-38: the channel port, the registry, preference-driven planning inside the transaction, and the delivery sweeper. */
let db: Database;
let org: string, other: string, alice: string, bob: string;
const log = createLogger('silent');

class RecordingChannel implements DeferredChannel {
  readonly id = 'email' as const; readonly mode = 'deferred' as const; available = true;
  sent: DeferredDelivery[] = []; failWith: string | null = null; afterSend?: () => void;
  async send(d: DeferredDelivery) { if (this.failWith) throw new Error(this.failWith); this.sent.push(d); this.afterSend?.(); }
}
const registry = (email: DeferredChannel) => new NotificationChannelRegistry().register(new InAppChannel()).register(email).register(new UnavailableChannel('sms')).register(new UnavailableChannel('whatsapp'));
const notify = (svc: NotificationService, user: string, type = 'task.assigned', o: { orgId?: string; title?: string } = {}) =>
  db.tenant({ organisationId: o.orgId ?? org, userId: bob }, (tx) => svc.notify(tx, { organisationId: o.orgId ?? org, userId: user, type, title: o.title ?? 'A task was assigned to you', body: 'SECRET TASK TITLE', entityType: 'task', entityId: uuidv7() }));
const optIn = (user: string, category = 'task', enabled = true, orgId = org) =>
  adminSql(`INSERT INTO notification_preference(organisation_id,user_id,channel,category,enabled) VALUES ('${orgId}','${user}','email','${category}',${enabled}) ON CONFLICT (organisation_id,user_id,channel,category) DO UPDATE SET enabled=${enabled}`);
const deliveries = (user: string, status?: string) => Number(adminSql(`SELECT count(*) FROM notification_delivery WHERE user_id='${user}'${status ? ` AND status='${status}'` : ''}`));
const reset = () => adminSql(`UPDATE notification_delivery SET status='SKIPPED' WHERE status='PENDING'`);

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); other = uuidv7();
  const mk = (n: string, verified = true) => adminSql(`INSERT INTO "user"(email, display_name, email_verified_at) VALUES ('nc-${n}-${org}@t.test','${n}', ${verified ? 'now()' : 'NULL'}) RETURNING id`).split('\n')[0]!;
  alice = mk('alice'); bob = mk('bob');
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Channels'),('${other}','BUSINESS','Channels Other')`);
  const role = adminSql(`SELECT id FROM role WHERE organisation_id IS NULL AND key='owner'`);
  for (const [o, u] of [[org, alice], [org, bob]] as const) adminSql(`INSERT INTO organisation_membership(organisation_id,user_id,role_id,status) VALUES ('${o}','${u}','${role}','ACTIVE')`);
  reset();
});
afterAll(() => db.close());

describe('channel registry and configuration', () => {
  it('declares every channel; sms and whatsapp are unavailable stubs that fail loudly if reached', async () => {
    const r = createNotificationChannels({ NOTIFICATION_CHANNELS: 'in_app,email' }, { enqueue: async () => ({}) as never });
    expect(r.list()).toEqual([{ channel: 'in_app', available: true }, { channel: 'email', available: true }, { channel: 'sms', available: false }, { channel: 'whatsapp', available: false }]);
    expect(r.availableDeferred().map((c) => c.id)).toEqual(['email']);
    await expect((r.get('sms') as DeferredChannel).send({} as never)).rejects.toThrow(/not implemented/);
  });
  it('e-mail can be switched off by configuration; in_app is always on', () => {
    const r = createNotificationChannels({ NOTIFICATION_CHANNELS: 'in_app' });
    expect(r.list().find((c) => c.channel === 'email')!.available).toBe(false);
    expect(r.availableDeferred()).toEqual([]);
    expect(parseNotificationChannels('email')).toEqual(['in_app', 'email']);
  });
  it('unknown and not-yet-implemented channels are configuration errors (fail at boot)', () => {
    expect(() => parseNotificationChannels('in_app,pigeon')).toThrow(/unknown channel/);
    expect(() => parseNotificationChannels('in_app,sms')).toThrow(/not implemented/);
    expect(() => parseNotificationChannels('whatsapp')).toThrow(/not implemented/);
  });
  it('a channel id cannot be registered twice', () => {
    expect(() => new NotificationChannelRegistry().register(new InAppChannel()).register(new InAppChannel())).toThrow(/already registered/);
  });
  it('the preference category is the type prefix; unknown prefixes are "system"', () => {
    expect(['task.assigned', 'workflow.overdue', 'billing.invoice', 'x'].map(notificationCategoryOf)).toEqual(['task', 'workflow', 'system', 'system']);
  });
});

describe('NotificationService: in-app inline, other channels planned in the same transaction', () => {
  it('without a registry (existing callers) it still writes the in-app notification and plans nothing', async () => {
    await notify(new NotificationService(), alice);
    expect(adminSql(`SELECT count(*) FROM notification WHERE user_id='${alice}'`)).toBe('1');
    expect(deliveries(alice)).toBe(0);
  });
  it('a user who never chose anything gets the in-app notification only (e-mail is opt-in)', async () => {
    const email = new RecordingChannel();
    await notify(new NotificationService(registry(email)), alice);
    expect(deliveries(alice)).toBe(0);
  });
  it('planning follows the preference per channel and category, and only for the recipient', async () => {
    const svc = new NotificationService(registry(new RecordingChannel()));
    optIn(alice, 'task');
    await notify(svc, alice, 'task.assigned');
    await notify(svc, alice, 'workflow.overdue', { title: 'A workflow is overdue' });
    await notify(svc, bob, 'task.assigned');
    expect(deliveries(alice)).toBe(1);
    expect(deliveries(bob)).toBe(0);
    expect(adminSql(`SELECT category||'|'||type||'|'||status||'|'||channel FROM notification_delivery WHERE user_id='${alice}'`)).toBe('task|task.assigned|PENDING|email');
    // the title is copied, the body (which can contain task titles) is not
    expect(adminSql(`SELECT count(*) FROM notification_delivery WHERE user_id='${alice}' AND title='A task was assigned to you'`)).toBe('1');
    expect(adminSql(`SELECT count(*) FROM notification_delivery WHERE organisation_id='${org}' AND row_to_json(notification_delivery)::text LIKE '%SECRET%'`)).toBe('0');
  });
  it('a disabled preference plans nothing; an unavailable channel is never planned even if a stale opt-in exists', async () => {
    reset();
    optIn(alice, 'task', false);
    const before = deliveries(alice);
    await notify(new NotificationService(registry(new RecordingChannel())), alice);
    expect(deliveries(alice)).toBe(before);
    optIn(alice, 'task', true);
    const off = createNotificationChannels({ NOTIFICATION_CHANNELS: 'in_app' });
    await notify(new NotificationService(off), alice);
    expect(deliveries(alice)).toBe(before);
  });
  it('planning is atomic with the cause: a rolled-back transaction leaves neither a notification nor a delivery', async () => {
    const svc = new NotificationService(registry(new RecordingChannel()));
    optIn(alice, 'task');
    const n0 = Number(adminSql(`SELECT count(*) FROM notification WHERE user_id='${alice}'`)), d0 = deliveries(alice);
    await expect(db.tenant({ organisationId: org, userId: bob }, async (tx) => {
      await svc.notify(tx, { organisationId: org, userId: alice, type: 'task.assigned', title: 't' });
      throw new Error('cause failed');
    })).rejects.toThrow('cause failed');
    expect(Number(adminSql(`SELECT count(*) FROM notification WHERE user_id='${alice}'`))).toBe(n0);
    expect(deliveries(alice)).toBe(d0);
  });
  it('the database refuses sms/whatsapp opt-ins and unknown channels/categories', () => {
    expect(() => adminSql(`INSERT INTO notification_preference VALUES ('${org}','${bob}','sms','task',true)`)).toThrow(/stub_ck/);
    expect(() => adminSql(`INSERT INTO notification_preference VALUES ('${org}','${bob}','pigeon','task',false)`)).toThrow(/channel_ck/);
    expect(() => adminSql(`INSERT INTO notification_preference VALUES ('${org}','${bob}','email','nonsense',true)`)).toThrow(/category_ck/);
  });
  it('tenant isolation: another organisation cannot read or write these rows', async () => {
    optIn(alice, 'task');
    expect(await db.tenant({ organisationId: other }, (tx) => tx.notificationPreference.count())).toBe(0);
    await notify(new NotificationService(registry(new RecordingChannel())), alice);
    expect(await db.tenant({ organisationId: other }, (tx) => tx.notificationDelivery.count())).toBe(0);
    await expect(db.tenant({ organisationId: other }, (tx) => tx.notificationPreference.create({ data: { organisationId: org, userId: alice, channel: 'email', category: 'task', enabled: true } }))).rejects.toThrow();
  });
});

describe('NotificationDeliverySweeper', () => {
  const plan = async (user = alice) => { reset(); optIn(user, 'task'); await notify(new NotificationService(registry(new RecordingChannel())), user); return adminSql(`SELECT id FROM notification_delivery WHERE user_id='${user}' AND status='PENDING'`).split('\n')[0]!; };
  const status = (id: string) => adminSql(`SELECT status||'|'||attempts||'|'||coalesce(last_error,'') FROM notification_delivery WHERE id='${id}'`);

  it('hands a planned delivery to its channel exactly once, with the recipient\'s address, and marks it sent', async () => {
    const id = await plan();
    const email = new RecordingChannel();
    const r = await new NotificationDeliverySweeper(db, registry(email), log).sweepOnce();
    expect(r.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ deliveryId: id, organisationId: org, userId: alice, title: 'A task was assigned to you', recipient: { email: `nc-alice-${org}@t.test` } });
    expect(JSON.stringify(email.sent[0])).not.toContain('SECRET');
    expect(status(id)).toBe('SENT|0|');
    expect((await new NotificationDeliverySweeper(db, registry(email), log).sweepOnce()).sent).toBe(0);
    expect(email.sent).toHaveLength(1);
  });

  it('many sweepers at once: each delivery is handed over exactly once', async () => {
    reset(); optIn(alice, 'task');
    const svc = new NotificationService(registry(new RecordingChannel()));
    for (let i = 0; i < 20; i++) await notify(svc, alice);
    const email = new RecordingChannel();
    await Promise.all(Array.from({ length: 6 }, () => new NotificationDeliverySweeper(db, registry(email), log, { batchSize: 7 }).sweepOnce()));
    for (let i = 0; i < 3; i++) await Promise.all(Array.from({ length: 4 }, () => new NotificationDeliverySweeper(db, registry(email), log, { batchSize: 7 }).sweepOnce()));
    expect(email.sent).toHaveLength(20);
    expect(new Set(email.sent.map((d) => d.deliveryId)).size).toBe(20);
    expect(deliveries(alice, 'SENT')).toBeGreaterThanOrEqual(20);
  });

  it('a withdrawn opt-in, a removed member, an unverified address and an unavailable channel are skipped, never sent', async () => {
    const email = new RecordingChannel();
    const sweep = () => new NotificationDeliverySweeper(db, registry(email), log).sweepOnce();
    const a = await plan(); optIn(alice, 'task', false); await sweep();
    expect(status(a)).toBe('SKIPPED|0|preference_withdrawn');
    const b = await plan(); adminSql(`UPDATE organisation_membership SET status='REMOVED' WHERE organisation_id='${org}' AND user_id='${alice}'`); await sweep();
    expect(status(b)).toBe('SKIPPED|0|recipient_unavailable');
    adminSql(`UPDATE organisation_membership SET status='ACTIVE' WHERE organisation_id='${org}' AND user_id='${alice}'`);
    const c = await plan(); adminSql(`UPDATE "user" SET email_verified_at = NULL WHERE id='${alice}'`); await sweep();
    expect(status(c)).toBe('SKIPPED|0|recipient_unavailable');
    adminSql(`UPDATE "user" SET email_verified_at = now() WHERE id='${alice}'`);
    const d = await plan(); email.available = false; await sweep();
    expect(status(d)).toBe('SKIPPED|0|channel_unavailable');
    expect(email.sent).toHaveLength(0);
  });

  it('a failing channel backs off, is abandoned (FAILED, audited) after the attempt limit and never blocks newer deliveries', async () => {
    const bad = await plan();
    const email = new RecordingChannel(); email.failWith = 'provider down';
    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
      adminSql(`UPDATE notification_delivery SET retry_at = now() - interval '3 hours' WHERE id='${bad}'`);
      const r = await new NotificationDeliverySweeper(db, registry(email), log, { batchSize: 1 }).sweepOnce();
      expect(r.failed + r.abandoned).toBe(1);
      expect(status(bad)).toMatch(new RegExp(`^(PENDING|FAILED)\\|${i}\\|provider down$`));
    }
    expect(status(bad).startsWith('FAILED|8')).toBe(true);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE action='notification.delivery_failed' AND entity_id='${bad}'`)).toBe('1');
    // a newer delivery is still delivered once the provider recovers
    optIn(alice, 'task'); await notify(new NotificationService(registry(email)), alice);
    email.failWith = null;
    expect((await new NotificationDeliverySweeper(db, registry(email), log).sweepOnce()).sent).toBe(1);
    expect((await new NotificationDeliverySweeper(db, registry(email), log).sweepOnce()).sent).toBe(0); // the abandoned one is not retried
  });

  it('a crash after the hand-off but before commit repeats the hand-off, which the e-mail channel makes idempotent (keyed by the delivery id)', async () => {
    const id = await plan();
    const keys: string[] = [];
    const jobs = { enqueue: async (_t: unknown, _p: unknown, o: { idempotencyKey?: string }) => { keys.push(o.idempotencyKey!); return {} as never; } };
    const crashing = new EmailChannel(jobs);
    const real = crashing.send.bind(crashing);
    let crashed = false;
    crashing.send = async (d) => { await real(d); if (!crashed) { crashed = true; throw new Error('worker died after the hand-off'); } };
    const reg = registry(crashing);
    await new NotificationDeliverySweeper(db, reg, log).sweepOnce();
    expect(status(id).startsWith('PENDING|1|')).toBe(true);
    adminSql(`UPDATE notification_delivery SET retry_at = now() - interval '1 second' WHERE id='${id}'`);
    await new NotificationDeliverySweeper(db, reg, log).sweepOnce();
    expect(status(id).startsWith('SENT')).toBe(true);
    expect(keys).toEqual([`notification-delivery:${id}`, `notification-delivery:${id}`]); // same key twice: the job runtime keeps one job
  });

  it('a delivery is SENT if and only if it has its timestamp (database check)', () => {
    const id = adminSql(`SELECT id FROM notification_delivery WHERE status='SENT' LIMIT 1`) || uuidv7();
    expect(() => adminSql(`UPDATE notification_delivery SET sent_at = NULL WHERE id='${id}'`)).toThrow(/sent_ck/);
  });
});
