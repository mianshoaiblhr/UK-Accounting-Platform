import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, PASSWORD, createUser, startStack, uniq, type Stack } from '../helpers/stack';
import { adminSql } from '../helpers/db';

let s: Stack;
beforeAll(async () => {
  s = await startStack({ TRUST_PROXY_HOPS: '1', LOGIN_DELAY_BASE_SECONDS: '1', LOGIN_DELAY_START: '3', LOGIN_PAIR_BLOCK_AT: '6',
    LOGIN_IP_BLOCK_AT: '40', LOGIN_IP_DISTINCT_ACCOUNTS: '8', LOGIN_ACCOUNT_PRESSURE_AT: '12' });
});
afterAll(() => s.stop());

let ipSeq = 0;
const newIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;
const attempt = (ip: string, email: string, password = 'wrong-password-123') =>
  s.api().post('/api/v1/auth/login/bearer').set('Origin', ORIGIN).set('X-Forwarded-For', ip).send({ email, password });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const audits = (like: string) => adminSql(`SELECT count(*) FROM audit_event WHERE action='${like}'`);

describe('layer 1: IP + account pair — progressive delay then temporary block', () => {
  it('enforces an increasing wait after repeated failures (429 + Retry-After), without any sleeping on the server', async () => {
    const u = await createUser(s);
    const ip = newIp();
    for (let i = 0; i < 3; i++) expect((await attempt(ip, u.email)).status).toBe(401);
    const throttled = await attempt(ip, u.email); // immediate retry inside the delay window
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await wait(1100);
    expect((await attempt(ip, u.email)).status).toBe(401); // 4th failure allowed after waiting 1s; next delay doubles to 2s
    expect((await attempt(ip, u.email)).status).toBe(429);
  });
  it('even the CORRECT password is refused while the pair is delayed or blocked', async () => {
    const u = await createUser(s);
    const ip = newIp();
    for (let i = 0; i < 3; i++) await attempt(ip, u.email);
    expect((await attempt(ip, u.email, PASSWORD)).status).toBe(429);
  });
  it('blocks the pair after the threshold, audits the transition once', async () => {
    const u = await createUser(s);
    const ip = newIp();
    const before = Number(audits('auth.pair_blocked'));
    for (let i = 0; i < 6; i++) { await attempt(ip, u.email); await wait(i < 2 ? 0 : 2 ** (i - 2) * 1000 + 50); }
    expect((await attempt(ip, u.email, PASSWORD)).status).toBe(429);
    expect(Number(audits('auth.pair_blocked'))).toBe(before + 1);
  });
  it('a successful sign-in clears the pair counter', async () => {
    const u = await createUser(s);
    const ip = newIp();
    await attempt(ip, u.email); await attempt(ip, u.email);
    expect((await attempt(ip, u.email, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await attempt(ip, u.email)).status).toBe(401); // counter restarted
  });
});

describe('anti lockout-DoS: attacker traffic cannot lock the owner out', () => {
  it('owner on a different IP signs in normally while the attacker pair is blocked', async () => {
    const u = await createUser(s);
    const attacker = newIp();
    for (let i = 0; i < 6; i++) { await attempt(attacker, u.email); await wait(i < 2 ? 0 : 2 ** (i - 2) * 1000 + 50); }
    expect((await attempt(attacker, u.email, PASSWORD)).status).toBe(429);
    expect((await attempt(newIp(), u.email, PASSWORD)).status).toBe(200);
  });
  it('a distributed attack (many IPs) triggers account pressure: unknown IPs are refused generically, usual IPs still work', async () => {
    const u = await createUser(s);
    const home = newIp();
    expect((await attempt(home, u.email, PASSWORD)).status).toBe(200); // trusted location recorded
    for (let i = 0; i < 14; i++) await attempt(newIp(), u.email); // 14 failures from 14 distinct IPs
    expect(Number(audits('auth.account_under_attack'))).toBeGreaterThanOrEqual(1);
    const unknownIp = await attempt(newIp(), u.email, PASSWORD);
    expect(unknownIp.status).toBe(401);
    expect(unknownIp.body.code).toBe('invalid_credentials'); // generic: not a "locked" message
    expect((await attempt(home, u.email, PASSWORD)).status).toBe(200);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE actor_user_id='${u.userId}' AND action='auth.login_blocked_account_pressure'`)).toBe('1');
  });
});

describe('layer 2: per-IP protection against volume and password spraying', () => {
  it('blocks an IP that tries many different accounts, regardless of whether they exist', async () => {
    const ip = newIp();
    let blockedAt = -1;
    for (let i = 0; i < 12; i++) {
      const r = await attempt(ip, `spray-${uniq()}@example.test`);
      if (r.status === 429 && blockedAt < 0) blockedAt = i;
    }
    expect(blockedAt).toBe(8); // 8 distinct accounts allowed, then the IP is blocked
    expect(Number(audits('auth.ip_blocked'))).toBeGreaterThanOrEqual(1);
    const u = await createUser(s);
    expect((await attempt(ip, u.email, PASSWORD)).status).toBe(429); // blocked IP is blocked for everyone
    expect((await attempt(newIp(), u.email, PASSWORD)).status).toBe(200);
  });
});

describe('no account enumeration', () => {
  it('known and unknown emails get indistinguishable responses at every stage', async () => {
    const u = await createUser(s);
    const ghost = `ghost-${uniq()}@example.test`;
    const ipK = newIp(), ipG = newIp();
    const shape = (r: { status: number; body: Record<string, unknown> }) => ({ status: r.status, code: r.body.code, title: r.body.title });
    for (let i = 0; i < 7; i++) {
      const k = await attempt(ipK, u.email), g = await attempt(ipG, ghost);
      expect(shape(k)).toEqual(shape(g));
      await wait(i < 2 ? 0 : 2 ** Math.min(i - 2, 2) * 1000 + 50);
    }
  }, 60_000);
  it('throttled responses carry no account-specific information', async () => {
    const ip = newIp(), email = `x-${uniq()}@example.test`;
    for (let i = 0; i < 3; i++) await attempt(ip, email);
    const r = await attempt(ip, email);
    expect(r.status).toBe(429);
    expect(JSON.stringify(r.body)).not.toMatch(/locked|exist|account/i);
  });
});

describe('security logging', () => {
  it('throttle decisions are audited without credentials or raw email addresses', async () => {
    const meta = adminSql(`SELECT string_agg(metadata::text, ' ') FROM audit_event WHERE action LIKE 'auth.%' AND outcome IN ('DENIED','FAILURE')`);
    expect(meta).not.toContain(PASSWORD);
    expect(meta).not.toMatch(/@example\.test/);
  });
});
