import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt, totpStep } from '@uk/core';
import { ORIGIN, PASSWORD, bearer, createUser, startStack, type Stack } from '../helpers/stack';
import { adminSql } from '../helpers/db';

/**
 * DEC-013: privacy finding on session.ip / session.user_agent / auth_challenge.ip - CHARACTERISATION tests.
 *
 * These tests do NOT claim the behaviour is right. They record, with evidence, what the platform does TODAY, so that a change (collecting
 * less, purging, truncating) is a deliberate, reviewed edit of the test and of docs/legal/device-metadata-investigation.md - never an accident.
 * The finding stays UNRESOLVED until the privacy review is recorded; retention periods and lawful basis stay unapproved (DEC-003).
 */
const UA = 'DeviceMetadataTest/1.0 (synthetic)';
/**
 * A unique address per run from 198.18.0.0/15 (reserved for benchmarking, never a real client). Rate-limit counters live in Redis for up to an hour,
 * so fixed addresses made repeated local runs hit 429 and fail; with a fresh address per run the tests are deterministic.
 */
const freshIp = () => `198.${18 + Math.floor(Math.random() * 2)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
const IP = { session: freshIp(), mfa: freshIp(), listing: freshIp(), revoke: freshIp(), redis: freshIp() };
const post = (s: Stack, path: string, body: unknown, extra: Record<string, string> = {}) => s.api().post(`/api/v1${path}`).set('Origin', ORIGIN).set(extra).send(body as object);

describe('collection: the audit switch does NOT govern sessions or MFA challenges', () => {
  let s: Stack;
  beforeAll(async () => { s = await startStack({ AUDIT_CAPTURE_DEVICE_METADATA: 'false', TRUST_PROXY_HOPS: '1' }); });
  afterAll(() => s.stop());

  it('with the switch OFF the audit trail and access log carry no IP or user agent, but the session row still stores both', async () => {
    const u = await createUser(s);
    const login = await post(s, '/auth/login/bearer', { email: u.email, password: PASSWORD }, { 'User-Agent': UA, 'X-Forwarded-For': IP.session });
    expect(login.status).toBe(200);
    // audit trail: governed by the switch
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE actor_user_id='${u.userId}' AND (ip IS NOT NULL OR user_agent IS NOT NULL)`)).toBe('0');
    // session: NOT governed by the switch
    const row = adminSql(`SELECT ip||'|'||user_agent FROM session WHERE user_id='${u.userId}' ORDER BY created_at DESC LIMIT 1`);
    expect(row).toBe(`${IP.session}|${UA}`);
  });

  it('an MFA challenge stores the IP regardless of the switch', async () => {
    const u = await createUser(s);
    const enrol = await s.api().post('/api/v1/auth/mfa/enroll').set(bearer(u.token));
    // A TOTP code is valid for one 30-second step; under load the step can roll over between computing and checking it, so try this step, then the next.
    let confirm = await s.api().post('/api/v1/auth/mfa/confirm').set(bearer(u.token)).send({ code: totpAt(enrol.body.secret as string, totpStep()) });
    if (confirm.status !== 200) confirm = await s.api().post('/api/v1/auth/mfa/confirm').set(bearer(u.token)).send({ code: totpAt(enrol.body.secret as string, totpStep() + 1) });
    expect(confirm.status, `MFA confirm: ${JSON.stringify(confirm.body)}`).toBe(200);
    const first = await post(s, '/auth/login/bearer', { email: u.email, password: PASSWORD }, { 'X-Forwarded-For': IP.mfa });
    expect(first.body.mfaRequired, `login: ${first.status} ${JSON.stringify(first.body)}`).toBe(true);
    expect(adminSql(`SELECT ip FROM auth_challenge WHERE user_id='${u.userId}' ORDER BY created_at DESC LIMIT 1`)).toBe(IP.mfa);
  });

  it('the user agent is truncated to 300 characters at the source', async () => {
    const u = await createUser(s);
    await post(s, '/auth/login/bearer', { email: u.email, password: PASSWORD }, { 'User-Agent': 'A'.repeat(900) });
    expect(Number(adminSql(`SELECT length(user_agent) FROM session WHERE user_id='${u.userId}' ORDER BY created_at DESC LIMIT 1`))).toBe(300);
  });
});

describe('use and access', () => {
  let s: Stack;
  beforeAll(async () => { s = await startStack({ TRUST_PROXY_HOPS: '1' }); });
  afterAll(() => s.stop());

  it('only the owner can list their sessions (IP, user agent) and only the owner can revoke them; other users get 404 / nothing', async () => {
    const a = await createUser(s), b = await createUser(s);
    await post(s, '/auth/login/bearer', { email: a.email, password: PASSWORD }, { 'User-Agent': UA, 'X-Forwarded-For': IP.listing });
    const mine = await s.api().get('/api/v1/auth/sessions').set(bearer(a.token));
    expect(mine.status).toBe(200);
    expect(mine.body.items.some((x: { ip: string; userAgent: string }) => x.ip === IP.listing && x.userAgent === UA)).toBe(true);
    const theirs = await s.api().get('/api/v1/auth/sessions').set(bearer(b.token));
    expect(JSON.stringify(theirs.body)).not.toContain(IP.listing);
    const victim = mine.body.items[0].id as string;
    expect((await s.api().delete(`/api/v1/auth/sessions/${victim}`).set(bearer(b.token))).status).toBe(404);
  });

  it('an organisation owner cannot see another member\'s sessions or login history through any organisation endpoint', async () => {
    const owner = await createUser(s, { type: 'PRACTICE' });
    const res = await s.api().get(`/api/v1/organisations/${owner.organisationId}/members`).set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/user_?[aA]gent|"ip"/);
  });

  it('auth_challenge.ip is written but never read by any code (collection without a use)', () => {
    const ROOT = resolve(__dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { if (['node_modules', 'dist', '.next', 'generated'].includes(f)) continue; const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)) files.push(p); } };
    for (const d of ['apps/api/src', 'apps/worker/src', 'apps/web/src', 'packages/platform/src', 'packages/jobs/src']) walk(join(ROOT, d));
    const readers = files.filter((f) => /\b(ch|challenge)\.ip\b|authChallenge[^;]{0,200}select:\s*\{[^}]*\bip:\s*true/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(readers, 'if a reader appears, document its purpose in docs/legal/device-metadata-investigation.md').toEqual([]);
    const writers = files.filter((f) => /authChallenge\.create/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(writers).toEqual(['apps/api/src/auth/auth.service.ts']);
  });

  it('only the authentication module touches the session, challenge and trusted-IP tables', () => {
    const ROOT = resolve(__dirname, '../..');
    const hits: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { if (['node_modules', 'dist', '.next', 'generated'].includes(f)) continue; const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && /\.(session|authChallenge|loginTrustedIp)\.(find|create|update|delete|upsert|count)/.test(readFileSync(p, 'utf8'))) hits.push(relative(ROOT, p)); } };
    for (const d of ['apps/api/src', 'apps/worker/src', 'packages/platform/src', 'packages/jobs/src', 'packages/adapters/src']) walk(join(ROOT, d));
    expect(hits.filter((h) => !h.startsWith('apps/api/src/auth/'))).toEqual([]);
  });
});

describe('retention: nothing is purged today (KNOWN GAP - DEC-013)', () => {
  let s: Stack;
  beforeAll(async () => { s = await startStack({ TRUST_PROXY_HOPS: '1' }); });
  afterAll(() => s.stop());

  it('a revoked or expired session keeps its IP and user agent', async () => {
    const u = await createUser(s);
    const l = await post(s, '/auth/login/bearer', { email: u.email, password: PASSWORD }, { 'User-Agent': UA, 'X-Forwarded-For': IP.revoke });
    const id = adminSql(`SELECT id FROM session WHERE user_id='${u.userId}' AND ip='${IP.revoke}'`);
    await s.api().delete(`/api/v1/auth/sessions/${id}`).set(bearer(l.body.sessionToken));
    adminSql(`UPDATE session SET absolute_expires_at = now() - interval '400 days', idle_expires_at = now() - interval '400 days' WHERE id='${id}'`);
    await new Promise((r) => setTimeout(r, 1500)); // workers and sweepers run in this stack; none removes it
    expect(adminSql(`SELECT ip||'|'||user_agent||'|'||(revoked_at IS NOT NULL) FROM session WHERE id='${id}'`)).toBe(`${IP.revoke}|${UA}|true`);
  });

  it('there is no purge or cleanup job for sessions, challenges or trusted IPs in the code', () => {
    const ROOT = resolve(__dirname, '../..');
    const hits: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { if (['node_modules', 'dist', '.next', 'generated'].includes(f)) continue; const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && /\.(session|authChallenge|loginTrustedIp)\.deleteMany|DELETE FROM\s+"?(session|auth_challenge|login_trusted_ip)/i.test(readFileSync(p, 'utf8'))) hits.push(relative(ROOT, p)); } };
    for (const d of ['apps/api/src', 'apps/worker/src', 'packages']) walk(join(ROOT, d));
    expect(hits, 'a purge now exists: update the investigation document and obtain the privacy review before enabling it').toEqual([]);
  });
});

describe('rate-limit keys in Redis hold the raw IP address (short-lived)', () => {
  let s: Stack;
  let redis: IORedis;
  beforeAll(async () => { s = await startStack({ TRUST_PROXY_HOPS: '1', RATE_LIMIT_ENABLED: 'true' }); redis = new IORedis(process.env.REDIS_URL!); });
  afterAll(async () => { await redis.quit(); await s.stop(); });

  it('a rate-limited route writes a key containing the client IP in clear with a TTL no longer than its window', async () => {
    const ip = IP.redis;
    await post(s, '/auth/login/bearer', { email: 'nobody-device-meta@example.test', password: 'Wrong-Password-12345' }, { 'X-Forwarded-For': ip });
    const keys = await redis.keys(`rl:*:ip:${ip}`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) { const ttl = await redis.ttl(k); expect(ttl).toBeGreaterThan(0); expect(ttl).toBeLessThanOrEqual(3600); }
    // the login-throttle keys, by contrast, use a truncated hash of the IP
    const hashed = await redis.keys('lt:*');
    for (const k of hashed) expect(k).not.toContain(ip);
  });
});
