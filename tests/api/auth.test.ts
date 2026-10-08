import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt, totpStep } from '@uk/core';
import { ORIGIN, PASSWORD, bearer, createUser, startStack, uniq, type Stack } from '../helpers/stack';
import { adminSql } from '../helpers/db';

let s: Stack;
beforeAll(async () => { s = await startStack({ TRUST_PROXY_HOPS: '1' }); });
afterAll(() => s.stop());

const post = (path: string, body: unknown, extra: Record<string, string> = {}) => s.api().post(`/api/v1${path}`).set('Origin', ORIGIN).set(extra).send(body as object);
const login = (email: string, password = PASSWORD) => post('/auth/login/bearer', { email, password });

describe('registration & email verification', () => {
  it('creates user + organisation + owner membership and sends a verification email via the job queue', async () => {
    const u = await createUser(s, { type: 'PRACTICE', orgName: 'Smith & Co Accountants' });
    const me = await s.api().get('/api/v1/auth/me').set(bearer(u.token));
    expect(me.body.organisations).toHaveLength(1);
    expect(me.body.organisations[0]).toMatchObject({ name: 'Smith & Co Accountants', type: 'PRACTICE', role: 'owner' });
    expect(me.body.mfa.enabled).toBe(false);
  });
  it('supports a direct business organisation (same architecture)', async () => {
    const u = await createUser(s, { type: 'BUSINESS' });
    const me = await s.api().get('/api/v1/auth/me').set(bearer(u.token));
    expect(me.body.organisations[0].type).toBe('BUSINESS');
  });
  it('stores the password as an argon2id hash and the token only as a hash', async () => {
    const u = await createUser(s);
    expect(adminSql(`SELECT password_hash FROM "user" WHERE email='${u.email}'`)).toMatch(/^\$argon2id\$/);
    const mail = await s.mail.waitFor(u.email, /Verify/);
    const tok = s.mail.tokenFrom(mail.text);
    expect(adminSql(`SELECT count(*) FROM auth_token WHERE token_hash='${tok}'`)).toBe('0');
  });
  it('cannot sign in before verifying the email', async () => {
    const email = `${uniq()}@example.test`;
    await post('/auth/register', { email, password: PASSWORD, displayName: 'N', organisationName: 'O', organisationType: 'BUSINESS' });
    const r = await login(email);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('email_not_verified');
  });
  it('verification tokens are single-use', async () => {
    const email = `${uniq()}@example.test`;
    await post('/auth/register', { email, password: PASSWORD, displayName: 'N', organisationName: 'O', organisationType: 'BUSINESS' });
    const token = s.mail.tokenFrom((await s.mail.waitFor(email, /Verify/)).text);
    expect((await post('/auth/verify-email', { token })).status).toBe(200);
    const again = await post('/auth/verify-email', { token });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('invalid_token');
  });
  it('rejects forged / unknown tokens', async () => {
    expect((await post('/auth/verify-email', { token: 'x'.repeat(43) })).status).toBe(400);
  });
  it('enforces the password policy', async () => {
    const r = await post('/auth/register', { email: `${uniq()}@example.test`, password: 'short', displayName: 'N', organisationName: 'O', organisationType: 'BUSINESS' });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].path).toBe('password');
  });
  it('is enumeration-safe: registering an existing email looks identical and emails the owner', async () => {
    const u = await createUser(s);
    const r = await post('/auth/register', { email: u.email, password: PASSWORD, displayName: 'Dup', organisationName: 'Dup', organisationType: 'BUSINESS' });
    const fresh = await post('/auth/register', { email: `${uniq()}@example.test`, password: PASSWORD, displayName: 'N', organisationName: 'O', organisationType: 'BUSINESS' });
    expect(r.status).toBe(fresh.status);
    expect(r.body).toEqual(fresh.body);
    expect((await s.mail.waitFor(u.email, /already have an account/)).subject).toBeTruthy();
    expect(adminSql(`SELECT count(*) FROM membership m JOIN "user" x ON x.id=m.user_id WHERE x.email='${u.email}'`)).toBe('1');
  });
});

describe('login, lockout, audit trail', () => {
  it('rejects bad credentials with one generic error for unknown users and wrong passwords', async () => {
    const u = await createUser(s);
    const wrong = await login(u.email, 'wrong-password-123');
    const unknown = await login(`nobody-${uniq()}@example.test`, 'wrong-password-123');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe(unknown.body.code);
    expect(wrong.body.title).toBe(unknown.body.title);
  });
  it('repeated failures never lock the real owner out (anti-DoS); see login-throttle.test.ts for layers', async () => {
    const u = await createUser(s);
    for (let i = 0; i < 12; i++) await login(u.email, 'bad-password-1234');
    // the attacker's own (IP, email) pair is blocked ...
    expect((await login(u.email, PASSWORD)).status).toBe(429);
    // ... but the owner signing in from another address is untouched
    const owner = await s.api().post('/api/v1/auth/login/bearer').set('Origin', ORIGIN).set('X-Forwarded-For', '203.0.113.77').send({ email: u.email, password: PASSWORD });
    expect(owner.status).toBe(200);
  });
  it('writes a login audit trail visible to the user (success + failure) with no secrets', async () => {
    const u = await createUser(s);
    await login(u.email, 'bad-password-1234');
    const hist = await s.api().get('/api/v1/auth/login-history').set(bearer(u.token));
    const actions = hist.body.items.map((i: { action: string }) => i.action);
    expect(actions).toContain('auth.login_succeeded');
    expect(actions).toContain('auth.login_failed');
    expect(JSON.stringify(adminSql(`SELECT metadata FROM audit_event WHERE actor_user_id='${u.userId}'`))).not.toContain(PASSWORD);
  });
  it('sets an httpOnly, SameSite=Strict session cookie for browser logins', async () => {
    const u = await createUser(s);
    const r = await post('/auth/login', { email: u.email, password: PASSWORD });
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/uk_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(r.body.sessionToken).toBeUndefined(); // never exposed to JS
  });
});

describe('sessions', () => {
  it('logout revokes the session immediately', async () => {
    const u = await createUser(s);
    expect((await s.api().post('/api/v1/auth/logout').set(bearer(u.token))).status).toBe(204);
    expect((await s.api().get('/api/v1/auth/me').set(bearer(u.token))).status).toBe(401);
  });
  it('rejects missing/garbage tokens', async () => {
    expect((await s.api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await s.api().get('/api/v1/auth/me').set('Authorization', 'Bearer nope')).status).toBe(401);
  });
  it('lists sessions and revokes another one', async () => {
    const u = await createUser(s);
    const second = (await login(u.email)).body.sessionToken as string;
    const list = await s.api().get('/api/v1/auth/sessions').set(bearer(u.token));
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    const other = list.body.items.find((i: { current: boolean }) => !i.current);
    expect((await s.api().delete(`/api/v1/auth/sessions/${other.id}`).set(bearer(u.token))).status).toBe(204);
    const stillFirst = await s.api().get('/api/v1/auth/me').set(bearer(u.token));
    const secondNow = await s.api().get('/api/v1/auth/me').set(bearer(second));
    expect([stillFirst.status, secondNow.status].sort()).toEqual([200, 401]);
  });
  it('idle and absolute expiry are enforced server-side', async () => {
    const u = await createUser(s);
    adminSql(`UPDATE session SET idle_expires_at = now() - interval '1 second' WHERE user_id='${u.userId}'`);
    expect((await s.api().get('/api/v1/auth/me').set(bearer(u.token))).status).toBe(401);
    const u2 = await createUser(s);
    adminSql(`UPDATE session SET absolute_expires_at = now() - interval '1 second' WHERE user_id='${u2.userId}'`);
    expect((await s.api().get('/api/v1/auth/me').set(bearer(u2.token))).status).toBe(401);
  });
  it('a disabled user is signed out everywhere', async () => {
    const u = await createUser(s);
    adminSql(`UPDATE "user" SET status='DISABLED' WHERE id='${u.userId}'`);
    expect((await s.api().get('/api/v1/auth/me').set(bearer(u.token))).status).toBe(401);
    expect((await login(u.email)).status).toBe(401);
  });
  it('session tokens are stored hashed', async () => {
    const u = await createUser(s);
    expect(adminSql(`SELECT count(*) FROM session WHERE token_hash='${u.token}'`)).toBe('0');
  });
});

describe('password reset & change', () => {
  it('forgot-password is enumeration-safe', async () => {
    const u = await createUser(s);
    const a = await post('/auth/forgot-password', { email: u.email });
    const b = await post('/auth/forgot-password', { email: `ghost-${uniq()}@example.test` });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
  });
  it('reset token is single-use, expires, and revokes all sessions', async () => {
    const u = await createUser(s);
    await post('/auth/forgot-password', { email: u.email });
    const token = s.mail.tokenFrom((await s.mail.waitFor(u.email, /Reset/)).text);
    expect((await post('/auth/reset-password', { token, newPassword: 'Another-strong-passphrase-2' })).status).toBe(200);
    expect((await s.api().get('/api/v1/auth/me').set(bearer(u.token))).status).toBe(401);
    expect((await post('/auth/reset-password', { token, newPassword: 'Yet-another-passphrase-3' })).status).toBe(400);
    expect((await login(u.email, PASSWORD)).status).toBe(401);
  });
  it('expired reset tokens are refused', async () => {
    const u = await createUser(s);
    await post('/auth/forgot-password', { email: u.email });
    const token = s.mail.tokenFrom((await s.mail.waitFor(u.email, /Reset/)).text);
    adminSql(`UPDATE auth_token SET expires_at = now() - interval '1 minute' WHERE user_id='${u.userId}' AND purpose='PASSWORD_RESET'`);
    expect((await post('/auth/reset-password', { token, newPassword: 'Another-strong-passphrase-2' })).status).toBe(400);
  });
  it('change-password needs the current password and revokes other sessions', async () => {
    const u = await createUser(s);
    const other = (await login(u.email)).body.sessionToken as string;
    const bad = await s.api().post('/api/v1/auth/change-password').set(bearer(u.token)).send({ currentPassword: 'nope-nope-nope-1', newPassword: 'Yet-another-passphrase-3' });
    expect(bad.status).toBe(401);
    const ok = await s.api().post('/api/v1/auth/change-password').set(bearer(u.token)).send({ currentPassword: PASSWORD, newPassword: 'Yet-another-passphrase-3' });
    expect(ok.status).toBe(200);
    expect((await s.api().get('/api/v1/auth/me').set(bearer(u.token))).status).toBe(200);
    expect((await s.api().get('/api/v1/auth/me').set(bearer(other))).status).toBe(401);
  });
});

describe('MFA (TOTP)', () => {
  async function enrolled() {
    const u = await createUser(s);
    const enrol = await s.api().post('/api/v1/auth/mfa/enroll').set(bearer(u.token));
    expect(enrol.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const secret = enrol.body.secret as string;
    const step = totpStep();
    const confirm = await s.api().post('/api/v1/auth/mfa/confirm').set(bearer(u.token)).send({ code: totpAt(secret, step) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    return { u, secret, recovery: confirm.body.recoveryCodes as string[], usedStep: step };
  }
  it('secret is encrypted at rest', async () => {
    const { u, secret } = await enrolled();
    const stored = adminSql(`SELECT secret_encrypted FROM mfa_factor WHERE user_id='${u.userId}' AND status='ACTIVE'`);
    expect(stored).not.toContain(secret);
    expect(stored.startsWith('v1:')).toBe(true);
  });
  it('rejects a wrong code during enrolment and activates nothing', async () => {
    const u = await createUser(s);
    await s.api().post('/api/v1/auth/mfa/enroll').set(bearer(u.token));
    const bad = await s.api().post('/api/v1/auth/mfa/confirm').set(bearer(u.token)).send({ code: '000000' });
    expect(bad.status).toBe(400);
    expect((await s.api().get('/api/v1/auth/mfa').set(bearer(u.token))).body.enabled).toBe(false);
  });
  it('login then requires the second factor; session only after valid code; replayed code rejected', async () => {
    const { u, secret, usedStep } = await enrolled();
    const first = await login(u.email);
    expect(first.body.mfaRequired).toBe(true);
    expect(first.body.sessionToken).toBeUndefined();
    const ch = first.body.challengeToken as string;
    expect((await post('/auth/login/mfa/bearer', { challengeToken: ch, code: '000000' })).status).toBe(401);
    // the step used while enrolling is burned (replay protection)
    expect((await post('/auth/login/mfa/bearer', { challengeToken: ch, code: totpAt(secret, usedStep) })).status).toBe(401);
    const ok = await post('/auth/login/mfa/bearer', { challengeToken: ch, code: totpAt(secret, usedStep + 1) });
    expect(ok.status).toBe(200);
    const me = await s.api().get('/api/v1/auth/me').set(bearer(ok.body.sessionToken));
    expect(me.status).toBe(200);
    expect(me.body.mfa.enabled).toBe(true);
    // challenge cannot be reused
    expect((await post('/auth/login/mfa/bearer', { challengeToken: ch, code: totpAt(secret, usedStep + 1) })).status).toBe(401);
  });
  it('challenge dies after 5 wrong codes', async () => {
    const { u, secret, usedStep } = await enrolled();
    const ch = (await login(u.email)).body.challengeToken as string;
    for (let i = 0; i < 5; i++) await post('/auth/login/mfa/bearer', { challengeToken: ch, code: '111111' });
    expect((await post('/auth/login/mfa/bearer', { challengeToken: ch, code: totpAt(secret, usedStep + 1) })).status).toBe(401);
  });
  it('recovery codes work exactly once', async () => {
    const { u, recovery } = await enrolled();
    const c1 = (await login(u.email)).body.challengeToken as string;
    expect((await post('/auth/login/mfa/bearer', { challengeToken: c1, code: recovery[0]! })).status).toBe(200);
    const c2 = (await login(u.email)).body.challengeToken as string;
    expect((await post('/auth/login/mfa/bearer', { challengeToken: c2, code: recovery[0]! })).status).toBe(401);
  });
  it('disabling needs password + a valid factor, then login is single-step again', async () => {
    const { u, recovery } = await enrolled();
    const bad = await s.api().post('/api/v1/auth/mfa/disable').set(bearer(u.token)).send({ currentPassword: 'wrong-wrong-1234', code: recovery[0] });
    expect(bad.status).toBe(401);
    const ok = await s.api().post('/api/v1/auth/mfa/disable').set(bearer(u.token)).send({ currentPassword: PASSWORD, code: recovery[1] });
    expect(ok.status).toBe(204);
    expect((await login(u.email)).body.mfaRequired).toBe(false);
  });
  it('MFA events are audited', async () => {
    const { u } = await enrolled();
    const actions = adminSql(`SELECT action FROM audit_event WHERE actor_user_id='${u.userId}'`);
    expect(actions).toContain('mfa.enrolment_started');
    expect(actions).toContain('mfa.enabled');
  });
});

describe('identity provider seam', () => {
  it('rejects unknown providers instead of falling back', async () => {
    const svc = s.app.get((await import('../../apps/api/src/auth/auth.service')).AuthService);
    await expect(svc.signIn('entra-id', {})).rejects.toMatchObject({ code: 'unknown_provider' });
  });
});
