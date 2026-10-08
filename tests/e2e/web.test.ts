import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect as pw } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, totpAt, totpStep } from '@uk/core';
import { startStack, uniq, PASSWORD, type Stack } from '../helpers/stack';

/**
 * Real browser, real stack: Next.js (production build) -> same-origin proxy -> NestJS API -> Postgres/Redis -> BullMQ worker.
 * Fixed ports because the web build bakes the API proxy target (default http://localhost:4000).
 */
const ROOT = resolve(__dirname, '../..');
const WEB = 'http://localhost:3000';
let stack: Stack, web: ChildProcess, browser: Browser;

function findChromium(): string | undefined {
  const cands = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'];
  return cands.find((p) => existsSync(p));
}

async function waitHttp(url: string, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`${url} did not start`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  stack = await startStack({ API_PORT: '4000' });
  await stack.app.close().catch(() => undefined); // replace the ephemeral listener with port 4000 below
  const { createApp } = await import('../../apps/api/src/bootstrap');
  stack.app = await createApp(stack.config);
  await stack.app.listen(4000, '127.0.0.1');
  if (!existsSync(resolve(ROOT, 'apps/web/.next/BUILD_ID'))) {
    execFileSync('pnpm', ['--filter', '@uk/web', 'build'], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, API_INTERNAL_URL: 'http://127.0.0.1:4000' } });
  }
  web = spawn('pnpm', ['--filter', '@uk/web', 'exec', 'next', 'start', '-p', '3000'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production' } });
  await waitHttp(WEB);
  browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
});

afterAll(async () => {
  await browser?.close();
  web?.kill('SIGTERM');
  await stack?.worker.stop();
  await stack?.app.close().catch(() => undefined);
});

const fill = async (p: Page, label: string, value: string) => p.getByLabel(label, { exact: false }).first().fill(value);

describe('browser journey: practice onboarding with MFA', () => {
  it('registers, verifies via emailed link, signs in, adds a client company, enables MFA, signs in again with a TOTP code', async () => {
    const email = `${uniq('e2e')}@example.test`;
    const ctx = await browser.newContext({ baseURL: WEB });
    const page = await ctx.newPage();

    // 1. Register as a practice
    await page.goto('/register');
    await page.getByLabel('I am registering').selectOption('PRACTICE');
    await fill(page, 'Practice name', 'E2E Accountants LLP');
    await fill(page, 'Your name', 'Eve Tester');
    await fill(page, 'Email', email);
    await fill(page, 'Password', PASSWORD);
    await page.getByRole('button', { name: 'Register' }).click();
    await pw(page.getByRole('status')).toContainText('Check your inbox');

    // 2. Email is produced asynchronously by the BullMQ worker; follow the link
    const mail = await stack.mail.waitFor(email, /Verify/);
    const link = /https?:\/\/\S+/.exec(mail.text)![0].replace('http://localhost:3000', WEB);
    await page.goto(link);
    await pw(page.getByRole('status')).toContainText('verified');

    // 3. Unverified/invalid login is rejected generically; valid login works
    await page.goto('/login');
    await fill(page, 'Email', email);
    await fill(page, 'Password', 'definitely-wrong-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await pw(page.locator('p.error[role=alert]')).toContainText('Invalid credentials');
    await fill(page, 'Password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${WEB}/`);
    await pw(page.getByRole('heading', { name: /Welcome, Eve Tester/ })).toBeVisible();

    // 4. Session cookie is httpOnly + SameSite=Strict (not readable from JS)
    const cookie = (await ctx.cookies()).find((c) => c.name === 'uk_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(await page.evaluate(() => document.cookie)).not.toContain('uk_session');

    // 5. Add a client company (cookie session + Origin check + Idempotency-Key through the proxy)
    await fill(page, 'Company name', 'Client One Ltd');
    await page.getByLabel('Company number').fill('E2E00001');
    await page.getByRole('button', { name: 'Add company' }).click();
    await pw(page.getByTestId('companies')).toContainText('Client One Ltd');
    await pw(page.getByTestId('companies')).toContainText('E2E00001');

    // 6. Enable MFA
    await page.goto('/security');
    await page.getByRole('button', { name: 'Set up' }).click();
    const secret = (await page.getByTestId('mfa-secret').textContent())!;
    expect(base32Decode(secret).length).toBe(20);
    await fill(page, 'Code', totpAt(secret, totpStep()));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await pw(page.getByText('Save these recovery codes now')).toBeVisible();
    await pw(page.locator('p.ok', { hasText: 'Enabled' })).toBeVisible();

    // 7. Sign out, then sign in requires the second step
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(`${WEB}/login`);
    await fill(page, 'Email', email);
    await fill(page, 'Password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await pw(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await fill(page, 'Code', '000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await pw(page.locator('p.error[role=alert]')).toContainText('Invalid or expired');
    await fill(page, 'Code', totpAt(secret, totpStep() + 1)); // next step: enrolment step is burned (replay protection)
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL(`${WEB}/`);
    await pw(page.getByTestId('companies')).toContainText('Client One Ltd');

    // 8. Login history is visible to the user
    await page.goto('/security');
    await pw(page.getByText('auth.login_succeeded').first()).toBeVisible();
    await ctx.close();
  });

  it('protected pages redirect anonymous visitors to sign in', async () => {
    const page = await (await browser.newContext({ baseURL: WEB })).newPage();
    await page.goto('/');
    await page.waitForURL(`${WEB}/login`);
    await pw(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  it('serves security headers on the web tier', async () => {
    const r = await fetch(WEB + '/login');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-powered-by')).toBeNull();
  });

  it('a direct business signs up through the same flow and sees "Companies"', async () => {
    const email = `${uniq('biz')}@example.test`;
    const page = await (await browser.newContext({ baseURL: WEB })).newPage();
    await page.goto('/register');
    await page.getByLabel('I am registering').selectOption('BUSINESS');
    await fill(page, 'Business name', 'Solo Widgets Ltd');
    await fill(page, 'Your name', 'Sam Solo');
    await fill(page, 'Email', email);
    await fill(page, 'Password', PASSWORD);
    await page.getByRole('button', { name: 'Register' }).click();
    const mail = await stack.mail.waitFor(email, /Verify/);
    await page.goto(/https?:\/\/\S+/.exec(mail.text)![0].replace('http://localhost:3000', WEB));
    await page.goto('/login');
    await fill(page, 'Email', email);
    await fill(page, 'Password', PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${WEB}/`);
    await pw(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
    await pw(page.getByText('Solo Widgets Ltd (business, Owner)')).toBeAttached();
  });
});
