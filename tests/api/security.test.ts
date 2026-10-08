import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { ORIGIN, PASSWORD, bearer, createUser, orgPath, startStack, uniq, type Stack, type TestUser } from '../helpers/stack';

let s: Stack;
let u: TestUser;
beforeAll(async () => { s = await startStack(); u = await createUser(s); });
afterAll(() => s.stop());

describe('HTTP hardening', () => {
  it('sets security headers and hides the framework', async () => {
    const r = await s.api().get('/api/v1/healthz');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-frame-options']).toBeDefined();
  });
  it('echoes a safe correlation id and generates one otherwise', async () => {
    const a = await s.api().get('/api/v1/healthz').set('x-request-id', 'trace-abcdef-123456');
    expect(a.headers['x-request-id']).toBe('trace-abcdef-123456');
    const b = await s.api().get('/api/v1/healthz').set('x-request-id', 'bad id with spaces & <script>');
    expect(b.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('errors are RFC 9457 problem+json with a correlation id and no internals', async () => {
    const r = await s.api().get(orgPath(u, '/companies/not-a-uuid')).set(bearer(u.token));
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(r.body).toMatchObject({ status: 400, instance: expect.any(String), correlationId: expect.any(String) });
    expect(JSON.stringify(r.body)).not.toMatch(/prisma|stack|node_modules|at \w+ \(/i);
  });
  it('unknown routes give a clean 404; malformed JSON gives 400', async () => {
    expect((await s.api().get('/api/v1/nope')).status).toBe(404);
    const bad = await s.api().post('/api/v1/auth/login').set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_json');
  });
  it('limits JSON body size', async () => {
    const r = await s.api().post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'a@b.co', password: 'x'.repeat(2_000_000) });
    expect(r.status).toBe(413);
  });
  it('health endpoints are public; readiness checks dependencies', async () => {
    expect((await s.api().get('/api/v1/healthz')).body).toEqual({ status: 'ok' });
    const ready = await s.api().get('/api/v1/readyz');
    expect(ready.body.checks).toEqual({ database: 'ok', redis: 'ok' });
  });
  it('CORS only allows configured origins', async () => {
    const ok = await s.api().options('/api/v1/auth/login').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await s.api().options('/api/v1/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CSRF defence for cookie sessions', () => {
  it('cookie-authenticated unsafe requests need an allowed Origin', async () => {
    const agent = s.api();
    const login = await agent.post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: PASSWORD });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const noOrigin = await agent.post(orgPath(u, '/companies')).set('Cookie', cookie).send({ name: 'csrf' });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.code).toBe('origin_required');
    const evil = await agent.post(orgPath(u, '/companies')).set('Cookie', cookie).set('Origin', 'https://evil.example').send({ name: 'csrf' });
    expect(evil.body.code).toBe('origin_not_allowed');
    const good = await agent.post(orgPath(u, '/companies')).set('Cookie', cookie).set('Origin', ORIGIN).send({ name: 'csrf ok' });
    expect(good.status).toBe(201);
    const read = await agent.get('/api/v1/auth/me').set('Cookie', cookie); // safe methods work from anywhere
    expect(read.status).toBe(200);
  });
});

describe('injection & abuse resistance', () => {
  it('SQL metacharacters in inputs are inert', async () => {
    const evil = `Robert'); DROP TABLE company;--`;
    const r = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).send({ name: evil });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe(evil);
    const login = await s.api().post('/api/v1/auth/login/bearer').set('Origin', ORIGIN).send({ email: `x'--@example.test`, password: PASSWORD });
    expect(login.status).toBe(401); // treated as plain data: unknown account, generic error
    expect((await s.api().get(orgPath(u, '/companies')).set(bearer(u.token))).status).toBe(200);
  });
  it('audit/log metadata never contains credentials', async () => {
    await s.api().post('/api/v1/auth/login/bearer').set('Origin', ORIGIN).send({ email: u.email, password: 'wrong-Password-1234' });
    const { adminSql } = await import('../helpers/db');
    expect(adminSql(`SELECT string_agg(metadata::text, ' ') FROM audit_event WHERE actor_user_id='${u.userId}'`)).not.toMatch(/wrong-Password|Correct-Horse/);
  });
  it('path traversal in storage keys is impossible via API (keys are server generated)', async () => {
    const r = await s.api().post(orgPath(u, '/documents')).set(bearer(u.token)).send({ name: '../../etc/passwd', contentType: 'application/pdf', sizeBytes: 5 });
    expect(r.status).toBe(201);
    expect(r.body.version.storageKey).toMatch(/^org\/[0-9a-f-]+\/doc\/[0-9a-f-]+\/v1-[0-9a-f-]+$/);
  });
});

describe('rate limiting (Redis backed)', () => {
  let limited: Stack;
  beforeAll(async () => {
    const r = new Redis(process.env.REDIS_URL!); await r.flushdb(); r.disconnect();
    limited = await startStack({ RATE_LIMIT_ENABLED: 'true' });
  });
  afterAll(async () => {
    await limited.stop();
    const r = new Redis(process.env.REDIS_URL!); // don't leave this IP throttled for later test files
    const keys = await r.keys('lt:*'); if (keys.length) await r.del(...keys);
    r.disconnect();
  });

  it('throttles repeated forgot-password calls with 429 + Retry-After', async () => {
    const codes: number[] = [];
    let last: { headers: Record<string, string> } | undefined;
    for (let i = 0; i < 12; i++) {
      const r = await limited.api().post('/api/v1/auth/forgot-password').set('Origin', ORIGIN).send({ email: `rl-${uniq()}@example.test` });
      codes.push(r.status);
      last = r;
    }
    expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('login volume per IP is capped independently of the failure tracking', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await limited.api().post('/api/v1/auth/login/bearer').set('Origin', ORIGIN).send({ email: `v-${uniq()}@example.test`, password: 'whatever-123456' })).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
  });
});
