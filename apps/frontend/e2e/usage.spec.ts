import { expect, test, type Page } from '@playwright/test';
import { axeViolations, signInAs } from './helpers';

const savedDark = (page: Page) => page.addInitScript(() => window.localStorage.setItem('telesphoros.theme', 'dark'));

test('an administrator reads usage from the real API: two named months and storage', async ({ page }) => {
  await signInAs(page, 'carol', '/usage');
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toHaveCSS('text-wrap-style', 'balance');
  await expect(page.getByText("Your organization's activity and storage. Months are in Puerto Rico time.")).toHaveCSS('text-wrap-style', 'pretty');
  await expect(page.getByRole('region', { name: 'Storage' }).locator('p').first()).toHaveCSS('text-wrap-style', 'pretty');
  await expect(page.getByRole('region', { name: /, so far$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Storage' }).getByText('Report files', { exact: true })).toBeVisible();
  for (const value of await page.getByRole('region', { name: 'Storage' }).locator('dd').all()) {
    await expect(value).toHaveCSS('font-variant-numeric', /tabular-nums/);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an administrator reads the calendar from the real API: this year, each day named, and the month table (spec 028)', async ({ page }) => {
  await signInAs(page, 'carol', '/usage');
  const calendar = page.getByRole('region', { name: 'Reports uploaded per day' });
  const grid = calendar.getByRole('grid');
  await expect(grid).toBeVisible();
  const year = new Date().getUTCFullYear();
  await expect(calendar.getByRole('table', { name: new RegExp(`^Reports uploaded per month, (${year}|${year - 1})$`) })).toBeVisible();
  await expect(calendar.getByRole('table').getByRole('row')).toHaveCount(13);
  await expect(calendar.getByRole('table').locator('td').first()).toHaveCSS('font-variant-numeric', /tabular-nums/);
  await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const dark of [false, true]) {
  test(`the Usage page has no WCAG A/AA violations in the ${dark ? 'dark' : 'light'} theme`, async ({ page }) => {
    if (dark) await savedDark(page);
    await signInAs(page, 'carol', '/usage');
    await expect(page.getByRole('region', { name: 'Storage' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Reports uploaded per day' }).getByRole('grid')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('a clinician is offered no Usage link, and /usage refuses them without asking the API', async ({ page }) => {
  const usageRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/usage') usageRequests.push(request.url());
  });
  await signInAs(page, 'alice', '/usage');
  await expect(page.getByRole('heading', { level: 1, name: 'You do not have access to this page' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Usage', exact: true })).toHaveCount(0);
  expect(usageRequests).toEqual([]);
});
