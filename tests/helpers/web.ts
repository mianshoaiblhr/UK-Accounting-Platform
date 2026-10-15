import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { PASSWORD, startStack, type Stack } from './stack';

/**
 * Real browser, real stack: Next.js (production build) -> same-origin proxy -> NestJS API -> Postgres/Redis -> BullMQ worker.
 * Fixed ports because the web build bakes the API proxy target (default http://localhost:4000).
 */
export const ROOT = resolve(__dirname, '../..');
export const WEB = 'http://localhost:3000';
export interface WebStack { stack: Stack; web: ChildProcess; browser: Browser }

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

/** Newest modification time under a directory (the web sources), to tell whether the production build is older than the code it should serve. */
function newest(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

export async function startWeb(): Promise<WebStack> {
  const stack = await startStack({ API_PORT: '4000' });
  await stack.app.close().catch(() => undefined); // replace the ephemeral listener with port 4000 below
  const { createApp } = await import('../../apps/api/src/bootstrap');
  stack.app = await createApp(stack.config);
  await stack.app.listen(4000, '127.0.0.1');
  const buildId = resolve(ROOT, 'apps/web/.next/BUILD_ID');
  // a build older than the screens it should serve would hide new pages: rebuild when any web source is newer
  if (!existsSync(buildId) || statSync(buildId).mtimeMs < newest(resolve(ROOT, 'apps/web/src'))) {
    execFileSync('pnpm', ['--filter', '@uk/web', 'build'], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, API_INTERNAL_URL: 'http://127.0.0.1:4000' } });
  }
  const web = spawn('pnpm', ['--filter', '@uk/web', 'exec', 'next', 'start', '-p', '3000'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production' } });
  await waitHttp(WEB);
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  return { stack, web, browser };
}

export async function stopWeb(w: Partial<WebStack>) {
  await w.browser?.close();
  if (w.web) {
    const exited = new Promise((r) => w.web!.once('exit', r));
    w.web.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  await w.stack?.worker.stop();
  await w.stack?.app.close().catch(() => undefined);
}

export const fill = async (p: Page, label: string, value: string) => p.getByLabel(label, { exact: false }).first().fill(value);

/** Signs a verified user in through the login screen; returns the page on the home screen. */
export async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL: WEB })).newPage();
  await page.goto('/login');
  await fill(page, 'Email', email);
  await fill(page, 'Password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${WEB}/`);
  return page;
}
