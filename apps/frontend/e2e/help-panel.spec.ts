import { expect, test, type Page } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs } from './helpers';

// Spec 051 slice H2: the help panel in a real browser, at the two widths every browser test runs at (375 and 1280 px), light and dark, by
// keyboard. The panel reads only the bundled articles, so the real e2e app is enough: nothing is served from a fixture.

const helpButton = (page: Page) => page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('button', { name: 'Help', exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Help', exact: true });

async function openHelp(page: Page, colorScheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme });
  await signInAs(page, 'alice', '/workspace');
  await expect(page.getByRole('heading', { level: 1, name: 'Your worklist' })).toBeVisible();
  await openWorkspaceNavigation(page);
  await helpButton(page).click();
  await expect(panel(page)).toBeVisible();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Help opens over the worklist in the ${colorScheme} theme: its articles, no sideways scroll, no WCAG A/AA violation`, async ({ page }) => {
    await openHelp(page, colorScheme);
    await expect(panel(page).getByRole('button', { name: 'What the home page shows', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    await panel(page).getByRole('button', { name: 'What a held result means', exact: true }).click();
    await expect(panel(page).getByText('Draft: not yet reviewed by a pharmacist.')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('every control in the help panel is a 44 px target', async ({ page }) => {
  await openHelp(page, 'light');
  const small = await panel(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('a, button, input')]
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 43.5)
      .map(({ el, rect }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(rect.height)}px`),
  );
  expect(small).toEqual([]);
});

test('by keyboard: open Help, search, open an article, and Escape returns to Help', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  await openWorkspaceNavigation(page);
  await helpButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { level: 2, name: 'Help', exact: true })).toBeFocused();
  await panel(page).getByRole('searchbox', { name: 'Search help' }).focus();
  await page.keyboard.type('held result');
  const first = panel(page).getByRole('region', { name: 'Articles' }).getByRole('button').first();
  await expect(first).toHaveText('What a held result means');
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('article', { name: 'What a held result means' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).not.toBeVisible();
  await expect(helpButton(page)).toBeFocused();
});

test('a question about a patient is refused before any search, and nothing is sent while typing', async ({ page }) => {
  await openHelp(page, 'light');
  const requests: string[] = [];
  // Only calls to the API count: the panel's code is already loaded, and nothing typed may leave the browser.
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url());
  });
  await panel(page).getByRole('searchbox', { name: 'Search help' }).fill('can my patient take clopidogrel');
  await expect(panel(page).getByRole('status')).toContainText('It does not answer questions about a patient.');
  await expect(panel(page).getByRole('region', { name: 'Articles' })).toHaveCount(0);
  expect(requests).toEqual([]);
});
