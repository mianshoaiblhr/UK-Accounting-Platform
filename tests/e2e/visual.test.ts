import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, makeCompany, type Stack, type TestUser } from '../helpers/stack';
import { WEB, signIn, startWeb, stopWeb, type WebStack } from '../helpers/web';

/**
 * UI-1 (DEC-076; docs/design/visual-system.md §4 and §6): the visual system's quality floor, in a real browser over the real stack.
 * Keyboard focus is visible (a 2px outline), reduced motion is respected, the sidebar sits outside `main`, and a phone-width page
 * never scrolls sideways (wide tables scroll inside their sheet). Synthetic data only.
 */
let w: WebStack, stack: Stack, browser: Browser, owner: TestUser;
let company: { id: string };

describe('UI-1 visual system', () => {
  beforeAll(async () => {
    w = await startWeb();
    ({ stack, browser } = w);
    owner = await createUser(stack, { type: 'PRACTICE' });
    company = await makeCompany(stack, owner, 'Visual Check Ltd');
  });
  afterAll(async () => { await stopWeb(w ?? {}); });

  it('shows keyboard focus as a 2px outline and has no motion when reduced motion is asked for', async () => {
    const ctx = await browser.newContext({ baseURL: WEB, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement!);
      return { tag: document.activeElement!.tagName, style: s.outlineStyle, width: s.outlineWidth };
    });
    expect(focus.tag).not.toBe('BODY');
    expect(focus).toMatchObject({ style: 'solid', width: '2px' });
    const motion = await page.evaluate(() => getComputedStyle(document.querySelector('button')!).transitionDuration);
    expect(motion).toBe('0s');
    await ctx.close();
  });

  it('keeps the sidebar outside main, and a phone-width workspace never scrolls sideways', async () => {
    const page = await signIn(browser, owner.email);
    await page.goto(`${WEB}/org/${owner.organisationId}/companies/${company.id}/trial-balance`);
    const nav = page.getByRole('navigation', { name: 'Bookkeeping' });
    await nav.waitFor();
    expect(await page.locator('main nav[aria-label=Bookkeeping]').count()).toBe(0);
    expect(await page.locator('aside').getByRole('button', { name: 'Sign out' }).count()).toBe(1);
    expect(await nav.getByRole('link', { name: 'Trial balance', exact: true }).getAttribute('aria-current')).toBe('page');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(100);
      const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(scroll, `page scrolls sideways at ${width}px`).toBeLessThanOrEqual(client);
    }
    await page.context().close();
  });
});
