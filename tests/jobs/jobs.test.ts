import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_QUEUE, JobTypes } from '@uk/contracts';
import { FieldEncryption, createLogger, runWithContext, uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { JobProducer, JobRuntime } from '@uk/jobs';
import { startWorker } from '../../apps/worker/src/worker';
import { loadConfig } from '@uk/core';
import { adminSql } from '../helpers/db';

const config = loadConfig(process.env as NodeJS.ProcessEnv);
const log = createLogger('silent');
const crypto = new FieldEncryption(config.FIELD_ENCRYPTION_KEY);
const org = uuidv7();
let db: Database, producer: JobProducer, worker: ReturnType<typeof startWorker>, userId: string;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const record = (id: string) => db.tenant({ organisationId: org }, (tx) => tx.jobRecord.findUniqueOrThrow({ where: { id } }));
const done = (id: string, statuses: string[]) => until(async () => { const r = await record(id); return statuses.includes(r.status) ? r : false; });
const echo = (p: { message: string; failTimes?: number; permanent?: boolean }, o: Record<string, unknown> = {}) =>
  producer.enqueue(JobTypes.systemEcho, { failTimes: 0, permanent: false, ...p }, { organisationId: org, userId, ...o });

beforeAll(async () => {
  db = new Database(config.DATABASE_URL);
  userId = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('jobs-${org}@t.test','J') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','PRACTICE','Jobs Org')`);
  producer = new JobProducer(db, config.REDIS_URL, crypto, log);
  worker = startWorker(config);
});
afterAll(async () => { await worker.stop(); await producer.close(); await db.close(); });

describe('job infrastructure', () => {
  it('runs a job to completion with progress, result and timestamps', async () => {
    const { record: r } = await echo({ message: 'hi' });
    expect(r.status).toBe('QUEUED');
    const final = await done(r.id, ['COMPLETED']);
    expect(final.result).toEqual({ echoed: 'hi', attempt: 1 });
    expect(final.progress).toBe(100);
    expect(final.startedAt).toBeTruthy();
    expect(final.finishedAt).toBeTruthy();
    expect(final.attempts).toBe(1);
  });

  it('is idempotent: same key => one job, one execution', async () => {
    const a = await echo({ message: 'once' }, { idempotencyKey: 'k-1' });
    const b = await echo({ message: 'once' }, { idempotencyKey: 'k-1' });
    expect(b.deduplicated).toBe(true);
    expect(b.record.id).toBe(a.record.id);
    await done(a.record.id, ['COMPLETED']);
    expect(adminSql(`SELECT count(*) FROM job_record WHERE idempotency_key='${org}:k-1'`)).toBe('1');
  });

  it('retries with exponential backoff then succeeds', async () => {
    const { record: r } = await echo({ message: 'flaky', failTimes: 2 });
    const final = await done(r.id, ['COMPLETED']);
    expect(final.attempts).toBe(3);
    expect(final.error).toBeNull();
    // backoff base 100ms: waits 100ms then 200ms between attempts
    expect(final.finishedAt!.getTime() - final.createdAt.getTime()).toBeGreaterThanOrEqual(300);
  });

  it('exhausted retries => DEAD + dead-letter entry', async () => {
    const { record: r } = await echo({ message: 'always', failTimes: 99 });
    const final = await done(r.id, ['DEAD']);
    expect(final.attempts).toBe(3);
    expect(final.error).toMatch(/simulated failure/);
    const dlq = await until(async () => (await producer.queue(DEAD_LETTER_QUEUE).getJobs(['waiting', 'delayed', 'completed', 'active'])).find((j) => j.data.recordId === r.id));
    expect(dlq.data).toMatchObject({ type: 'system.echo', permanent: false, attempts: 3 });
  });

  it('unrecoverable errors fail immediately without retries (FAILED)', async () => {
    const { record: r } = await echo({ message: 'nope', permanent: true });
    const final = await done(r.id, ['FAILED']);
    expect(final.attempts).toBe(1);
    expect(final.error).toMatch(/permanent failure/);
  });

  it('a dead job can be retried by an operator', async () => {
    const { record: r } = await echo({ message: 'retry-me', failTimes: 99 });
    await done(r.id, ['DEAD']);
    const q = await producer.retry(org, userId, r.id);
    expect(q.status).toBe('QUEUED');
    expect(q.attempts).toBe(0);
    await done(r.id, ['DEAD', 'RETRYING', 'RUNNING']); // runs again (still failing by design)
  });

  it('only failed jobs can be retried', async () => {
    const { record: r } = await echo({ message: 'fine' });
    await done(r.id, ['COMPLETED']);
    await expect(producer.retry(org, userId, r.id)).rejects.toMatchObject({ code: 'job_not_retryable' });
  });

  it('propagates the correlation id from the enqueuing context', async () => {
    const cid = 'corr-test-12345678';
    const { record: r } = await runWithContext({ correlationId: cid }, () => echo({ message: 'trace' }));
    expect(r.correlationId).toBe(cid);
  });

  it('rejects invalid payloads before anything is stored', async () => {
    await expect(producer.enqueue(JobTypes.emailSend, { to: 'not-an-email', subject: 's', text: 't' }, { organisationId: org })).rejects.toMatchObject({ code: 'invalid_job_payload' });
  });

  it('sensitive payloads are encrypted at rest in Postgres and Redis', async () => {
    const { record: r } = await producer.enqueue(JobTypes.emailSend, { to: 'a@b.test', subject: 'Reset', text: 'token=SUPERSECRETTOKEN' }, { organisationId: org });
    const stored = JSON.stringify(adminSql(`SELECT payload FROM job_record WHERE id='${r.id}'`));
    expect(stored).not.toContain('SUPERSECRETTOKEN');
    expect(stored).toContain('__enc');
    const redisJob = await producer.queue('notifications').getJob(r.id);
    if (redisJob) expect(JSON.stringify(redisJob.data)).not.toContain('SUPERSECRETTOKEN');
    await done(r.id, ['COMPLETED', 'RETRYING']);
  });

  it('sweeper re-dispatches records that never reached Redis (Redis outage between write and enqueue)', async () => {
    const id = uuidv7();
    adminSql(`INSERT INTO job_record(id, organisation_id, queue, type, idempotency_key, correlation_id, payload, max_attempts, created_at)
              VALUES ('${id}','${org}','scheduled','system.echo','${org}:orphan','orphan-corr-1','{"message":"orphan","failTimes":0,"permanent":false}', 3, now() - interval '5 minutes')`);
    expect((await record(id)).status).toBe('QUEUED');
    expect(await producer.sweepStale(1_000)).toBeGreaterThanOrEqual(1);
    const final = await done(id, ['COMPLETED']);
    expect(final.result).toMatchObject({ echoed: 'orphan' });
  });

  it('tenant isolation: another organisation cannot see or retry these jobs', async () => {
    const other = uuidv7();
    adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${other}','BUSINESS','Other')`);
    expect(await db.tenant({ organisationId: other }, (tx) => tx.jobRecord.count())).toBe(0);
    const { record: r } = await echo({ message: 'mine', failTimes: 99 });
    await done(r.id, ['DEAD']);
    await expect(producer.retry(other, userId, r.id)).rejects.toMatchObject({ status: 404 });
  });

  it('queues exist for every declared workload', () => {
    for (const q of ['documents', 'imports', 'exports', 'ai', 'reconciliation', 'notifications', 'reports', 'integrations', 'scheduled', DEAD_LETTER_QUEUE]) {
      expect(() => producer.queue(q)).not.toThrow();
    }
  });
});

describe('runtime without handler', () => {
  it('JobRuntime registers handlers per queue only', () => {
    const rt = new JobRuntime(db, config.REDIS_URL, crypto, producer, log);
    expect(rt.register(JobTypes.systemEcho, async () => 1)).toBe(rt);
  });
});
