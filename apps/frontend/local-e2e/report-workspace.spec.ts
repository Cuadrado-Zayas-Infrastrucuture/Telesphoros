import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNavigation, selectReportsPatient, signInWithPatient } from '../e2e/helpers';
const require = createRequire(import.meta.url);
async function accessible(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected for browser acceptance only
    return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
test('report selection opens a drawer and restores the row focus without replacing the list', async ({ page }, info) => {
  const fixture = await signInWithPatient(page);
  const response = await page.request.post(`${fixture.api}/api/v1/reports`, { headers: fixture.headers, data: { patientId: fixture.id, type: 'structured', filename: 'sidebar-synthetic.json', sizeBytes: 2 } });
  expect(response.status()).toBe(201);
  await openWorkspaceNavigation(page); await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await selectReportsPatient(page, fixture);
  const row = page.getByRole('button', { name: 'Open sidebar-synthetic.json' });
  await row.click();
  const drawer = page.getByRole('dialog', { name: 'Report details', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('No — not complete')).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: `test-results/screens/sidebar-report-${info.project.name}.png`, fullPage: false });
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible(); await expect(row).toBeFocused();
  for (let cycle = 0; cycle < 3; cycle++) {
    await row.click(); await expect(drawer).toBeVisible();
    await page.getByRole('button', { name: 'Back to reports' }).click();
    await expect(drawer).not.toBeVisible(); await expect(row).toBeFocused();
  }
  await openWorkspaceNavigation(page); await page.getByRole('link', { name: 'Chat preview', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Sample question' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await accessible(page);
});
