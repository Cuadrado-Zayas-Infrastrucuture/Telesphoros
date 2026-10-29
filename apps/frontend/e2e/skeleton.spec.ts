import { expect, test, type Page } from '@playwright/test';
import { axeViolations, signInAs } from './helpers';

/** Holds `/api/v1/usage` unanswered, so the loading state stays on screen. */
const holdUsage = (page: Page) => page.route('**/api/v1/usage', () => new Promise<void>(() => {}));

for (const dark of [false, true]) {
  test(`while usage loads, the page keeps its shape, announces it once, and has no WCAG A/AA violations (${dark ? 'dark' : 'light'})`, async ({ page }, info) => {
    if (dark) await page.addInitScript(() => window.localStorage.setItem('telesphoros.theme', 'dark'));
    await holdUsage(page);
    await signInAs(page, 'carol', '/usage');
    await expect(page.getByRole('status').filter({ hasText: 'Loading usage…' })).toHaveCount(1);
    // Placeholders appear only after the delay, then stay.
    await expect(page.locator('[data-slot="skeleton"]').first()).toHaveCSS('opacity', '1');
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: `test-results/skeleton/usage-loading-${dark ? 'dark' : 'light'}-${info.project.name}.png`, fullPage: true });
  });
}

test('with reduced motion the placeholders still appear, without the sweep', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await holdUsage(page);
  await signInAs(page, 'carol', '/usage');
  const block = page.locator('[data-slot="skeleton"]').first();
  await expect(block).toHaveCSS('opacity', '1');
  await expect(block).toHaveCSS('background-image', 'none');
});
