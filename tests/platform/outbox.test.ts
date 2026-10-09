import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Events } from '@uk/contracts';
import { createLogger, runWithContext, uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { OutboxRelay, publishEvent, type OutboxRow } from '@uk/platform';
import { adminSql } from '../helpers/db';

/** The transactional-outbox guarantees. No worker runs in this file: the relay is driven explicitly. */
let db: Database;
let org: string, org2: string, userId: string;
const log = createLogger('silent');

beforeAll(async () => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); org2 = uuidv7();
  userId = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('ob-${org}@t.test','O') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Outbox Org'),('${org2}','BUSINESS','Other Org')`);
  adminSql(`UPDATE outbox_event SET status='PUBLISHED' WHERE status='PENDING'`); // isolate from other files
});
afterAll(() => db.close());

const company = (name = 'Co') => ({ companyId: uuidv7(), name });
const emit = (organisationId = org, extra: Record<string, unknown> = {}) => db.tenant({ organisationId, userId }, async (tx) => {
  const p = company();
  const id = await publishEvent(tx, Events.companyCreated, { aggregateId: p.companyId, organisationId, payload: p, ...extra });
  return { id, p };
});
const row = (id: string) => adminSql(`SELECT status||'|'||retry_count||'|'||coalesce(last_error,'')||'|'||(published_at IS NOT NULL) FROM outbox_event WHERE id='${id}'`);

describe('envelope', () => {
  it('stores every required field', async () => {
    const { id, p } = await runWithContext({ correlationId: 'corr-outbox-0001', userId }, () => emit());
    const r = JSON.parse(adminSql(`SELECT row_to_json(e) FROM outbox_event e WHERE id='${id}'`));
    expect(r).toMatchObject({
      id, event_type: 'company.created', event_version: 1, aggregate_type: 'company', aggregate_id: p.companyId, organisation_id: org,
      payload: p, correlation_id: 'corr-outbox-0001', status: 'PENDING', retry_count: 0, last_error: null, published_at: null, actor_user_id: userId,
    });
    expect(r.occurred_at).toBeTruthy();
  });
  it('rejects payloads that do not match the event schema', async () => {
    await expect(db.tenant({ organisationId: org }, (tx) => publishEvent(tx, Events.companyCreated, { aggregateId: uuidv7(), organisationId: org, payload: { name: 5 } as never }))).rejects.toMatchObject({ code: 'invalid_event_payload' });
  });
});

describe('atomicity with the business transaction', () => {
  it('rolls back the event together with the data when the transaction fails (no phantom events)', async () => {
    const before = adminSql(`SELECT count(*) FROM outbox_event WHERE organisation_id='${org}'`);
    const companyId = uuidv7();
    await expect(db.tenant({ organisationId: org, userId }, async (tx) => {
      await tx.company.create({ data: { id: companyId, organisationId: org, name: 'Will roll back' } });
      await publishEvent(tx, Events.companyCreated, { aggregateId: companyId, organisationId: org, payload: { companyId, name: 'Will roll back' } });
      throw new Error('boom after publish');
    })).rejects.toThrow('boom');
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE organisation_id='${org}'`)).toBe(before);
    expect(adminSql(`SELECT count(*) FROM company WHERE id='${companyId}'`)).toBe('0');
  });
  it('commits the event together with the data', async () => {
    const companyId = uuidv7();
    await db.tenant({ organisationId: org, userId }, async (tx) => {
      await tx.company.create({ data: { id: companyId, organisationId: org, name: 'Committed' } });
      await publishEvent(tx, Events.companyCreated, { aggregateId: companyId, organisationId: org, payload: { companyId, name: 'Committed' } });
    });
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE aggregate_id='${companyId}'`)).toBe('1');
  });
});

describe('relay: publication failure never loses an event', () => {
  it('delivers pending events and marks them published', async () => {
    const { id } = await emit();
    const seen: OutboxRow[] = [];
    const r = await new OutboxRelay(db, async (e) => { seen.push(e); }, log).relayOnce();
    expect(r.published).toBeGreaterThanOrEqual(1);
    expect(seen.map((e) => e.id)).toContain(id);
    expect(row(id)).toBe('PUBLISHED|0||true');
  });

  it('the DB transaction succeeded but publication failed => event stays PENDING with retry_count, error and backoff; later retry succeeds', async () => {
    const { id } = await emit();
    const failing = new OutboxRelay(db, async () => { throw new Error('queue unavailable'); }, log);
    await failing.relayOnce();
    expect(row(id)).toBe('PENDING|1|queue unavailable|false');
    expect(Number(adminSql(`SELECT extract(epoch FROM (next_attempt_at - now()))::int FROM outbox_event WHERE id='${id}'`))).toBeGreaterThanOrEqual(1);

    // not due yet: a healthy relay must not touch it before the backoff elapses
    const healthyCalls: string[] = [];
    const healthy = new OutboxRelay(db, async (e) => { healthyCalls.push(e.id); }, log);
    await healthy.relayOnce();
    expect(healthyCalls).not.toContain(id);

    adminSql(`UPDATE outbox_event SET next_attempt_at = now() WHERE id='${id}'`); // backoff elapsed
    await healthy.relayOnce();
    expect(healthyCalls).toContain(id);
    expect(row(id)).toBe('PUBLISHED|1||true'); // retry_count preserved as history, error cleared
  });

  it('backs off exponentially', async () => {
    const { id } = await emit();
    const failing = new OutboxRelay(db, async () => { throw new Error('x'); }, log);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      adminSql(`UPDATE outbox_event SET next_attempt_at = now() WHERE id='${id}'`);
      await failing.relayOnce();
      delays.push(Number(adminSql(`SELECT round(extract(epoch FROM (next_attempt_at - now())))::int FROM outbox_event WHERE id='${id}'`)));
    }
    expect(delays).toEqual([2, 4, 8]);
  });

  it('gives up after maxRetries (FAILED) and can be replayed by an operator', async () => {
    const { id } = await emit();
    const relay = new OutboxRelay(db, async () => { throw new Error('permanent'); }, log, { maxRetries: 3 });
    for (let i = 0; i < 3; i++) { adminSql(`UPDATE outbox_event SET next_attempt_at = now() WHERE id='${id}'`); await relay.relayOnce(); }
    expect(row(id)).toBe('FAILED|3|permanent|false');
    expect(await relay.replayFailed()).toBeGreaterThanOrEqual(1);
    expect(row(id)).toBe('PENDING|0|permanent|false');
    await new OutboxRelay(db, async () => undefined, log).relayOnce();
    expect(row(id)).toBe('PUBLISHED|0||true');
  });

  it('many relays in parallel deliver each event exactly once (FOR UPDATE SKIP LOCKED)', async () => {
    adminSql(`UPDATE outbox_event SET status='PUBLISHED' WHERE status='PENDING'`);
    const ids = (await Promise.all(Array.from({ length: 30 }, () => emit()))).map((e) => e.id);
    const delivered: string[] = [];
    const mk = () => new OutboxRelay(db, async (e) => { await new Promise((r) => setTimeout(r, 5)); delivered.push(e.id); }, log, { batchSize: 8 });
    for (let round = 0; round < 3; round++) await Promise.all([mk().relayOnce(), mk().relayOnce(), mk().relayOnce()]);
    expect([...delivered].sort()).toEqual([...ids].sort());
    expect(new Set(delivered).size).toBe(delivered.length);
  });
});

describe('idempotent publishing', () => {
  it('the same idempotency key stores a single event', async () => {
    const key = `biz-${uuidv7()}`;
    await emit(org, { idempotencyKey: key });
    await emit(org, { idempotencyKey: key });
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE idempotency_key='${key}'`)).toBe('1');
  });
});

describe('integrity & isolation', () => {
  it('event content is immutable; only delivery bookkeeping may change', async () => {
    const { id } = await emit();
    expect(() => adminSql(`UPDATE outbox_event SET payload='{}' WHERE id='${id}'`)).toThrow(/immutable/);
    expect(() => adminSql(`UPDATE outbox_event SET event_type='x' WHERE id='${id}'`)).toThrow(/immutable/);
    adminSql(`UPDATE outbox_event SET retry_count = 1 WHERE id='${id}'`);
  });
  it('tenants cannot read, alter or delete outbox rows; only the system context may delete, and never an unprocessed event', async () => {
    const { id } = await emit(org);
    expect(await db.tenant({ organisationId: org2 }, (tx) => tx.outboxEvent.findUnique({ where: { id } }))).toBeNull();
    expect((await db.tenant({ organisationId: org }, (tx) => tx.outboxEvent.updateMany({ where: { id }, data: { status: 'PUBLISHED' } }))).count).toBe(0); // only the system relay may update
    expect((await db.tenant({ organisationId: org }, (tx) => tx.outboxEvent.deleteMany({ where: { id } }))).count).toBe(0); // RLS: DELETE is system-only
    await expect(db.system((tx) => tx.outboxEvent.deleteMany({ where: { id } }))).rejects.toThrow(/unprocessed/);               // trigger: unprocessed events are undeletable
    expect(await db.prisma.outboxEvent.count()).toBe(0); // no context => nothing visible
  });
  it('a tenant cannot publish an event into another tenant', async () => {
    await expect(db.tenant({ organisationId: org }, (tx) => publishEvent(tx, Events.companyCreated, { aggregateId: uuidv7(), organisationId: org2, payload: company() }))).rejects.toThrow();
  });
});
