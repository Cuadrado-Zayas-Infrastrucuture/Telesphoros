import { expect, test, type Page } from '@playwright/test';
import { axeViolations, signInAs } from './helpers';

const DARK_BACKGROUND = 'rgb(27, 30, 32)'; // --background in the dark theme (tokens.css, #1B1E20)
const LIGHT_BACKGROUND = 'rgb(245, 247, 247)'; // #F5F7F7
const pageBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? 'light');
/** As if Dark had been chosen in an earlier visit: the saved word is all that persists. */
const savedDark = (page: Page) => page.addInitScript(() => window.localStorage.setItem('telesphoros.theme', 'dark'));

test('choosing Dark in Settings turns the page dark at once, and Light turns it back', async ({ page }) => {
  await signInAs(page, 'alice', '/settings');
  const appearance = page.getByRole('region', { name: 'Appearance' });
  // The radios are visually hidden inside picture cards; a person clicks the card, so the test does too.
  const card = (id: string) => appearance.locator('label', { has: page.locator(`#theme-${id}`) });
  await card('dark').click();
  await expect(appearance.getByRole('radio', { name: /^Dark/ })).toBeChecked();
  expect(await theme(page)).toBe('dark');
  expect(await pageBackground(page)).toBe(DARK_BACKGROUND);
  await card('light').click();
  await expect(appearance.getByRole('radio', { name: /^Light/ })).toBeChecked();
  expect(await pageBackground(page)).toBe(LIGHT_BACKGROUND);
});

for (const path of ['/settings', '/reports/upload', '/reports']) {
  test(`${path} has no WCAG A/AA violations in the dark theme (incl. colour contrast)`, async ({ page }) => {
    await savedDark(page);
    await signInAs(page, 'alice', path);
    await page.waitForLoadState('networkidle');
    expect(await theme(page)).toBe('dark');
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('the device setting is followed while Settings says "Match this device"', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signInAs(page, 'alice', '/settings');
  expect(await theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light');
});

test('the public home page stays light even with Dark saved', async ({ page }) => {
  await savedDark(page);
  await page.goto('/');
  await expect(page.locator('.landing-hero')).toBeVisible();
  expect(await theme(page)).toBe('light');
  expect(await pageBackground(page)).toBe(LIGHT_BACKGROUND);
});
