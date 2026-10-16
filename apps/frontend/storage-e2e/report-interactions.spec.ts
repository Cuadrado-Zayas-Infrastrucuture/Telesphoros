import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { openWorkspaceNavigation, selectReportsPatient, signInWithPatient } from '../e2e/helpers';

test('report loading preserves layout and focus, honors reduced motion and recovers from a failed read', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const created = await page.request.post(`${fixture.api}/api/v1/reports`, { headers: fixture.headers, data: { patientId: fixture.id, type: 'structured', filename: 'synthetic-interaction.json', sizeBytes: 2 } });
  expect(created.status()).toBe(201);
  for (const filename of ['synthetic-panel-a.json', 'synthetic-panel-b.json', 'synthetic-pharmacogenomics.json', 'synthetic-source-summary.json']) {
    const extra = await page.request.post(`${fixture.api}/api/v1/reports`, { headers: fixture.headers, data: { patientId: fixture.id, type: 'structured', filename, sizeBytes: 2 } });
    expect(extra.status()).toBe(201);
  }
  // The application intentionally keeps its session in memory; use its own navigation.
  await openWorkspaceNavigation(page);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await selectReportsPatient(page, fixture);
  const report = page.getByRole('button', { name: 'Open synthetic-interaction.json', exact: true });
  await expect(report).toBeVisible();
  await page.screenshot({ path: `test-results/report-list-${test.info().project.name}.png`, fullPage: true });
  await report.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Report details', exact: true })).toBeFocused();
  await page.screenshot({ path: `test-results/report-detail-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Back to reports' }).click();
  await expect(report).toBeFocused();
  const table = page.getByRole('region', { name: 'Report records table' });
  const before = await table.boundingBox();
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route('**/api/v1/reports?*', async route => {
    reads++;
    await pending;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'private-response-must-not-render' }) });
  });
  const refresh = page.getByRole('button', { name: 'Refresh reports', exact: true });
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(table).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Loading reports…' })).toHaveCount(1);
  await expect(table.getByRole('button')).toHaveCount(0);
  await expect(refresh).toBeFocused();
  const disabledColor = await refresh.evaluate(el => getComputedStyle(el).backgroundColor);
  await refresh.hover();
  expect(await refresh.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(disabledColor);
  await page.keyboard.press('Enter');
  expect(reads).toBe(1);
  expect((await table.boundingBox())?.height).toBe(before?.height);
  const skeleton = table.locator('tbody[aria-hidden="true"]');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await skeleton.evaluate(el => getComputedStyle(el).animationName)).toBe('pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await skeleton.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injected into this local synthetic browser test
    return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await page.getByRole('button').all()) {
    if (!(await button.isVisible())) continue;
    const bounds = await button.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `test-results/report-loading-${test.info().project.name}.png`, fullPage: true });
  release();
  await expect(page.getByRole('alert')).toContainText('Reports could not be loaded');
  await expect(page.getByText('private-response-must-not-render')).toHaveCount(0);
  await page.screenshot({ path: `test-results/report-error-${test.info().project.name}.png`, fullPage: true });
  await page.unroute('**/api/v1/reports?*');
  await page.getByRole('button', { name: 'Retry loading reports' }).click();
  await expect(report).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Report records', exact: true })).toBeFocused();
  await expect(page.getByLabel('Filter by patient')).toHaveValue(fixture.id);
  await page.getByRole('button', { name: 'Clear patient filter' }).click();
  await expect(page.getByLabel('Filter by patient')).toHaveValue('');
  await expect(table).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Report records', exact: true })).toBeFocused();
});
