import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Events } from '@uk/contracts';
import { createLogger, uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { EventBus, OutOfOrderEventError, OutboxRelay, publishEvent } from '@uk/platform';
import { adminSql } from '../helpers/db';

/**
 * Outbox hardening: per-aggregate ordering (relay + consumer guard), cleanup that can never touch unprocessed events,
 * and the lag/backlog figures used by metrics and alarms. No worker runs: relay and bus are driven explicitly.
 */
let db: Database;
let org: string, userId: string;
const log = createLogger('silent');
const seen: string[] = [];           // aggregate-qualified event order as the dispatcher saw it
let failOn: string | null = null;     // event id the dispatcher should fail once
const relay = () => new OutboxRelay(db, async (row) => {
  if (failOn === row.id) { failOn = null; throw new Error('queue down'); }
  seen.push(row.id);
}, log, { maxRetries: 3 });

const emit = (aggregateId: string, name = 'n') => db.tenant({ organisationId: org, userId }, (tx) =>
  publishEvent(tx, Events.companyCreated, { aggregateId, organisationId: org, payload: { companyId: aggregateId, name } }));
const status = (id: string) => adminSql(`SELECT status||'|'||(processed_at IS NOT NULL) FROM outbox_event WHERE id='${id}'`);
const makeBus = (handled: string[]) => new EventBus(db, log).subscribe('t.consumer', [Events.companyCreated.type], async ({ event }) => { handled.push(event.id); });

beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7();
  userId = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('oh-${org}@t.test','O') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Outbox Hardening')`);
  adminSql(`UPDATE outbox_event SET status='PUBLISHED', processed_at=now() WHERE processed_at IS NULL AND organisation_id IS DISTINCT FROM '${org}'`); // isolate from other files
});
afterAll(() => db.close());

describe('per-aggregate ordering', () => {
  it('only the head of each aggregate is published; the rest wait until the head is fully processed', async () => {
    seen.length = 0;
    const A = uuidv7(), B = uuidv7();
    const a1 = await emit(A, 'a1'), a2 = await emit(A, 'a2'), a3 = await emit(A, 'a3'), b1 = await emit(B, 'b1');
    const r = relay(), handled: string[] = [], bus = makeBus(handled);

    expect((await r.relayOnce()).published).toBe(2);            // A's head and B's head - not A2/A3
    expect(seen).toEqual([a1, b1]);
    expect(status(a2)).toBe('PENDING|false');
    expect((await r.relayOnce()).published).toBe(0);            // a1 is published but not yet consumed: A stays blocked

    await bus.dispatch(a1);
    expect(status(a1)).toBe('PUBLISHED|true');
    expect((await r.relayOnce()).published).toBe(1);            // now a2 (and still not a3)
    expect(seen).toEqual([a1, b1, a2]);

    await bus.dispatch(a2); await r.relayOnce(); await bus.dispatch(a3 === a3 ? (seen.at(-1) as string) : a3);
    await bus.dispatch(b1);
    expect(seen).toEqual([a1, b1, a2, a3]);
    expect(handled).toEqual([a1, a2, a3, b1]);                  // consumer order per aggregate == production order
  });
  it('the consumer side refuses to run an event ahead of an earlier unprocessed event of the same aggregate', async () => {
    const A = uuidv7();
    const e1 = await emit(A, 'e1'), e2 = await emit(A, 'e2');
    adminSql(`UPDATE outbox_event SET status='PUBLISHED', published_at=now() WHERE id IN ('${e1}','${e2}')`); // both handed to the queue (e.g. by a legacy relay)
    const handled: string[] = [], bus = makeBus(handled);
    await expect(bus.dispatch(e2)).rejects.toBeInstanceOf(OutOfOrderEventError);
    expect(handled).toEqual([]);                                 // no consumer effect happened
    await bus.dispatch(e1);
    await bus.dispatch(e2);
    expect(handled).toEqual([e1, e2]);
  });
  it('a failing head blocks only its own aggregate, retries with backoff, and releases successors once delivered', async () => {
    seen.length = 0;
    const A = uuidv7(), B = uuidv7();
    const a1 = await emit(A), a2 = await emit(A), b1 = await emit(B);
    failOn = a1;
    const r = relay();
    expect((await r.relayOnce())).toMatchObject({ published: 1, failed: 1 });   // b1 delivered, a1 failed, a2 held back
    expect(seen).toEqual([b1]);
    expect(adminSql(`SELECT retry_count||'|'||last_error FROM outbox_event WHERE id='${a1}'`)).toBe('1|queue down');
    expect(status(a2)).toBe('PENDING|false');
    adminSql(`UPDATE outbox_event SET next_attempt_at=now() WHERE id='${a1}'`);   // backoff elapsed
    expect((await r.relayOnce()).published).toBe(1);
    expect(seen).toEqual([b1, a1]);                                               // a2 still waits for a1 to be consumed
    expect(status(a2)).toBe('PENDING|false');
  });
  it('an event that exhausts its retries (FAILED) keeps its aggregate blocked until an operator replays it', async () => {
    seen.length = 0;
    const A = uuidv7();
    const f1 = await emit(A), f2 = await emit(A);
    const r = new OutboxRelay(db, async () => { throw new Error('permanent'); }, log, { maxRetries: 1 });
    expect((await r.relayOnce()).deadLettered).toBe(1);
    expect(status(f1)).toBe('FAILED|false');
    adminSql(`UPDATE outbox_event SET next_attempt_at=now() WHERE id='${f2}'`);
    expect((await relay().relayOnce()).published).toBe(0);                         // f2 must not overtake the failed f1
    expect(await relay().replayFailed()).toBeGreaterThan(0);
    expect((await relay().relayOnce()).published).toBe(1);
    expect(seen).toEqual([f1]);
  });
  it('concurrent relays never publish an event twice or two events of one aggregate in the same pass', async () => {
    seen.length = 0;
    const aggs = Array.from({ length: 6 }, () => uuidv7());
    const ids: string[] = [];
    for (const a of aggs) { ids.push(await emit(a, '1')); ids.push(await emit(a, '2')); }
    const results = await Promise.all([relay().relayOnce(), relay().relayOnce(), relay().relayOnce()]);
    expect(results.reduce((n, x) => n + x.published, 0)).toBe(6);
    expect(new Set(seen).size).toBe(seen.length);
    const firsts = aggs.map((_, i) => ids[i * 2]!);
    expect(seen.filter((id) => ids.includes(id)).sort()).toEqual(firsts.sort());
  });
  it('seq follows insertion order and is immutable', async () => {
    const A = uuidv7();
    const x = await emit(A), y = await emit(A);
    expect(BigInt(adminSql(`SELECT seq FROM outbox_event WHERE id='${y}'`)) > BigInt(adminSql(`SELECT seq FROM outbox_event WHERE id='${x}'`))).toBe(true);
    expect(() => adminSql(`UPDATE outbox_event SET seq = seq + 1000000 WHERE id='${x}'`)).toThrow(/can only be updated to DEFAULT/);
  });
});

describe('cleanup', () => {
  it('deletes events processed longer ago than the retention, with their consumer markers; keeps recent and unprocessed ones', async () => {
    const [old1, old2, recent, unprocessed] = [await emit(uuidv7()), await emit(uuidv7()), await emit(uuidv7()), await emit(uuidv7())];
    adminSql(`UPDATE outbox_event SET status='PUBLISHED', published_at=now() - interval '40 days', processed_at=now() - interval '40 days' WHERE id IN ('${old1}','${old2}')`);
    adminSql(`UPDATE outbox_event SET status='PUBLISHED', published_at=now(), processed_at=now() - interval '2 days' WHERE id='${recent}'`);
    adminSql(`UPDATE outbox_event SET created_at=now() - interval '90 days', occurred_at=occurred_at WHERE id='${unprocessed}'`);   // ancient but never processed
    adminSql(`INSERT INTO event_consumption(event_id, consumer, organisation_id) VALUES ('${old1}','c','${org}'), ('${recent}','c','${org}')`);
    const deleted = await relay().cleanup(14);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE id IN ('${old1}','${old2}')`)).toBe('0');
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE id IN ('${recent}','${unprocessed}')`)).toBe('2');
    expect(adminSql(`SELECT count(*) FROM event_consumption WHERE event_id='${old1}'`)).toBe('0');
    expect(adminSql(`SELECT count(*) FROM event_consumption WHERE event_id='${recent}'`)).toBe('1');
  });
  it('works in bounded batches', async () => {
    const ids = await Promise.all(Array.from({ length: 7 }, () => emit(uuidv7())));
    adminSql(`UPDATE outbox_event SET status='PUBLISHED', processed_at=now() - interval '30 days' WHERE id IN (${ids.map((i) => `'${i}'`).join(',')})`);
    expect(await relay().cleanup(14, 3)).toBeGreaterThanOrEqual(7);
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE id IN (${ids.map((i) => `'${i}'`).join(',')})`)).toBe('0');
  });
  it('the database refuses to delete an unprocessed event - even for the system role, whatever its age', async () => {
    const id = await emit(uuidv7());
    expect(() => adminSql(`DELETE FROM outbox_event WHERE id='${id}'`)).toThrow(/unprocessed/);
    await expect(db.system((tx) => tx.outboxEvent.deleteMany({ where: { id } }))).rejects.toThrow(/unprocessed/);
    expect(await db.tenant({ organisationId: org }, (tx) => tx.outboxEvent.deleteMany({ where: { id } }))).toEqual({ count: 0 }); // tenants cannot delete at all (RLS hides the row from DELETE)
    expect(adminSql(`SELECT count(*) FROM outbox_event WHERE id='${id}'`)).toBe('1');
  });
  it('rejects nonsense retention', async () => {
    await expect(relay().cleanup(0)).rejects.toThrow(/retentionDays/);
  });
  it('processed_at is only possible on published events', () => {
    const id = adminSql(`SELECT id FROM outbox_event WHERE status='PENDING' LIMIT 1`);
    if (id) expect(() => adminSql(`UPDATE outbox_event SET processed_at=now() WHERE id='${id}'`)).toThrow(/outbox_processed_ck/);
  });
});

describe('stats (lag / backlog)', () => {
  it('reports pending, failed, in-flight and the age of the oldest unprocessed event', async () => {
    adminSql(`UPDATE outbox_event SET status='PUBLISHED', processed_at=now() WHERE processed_at IS NULL`); // clean slate
    const s0 = await relay().stats();
    expect(s0).toMatchObject({ pending: 0, failed: 0, inFlight: 0, oldestUnprocessedAgeSeconds: 0, oldestPendingAgeSeconds: 0 });
    const p = await emit(uuidv7()), f = await emit(uuidv7()), inflight = await emit(uuidv7());
    adminSql(`UPDATE outbox_event SET status='FAILED' WHERE id='${f}'`);
    adminSql(`UPDATE outbox_event SET status='PUBLISHED', published_at=now() WHERE id='${inflight}'`);
    adminSql(`UPDATE outbox_event SET created_at = now() - interval '120 seconds' WHERE id='${p}'`);
    const s = await relay().stats();
    expect(s).toMatchObject({ pending: 1, failed: 1, inFlight: 1 });
    expect(s.oldestUnprocessedAgeSeconds).toBeGreaterThanOrEqual(119);
    expect(s.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(119);
    expect(s.processedTotal).toBeGreaterThan(0);
  });
});
