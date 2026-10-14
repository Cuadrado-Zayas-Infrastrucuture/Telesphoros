import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { selectReportsPatient, signInAs, signInWithPatient } from '../e2e/helpers';

const require = createRequire(import.meta.url);

test('real report reads filter and paginate without retaining the previous selection', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  for (let index = 0; index < 21; index++) {
    const response = await page.request.post(`${fixture.api}/api/v1/reports`, {
      headers: fixture.headers,
      data: { patientId: fixture.id, type: 'structured', filename: `synthetic-${index}.json`, sizeBytes: 2 },
    });
    expect(response.status()).toBe(201);
  }
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  await selectReportsPatient(page, fixture);
  await expect(page.getByText('Page 1 of 2. 21 records.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Open synthetic-/ })).toHaveCount(20);
  await page.getByRole('button', { name: /^Open synthetic-/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Report details' })).toBeFocused();
  await expect(page.getByText('No — not complete', { exact: true })).toBeVisible();
  const disclosure = page.locator('details').filter({ hasText: 'Technical details' });
  await expect(disclosure).not.toHaveAttribute('open');
  await disclosure.getByText('Technical details').click();
  await expect(disclosure).toHaveAttribute('open');
  await disclosure.getByText('Technical details').click();
  await page.getByRole('button', { name: 'Back to reports' }).click();
  await expect(page.getByRole('button', { name: /^Open synthetic-/ }).first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Report details' })).toBeFocused();
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const results = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return results.violations.map((violation: { id: string }) => violation.id);
  });
  expect(violations).toEqual([]);
  await page.getByRole('button', { name: 'Back to reports' }).click();
  const table = page.getByRole('region', { name: 'Report records table' });
  expect(await table.evaluate(element => element.clientHeight < element.scrollHeight)).toBe(true);
  await page.screenshot({ path: `test-results/screens/reports-${test.info().project.name}.png`, fullPage: true });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/reports?*', async route => {
    if (new URL(route.request().url()).searchParams.get('page') === '2') await held;
    await route.continue();
  });
  const tableHeight = await table.evaluate(element => element.clientHeight);
  const next = page.getByRole('button', { name: 'Next report page' });
  try {
    await next.click();
    await expect(next).toHaveAttribute('aria-disabled', 'true');
    await expect(next).toBeFocused();
    await expect(page.getByRole('button', { name: /^Open synthetic-/ })).toHaveCount(0);
    expect(await table.evaluate(element => element.clientHeight)).toBe(tableHeight);
  } finally { release(); }
  await expect(page.getByText('Page 2 of 2. 21 records.', { exact: true })).toBeVisible();
  await expect(next).toBeFocused();
  await expect(page.getByRole('button', { name: /^Open synthetic-/ })).toHaveCount(1);
  if (test.info().project.name.includes('desktop')) await expect(page.getByText('Select a report to inspect its metadata.')).toBeVisible();
  await expect(page.getByLabel('Filter by patient')).toHaveValue(fixture.id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.getByRole('heading', { level: 1 }).evaluate(element => getComputedStyle(element).fontFamily)).toContain('Inter');
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Inter');
  expect(await page.locator('header .font-heading').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Poppins');
  await page.getByRole('button', { name: 'Previous report page' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Page 1 of 2. 21 records.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous report page' })).toBeFocused();
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: /^Open synthetic-/ }).first().click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Back to reports' }).click();
});

for (const persona of ['bob', 'gina', 'carol'] as const) {
  test(`${persona} keeps existing read permissions and role-aware upload`, async ({ page }) => {
    await signInAs(page, persona, '/reports');
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh reports' })).toHaveAttribute('aria-disabled', 'false');
    await expect(page.getByRole('navigation', { name: 'Report pages' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Upload synthetic report' })).toHaveCount(persona === 'carol' ? 1 : 0);
    await expect(page.getByRole('link', { name: 'Upload report', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Local|Review queue/ })).toHaveCount(0);
    if (persona !== 'carol') {
      // A hard navigation intentionally clears in-memory credentials; sign in again for the route guard check.
      await page.context().clearCookies(); // Clear this test's fake-IdP session so its account chooser is shown again.
      await signInAs(page, persona, '/reports/upload');
      await expect(page.getByRole('heading', { name: 'You do not have access to this page' })).toBeVisible();
    }
  });
}
