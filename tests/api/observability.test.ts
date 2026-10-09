import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOGGER } from '../../apps/api/src/common/tokens';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/** Observability (ADR-35): access logs, metrics, readiness detail, trace propagation, per-company job visibility. */
const TOKEN = 'metrics-token-0123456789abcdef';
let s: Stack;
let owner: TestUser, accountant: TestUser, scoped: TestUser, scopedAdmin: TestUser;
let co: { id: string }, coB: { id: string };
type Rec = Record<string, any>;
const records: Array<{ level: string; rec: Rec }> = [];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const requestLogs = () => records.filter((r) => r.rec.msg === 'request');
const call = (u: TestUser, m: 'get' | 'post' | 'patch', p: string, b?: object, h: Record<string, string> = {}) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).set(h).send(b);
const scrape = (token?: string) => s.api().get('/api/v1/metrics').set(token ? { Authorization: `Bearer ${token}` } : {});
/** A stack that is stopped within a moment of starting rejects its still-connecting Redis commands; let it settle first. */
const settle = () => new Promise((r) => setTimeout(r, 1500));
const until = async <T>(fn: () => Promise<T | false | undefined>, ms = 15_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};

beforeAll(async () => {
  s = await startStack({ METRICS_TOKEN: TOKEN, READINESS_OUTBOX_LAG_SECONDS: '5' });
  const logger = s.app.get<any>(LOGGER);
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const orig = logger[level].bind(logger);
    logger[level] = (rec: unknown, ...rest: unknown[]) => { if (rec && typeof rec === 'object') records.push({ level, rec: rec as Rec }); return orig(rec, ...rest); };
  }
  owner = await createUser(s, { type: 'PRACTICE' });
  co = await makeCompany(s, owner, 'Obs Co');
  coB = await makeCompany(s, owner, 'Obs Other');
  accountant = await addMember(s, owner, 'accountant');
  scoped = await addMember(s, owner, 'accountant', { scope: 'ASSIGNED', companyIds: [coB.id] });
  scopedAdmin = await addMember(s, owner, 'admin', { scope: 'ASSIGNED', companyIds: [coB.id] }); // holds job:manage, but only for company B
});
afterAll(() => s.stop());

describe('access logs', () => {
  it('one line per request with the route TEMPLATE, status, duration and correlation - never the concrete path, query string or body', async () => {
    const t = (await call(owner, 'post', '/tasks', { title: 'Obs task', companyId: co.id })).body;
    records.length = 0;
    const trace = 'ab'.repeat(16);
    const res = await call(owner, 'get', `/tasks/${t.id}?secret=letmein`, undefined, { traceparent: `00-${trace}-${'cd'.repeat(8)}-01` });
    expect(res.status).toBe(200);
    const line = await until(async () => requestLogs().find((r) => r.rec.route?.endsWith('/tasks/:taskId')));
    expect(line.level).toBe('info');
    expect(line.rec).toMatchObject({ method: 'GET', route: '/api/v1/organisations/:organisationId/tasks/:taskId', status: 200, durationMs: expect.any(Number), correlationId: res.headers['x-request-id'], traceId: trace, userId: owner.userId, organisationId: owner.organisationId });
    expect(JSON.stringify(line.rec)).not.toContain('letmein');
    expect(line.rec.route).not.toMatch(UUID);
    expect(res.headers.traceparent).toMatch(new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`));
  });

  it('levels follow the outcome; probes are debug; unmatched routes are labelled, not echoed; credentials never reach the log', async () => {
    records.length = 0;
    await s.api().get('/api/v1/healthz');
    await s.api().get('/api/v1/definitely/not/a/route/0190a5b6-1234-7abc-8def-0123456789ab');
    await s.api().post('/api/v1/auth/login').send({ email: 'nobody@example.test', password: 'Sup3r-secret-Passw0rd!' });
    await until(async () => requestLogs().length >= 3 && requestLogs());
    const by = (route: string) => requestLogs().find((r) => r.rec.route === route);
    expect(by('/api/v1/healthz')!.level).toBe('debug');
    const unmatched = by('unmatched')!;
    expect(unmatched.level).toBe('warn');
    expect(unmatched.rec.status).toBe(404);
    const login = by('/api/v1/auth/login')!;
    expect(login.rec.status).toBe(401);
    expect(login.level).toBe('warn');
    expect(JSON.stringify(records)).not.toContain('Sup3r-secret-Passw0rd');
    expect(JSON.stringify(records)).not.toContain('nobody@example.test');
    for (const r of requestLogs()) expect(JSON.stringify(r.rec)).not.toMatch(/0190a5b6-1234/);
  });

  it('device metadata (ip, user agent) follows the audit-trail privacy switch', async () => {
    records.length = 0;
    await s.api().get('/api/v1/healthz').set('User-Agent', 'obs-test-agent');
    const withMeta = await until(async () => requestLogs().find((r) => r.rec.route === '/api/v1/healthz'));
    expect(withMeta.rec.userAgent).toBe('obs-test-agent'); // default: captured (same lawful basis as the audit trail)
    const quiet = await startStack({ AUDIT_CAPTURE_DEVICE_METADATA: 'false' });
    try {
      const l2 = quiet.app.get<any>(LOGGER);
      const seen: Rec[] = [];
      const orig = l2.debug.bind(l2);
      l2.debug = (rec: unknown, ...rest: unknown[]) => { if (rec && typeof rec === 'object') seen.push(rec as Rec); return orig(rec, ...rest); };
      await quiet.api().get('/api/v1/healthz').set('User-Agent', 'obs-test-agent');
      const line = await until(async () => seen.find((r) => r.msg === 'request'));
      expect(line.userAgent).toBeUndefined();
      expect(line.ip).toBeUndefined();
      await settle();
    } finally { await quiet.stop(); }
  });
});

describe('metrics endpoint', () => {
  it('is disabled (404) unless a token is configured, and needs the bearer token when it is', async () => {
    const plain = await startStack();
    try { expect((await plain.api().get('/api/v1/metrics')).status).toBe(404); await settle(); } finally { await plain.stop(); }
    expect((await scrape()).status).toBe(401);
    expect((await scrape('wrong-token-0123456789abcdef')).status).toBe(401);
    expect((await s.api().get('/api/v1/metrics').set('Authorization', `Bearer ${TOKEN}x`)).status).toBe(401);
    const ok = await scrape(TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain/);
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('exposes request counts and latency by route template and status class, with bounded labels (no ids, no query strings)', async () => {
    const t = (await call(owner, 'post', '/tasks', { title: 'Metrics task' })).body;
    for (let i = 0; i < 3; i++) await call(owner, 'get', `/tasks/${t.id}?cachebust=${i}`);
    await s.api().get(`/api/v1/organisations/${owner.organisationId}/tasks/${t.id}`); // unauthenticated => 401
    const text = (await scrape(TOKEN)).text;
    expect(text).toMatch(/http_requests_total\{method="GET",route="\/api\/v1\/organisations\/:organisationId\/tasks\/:taskId",status_class="2xx"\} [3-9]/);
    expect(text).toContain('status_class="4xx"');
    expect(text).toContain('http_request_duration_seconds_bucket{le="0.1",method="GET",route="/api/v1/organisations/:organisationId/tasks/:taskId"}');
    expect(text).toContain('process_event_loop_lag_seconds');
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain('cachebust');
    expect(text).not.toContain(owner.email);
    expect(text).toMatch(/metrics_dropped_series_total 0/);
  });

  it('counts failed and throttled logins for alerting', async () => {
    for (let i = 0; i < 2; i++) await s.api().post('/api/v1/auth/login').send({ email: `ghost${i}@example.test`, password: 'Wrong-Password-1!' });
    expect((await scrape(TOKEN)).text).toMatch(/auth_login_failures_total\{reason="rejected"\} [2-9]/);
  });

  it('reports platform gauges: outbox backlog and lag, jobs by status (including DEAD), due reminders', async () => {
    const e = (await call(owner, 'post', '/jobs/echo', { message: 'doomed', failTimes: 10 })).body;
    await until(async () => (await call(owner, 'get', `/jobs/${e.id}`)).body.status === 'DEAD');
    const text = await until(async () => { const t = (await scrape(TOKEN)).text; return /jobs\{status="DEAD"\} [1-9]/.test(t) && t; });
    for (const g of ['outbox_pending', 'outbox_failed', 'outbox_in_flight', 'outbox_oldest_unprocessed_seconds', 'task_reminders_due', 'workflows_overdue']) expect(text).toContain(`\n${g} `);
    for (const st of ['QUEUED', 'RUNNING', 'RETRYING', 'FAILED', 'DEAD']) expect(text).toContain(`jobs{status="${st}"}`);
  });
});

describe('worker metrics (CloudWatch Embedded Metric Format)', () => {
  it('writes valid EMF lines with a heartbeat and the platform gauges, and no tenant identifiers', async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => { if (typeof chunk === 'string' && chunk.startsWith('{"_aws"')) lines.push(chunk.trim()); return (orig as any)(chunk, ...rest); }) as never);
    const emf = await startStack({ METRICS_EMF: 'true', METRICS_EMF_INTERVAL_MS: '1000', METRICS_NAMESPACE: 'UkPlatformTest' });
    try {
      await until(async () => lines.some((l) => l.includes('"worker_heartbeat"')) && lines.some((l) => l.includes('"outbox_failed"')));
      const parsed = lines.map((l) => JSON.parse(l));
      for (const p of parsed) {
        expect(p._aws.CloudWatchMetrics[0].Namespace).toBe('UkPlatformTest');
        expect(typeof p._aws.Timestamp).toBe('number');
        for (const m of p._aws.CloudWatchMetrics[0].Metrics) expect(p[m.Name]).toEqual(expect.any(Number));
        for (const d of p._aws.CloudWatchMetrics[0].Dimensions[0]) expect(p[d]).toEqual(expect.any(String));
      }
      expect(parsed.find((p) => p.worker_heartbeat !== undefined)).toMatchObject({ service: 'worker', worker_heartbeat: 1 });
      expect(parsed.find((p) => p.jobs !== undefined && p.status === 'DEAD')).toBeDefined();
      expect(lines.join('\n')).not.toMatch(UUID);
    } finally { spy.mockRestore(); await emf.stop(); }
  });
});

describe('readiness', () => {
  it('liveness has no dependencies; readiness lists checks, is "ok" or "degraded" with reasons, and shows figures only to the metrics token holder', async () => {
    expect((await s.api().get('/api/v1/healthz')).body).toEqual({ status: 'ok' });
    const r = await s.api().get('/api/v1/readyz');
    expect(r.status).toBe(200);
    expect(r.body.checks).toMatchObject({ database: 'ok', redis: 'ok' });
    expect(['ok', 'degraded']).toContain(r.body.status);
    expect(r.body.figures).toBeUndefined();
    const withFigures = await s.api().get('/api/v1/readyz').set('Authorization', `Bearer ${TOKEN}`);
    expect(withFigures.body.figures).toMatchObject({ outboxLagSeconds: expect.any(Number), jobsDead: expect.any(Number), outboxFailed: expect.any(Number) });
    expect((await s.api().get('/api/v1/readyz').set('Authorization', 'Bearer wrong-token-0123456789abcdef')).body.figures).toBeUndefined();
  });

  it('reports "degraded" (still 200) for dead jobs, failed outbox events and outbox lag - and never fails readiness for them', async () => {
    const dead = await until(async () => { const r = await s.api().get('/api/v1/readyz'); return r.body.degraded.includes('dead_jobs') && r; });
    expect(dead.status).toBe(200);
    expect(dead.body.status).toBe('degraded');
    const ev = adminSql(`SELECT id FROM outbox_event WHERE status='PUBLISHED' AND processed_at IS NOT NULL ORDER BY seq DESC LIMIT 1`);
    expect(ev).toBeTruthy();
    try {
      adminSql(`UPDATE outbox_event SET status='FAILED', processed_at=NULL, created_at = now() - interval '1 hour' WHERE id='${ev}'`);
      const r = await s.api().get('/api/v1/readyz');
      expect(r.status).toBe(200);
      expect(r.body.degraded).toEqual(expect.arrayContaining(['outbox_failed', 'outbox_lag']));
    } finally { adminSql(`UPDATE outbox_event SET status='PUBLISHED', processed_at=now() WHERE id='${ev}'`); }
  });
});

describe('trace propagation and per-company job visibility', () => {
  it('the trace id of the request that enqueued a job is stored on the job and visible in the API', async () => {
    const trace = '12'.repeat(16);
    const job = (await call(owner, 'post', '/jobs/echo', { message: 'traced' }, { traceparent: `00-${trace}-${'34'.repeat(8)}-01` })).body;
    expect(job.traceId).toBe(trace);
    expect(adminSql(`SELECT trace_id FROM job_record WHERE id='${job.id}'`)).toBe(trace);
    expect((await call(owner, 'post', '/jobs/echo', { message: 'bad trace' }, { traceparent: '00-00000000000000000000000000000000-0000000000000000-01' })).body.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('document jobs carry the company; members who cannot read that company neither see, fetch nor retry them', async () => {
    const d = await uploadDoc(s, owner, { companyId: co.id });
    await waitForVersion(s, owner, d.documentId, d.versionId);
    const mine = (await call(owner, 'get', `/jobs?companyId=${co.id}&limit=100`)).body.items as Rec[];
    const job = mine.find((j) => j.type === 'document.process')!;
    expect(job).toMatchObject({ companyId: co.id });
    expect(adminSql(`SELECT company_id FROM job_record WHERE id='${job.id}'`)).toBe(co.id);
    expect((await call(accountant, 'get', `/jobs/${job.id}`)).status).toBe(200);
    expect((await call(scoped, 'get', `/jobs/${job.id}`)).status).toBe(404);
    expect(((await call(scoped, 'get', '/jobs?limit=100')).body.items as Rec[]).some((j) => j.id === job.id)).toBe(false);
    expect(((await call(scoped, 'get', `/jobs?companyId=${co.id}&limit=100`)).body.items as Rec[])).toHaveLength(0);
    expect((await call(scoped, 'post', `/jobs/${job.id}/retry`)).status).toBe(403);      // no job:manage at all
    expect((await call(scopedAdmin, 'post', `/jobs/${job.id}/retry`)).status).toBe(404); // job:manage, but not for this company
    // organisation-level jobs (no company) stay visible to job readers
    const echo = (await call(owner, 'post', '/jobs/echo', { message: 'org-level' })).body;
    expect((await call(scoped, 'get', `/jobs/${echo.id}`)).status).toBe(200);
    // a job cannot point at another organisation's company (composite foreign key)
    const stranger = await createUser(s, { type: 'BUSINESS' });
    const foreign = await makeCompany(s, stranger, 'Foreign Co');
    expect(() => adminSql(`UPDATE job_record SET company_id='${foreign.id}' WHERE id='${echo.id}'`)).toThrow(/job_record_organisation_id_company_id_fkey/);
  });
});
