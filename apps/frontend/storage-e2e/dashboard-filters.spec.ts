import { expect, test } from '@playwright/test';
import { openWorkspaceNavigation, selectReportsPatient, signInWithPatient } from '../e2e/helpers';

test('report filters show their page scope, combine and reset with keyboard access', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  for (const filename of ['page-guide-a.json', 'page-guide-b.json']) {
    const response = await page.request.post(`${fixture.api}/api/v1/reports`, { headers: fixture.headers, data: { patientId: fixture.id, type: 'structured', filename, sizeBytes: 2 } });
    expect(response.status()).toBe(201);
  }
  await openWorkspaceNavigation(page);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await selectReportsPatient(page, fixture);
  const disclosure = page.getByText('Search and filter this page', { exact: true });
  await disclosure.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Filename on this page')).toBeVisible();
  await page.getByLabel('Filename on this page').fill('GUIDE-A');
  await expect(page.getByText('1 of 2 records on this page.', { exact: true })).toBeVisible();
  await page.getByLabel('Storage upload').selectOption('verified');
  await expect(page.getByRole('heading', { name: 'No matches on this page' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset page filters' }).click();
  await expect(page.getByRole('button', { name: /^Open page-guide-/ })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/screens/report-filters-${test.info().project.name}.png`, fullPage: true });
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
