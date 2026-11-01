import { expect, test, type Page } from '@playwright/test';
import { axeViolations, signInAs } from './helpers';

/** Holds `/api/v1/usage` unanswered, so the loading state stays on screen. */
const holdUsage = (page: Page) => page.route('**/api/v1/usage', () => new Promise<void>(() => {}));

for (const dark of [false, true]) {
  test(`while usage loads, the page keeps its shape, announces it once, and has no WCAG A/AA violations (${dark ? 'dark' : 'light'})`, async ({ page }, info) => {
    if (dark) await page.addInitScript(() => { window.localStorage.setItem('telesphoros.storage-consent.v1', JSON.stringify({ version: 1, preferences: true })); window.localStorage.setItem('telesphoros.theme', 'dark'); });
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

// Inspect the animation timeline directly: no wall-clock sleep or race with a fast API response.
test('placeholders remain hidden through 250ms and appear after 300ms', async ({ page }) => {
  await holdUsage(page);
  await signInAs(page, 'carol', '/usage');
  const block = page.locator('[data-slot="skeleton"]').first();
  const seek = async (time: number) => block.evaluate((element, elapsed) => {
    const appear = element.getAnimations().find((animation) => animation instanceof CSSAnimation && animation.animationName === 'skeleton-appear');
    if (!appear) throw new Error('The loading placeholder has no appearance animation.');
    appear.pause();
    appear.currentTime = elapsed;
  }, time);
  await seek(250);
  await expect(block).toHaveCSS('opacity', '0');
  await seek(301);
  await expect(block).toHaveCSS('opacity', '1');
});

test('loading and loaded usage share card rows and storage position', async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/usage', async (route) => {
    const response = await route.fetch();
    await ready;
    await route.fulfill({ response });
  });
  await signInAs(page, 'carol', '/usage');
  // Use the heading's section so card internals can change without changing this assertion.
  const section = page.locator('#usage-storage').locator('xpath=ancestor::section[1]');
  await expect(section.locator('[data-slot="skeleton"]')).toHaveCount(2);
  const before = await section.boundingBox();
  release();
  await expect(page.getByRole('region', { name: 'Storage' })).toBeVisible();
  await expect(section.locator('[data-slot="skeleton"]')).toHaveCount(0);
  const after = await section.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
});
