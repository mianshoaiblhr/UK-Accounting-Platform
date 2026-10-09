import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobTypes } from '@uk/contracts';
import { FieldEncryption, createLogger, loadConfig, runWithContext, uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { JobProducer } from '@uk/jobs';
import { IntegrationService, createIntegrationRegistry } from '@uk/platform';
import { startWorker } from '../../apps/worker/src/worker';
import { adminSql } from '../helpers/db';

/**
 * V0-TEST-6 / V0-9.4: an external call that fails transiently is retried with backoff and then succeeds; a client error is not retried.
 * The "flaky adapter" is the `flaky` operation of the development registry's mock provider (never registered in production).
 * The job table for integration calls is `job_record` (ADR-36): it carries organisation, company, trace and correlation ids.
 */
const config = loadConfig(process.env as NodeJS.ProcessEnv);
const log = createLogger('silent');
const crypto = new FieldEncryption(config.FIELD_ENCRYPTION_KEY);
const org = uuidv7();
const companyId = uuidv7();
let db: Database, producer: JobProducer, worker: ReturnType<typeof startWorker>, userId: string, connectionId: string;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const record = (id: string) => db.tenant({ organisationId: org }, (tx) => tx.jobRecord.findUniqueOrThrow({ where: { id } }));
const done = (id: string, statuses: string[]) => until(async () => { const r = await record(id); return statuses.includes(r.status) ? r : false; });
const call = (operation: string, params: Record<string, unknown>, o: Record<string, unknown> = {}) =>
  producer.enqueue(JobTypes.integrationExecute, { connectionId, operation, params }, { organisationId: org, userId, companyId, ...o });

beforeAll(async () => {
  db = new Database(config.DATABASE_URL);
  userId = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('intretry-${org}@t.test','I') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','Integration Retry Org')`);
  adminSql(`INSERT INTO company(id, organisation_id, name, company_number, status) VALUES ('${companyId}','${org}','Retry Co','${String(Date.now()).slice(-8)}','ACTIVE')`);
  const service = new IntegrationService(createIntegrationRegistry(config), crypto);
  connectionId = (await db.tenant({ organisationId: org, userId }, (tx) => service.create(tx, { organisationId: org, userId, provider: 'mock', displayName: 'Flaky mock', credentials: { apiKey: 'retry-test-key-1' } }))).id;
  producer = new JobProducer(db, config.REDIS_URL, crypto, log);
  worker = startWorker(config);
});
afterAll(async () => { await worker.stop(); await producer.close(); await db.close(); });

describe('integration calls through the job runtime (V0-TEST-6)', () => {
  it('a transient provider failure is retried with exponential backoff and then succeeds', async () => {
    const t0 = Date.now();
    const { record: r } = await runWithContext({ correlationId: 'int-retry-corr-1', traceId: '0af7651916cd43dd8448eb211c80319c' }, () => call('flaky', { key: 'transient', failTimes: 2 }));
    expect(r.status).toBe('QUEUED');
    const final = await done(r.id, ['COMPLETED']);
    expect(final.attempts).toBe(3);
    expect(final.error).toBeNull();
    expect(final.result).toEqual({ recovered: true, calls: 3 });
    // retry policy for integration.execute is 5 attempts, 5 s base, exponential: attempt 2 after >=5 s, attempt 3 after a further >=10 s
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15_000);
    // the integration job table is job_record: tenant, company, trace and correlation ids are on the record
    expect(final).toMatchObject({ organisationId: org, companyId, correlationId: 'int-retry-corr-1', traceId: '0af7651916cd43dd8448eb211c80319c', type: 'integration.execute' });
  }, 60_000);

  it('the retry state is visible while the job waits (RETRYING with the provider error recorded)', async () => {
    const { record: r } = await call('flaky', { key: 'visible', failTimes: 1 });
    const retrying = await done(r.id, ['RETRYING']);
    expect(retrying.error).toMatch(/temporarily unavailable \(call 1\)/);
    expect(retrying.finishedAt).toBeNull();
    const final = await done(r.id, ['COMPLETED']);
    expect(final.attempts).toBe(2);
  }, 60_000);

  it('client errors are permanent: an unsupported operation fails immediately without retries', async () => {
    const { record: r } = await call('delete_everything', {});
    const final = await done(r.id, ['FAILED']);
    expect(final.attempts).toBe(1);
    expect(final.error).toMatch(/unsupported_operation/);
  });

  it('a revoked connection fails immediately (no retries against a connection that no longer exists)', async () => {
    const service = new IntegrationService(createIntegrationRegistry(config), crypto);
    const id = (await db.tenant({ organisationId: org, userId }, (tx) => service.create(tx, { organisationId: org, userId, provider: 'mock', displayName: 'To revoke', credentials: { apiKey: 'retry-test-key-2' } }))).id;
    await db.tenant({ organisationId: org, userId }, (tx) => service.revoke(tx, id));
    const { record: r } = await producer.enqueue(JobTypes.integrationExecute, { connectionId: id, operation: 'echo', params: {} }, { organisationId: org, userId, companyId });
    const final = await done(r.id, ['FAILED']);
    expect(final.attempts).toBe(1);
  });

  it('credentials never appear on the job record or in its payload', async () => {
    const { record: r } = await call('echo', { hello: 'world' });
    await done(r.id, ['COMPLETED']);
    const row = adminSql(`SELECT payload::text || coalesce(result::text,'') || coalesce(error,'') FROM job_record WHERE id='${r.id}'`);
    expect(row).not.toContain('retry-test-key');
  });
});
