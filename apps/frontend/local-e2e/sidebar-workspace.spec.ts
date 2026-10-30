import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNavigation, signInAs } from '../e2e/helpers';
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
test('wide Prompt Kit conversation keeps evidence in a keyboard-accessible drawer', async ({ page }, info) => {
  await signInAs(page, 'alice', '/local-interpretation');
  await expect(page.getByRole('heading', { name: 'Chat workspace' })).toBeVisible();
  const network: string[] = [];
  page.on('request', request => { if (['fetch', 'xhr', 'websocket'].includes(request.resourceType())) network.push(request.url()); });
  const conversation = page.getByRole('region', { name: 'Explanation conversation' });
  if (info.project.name.includes('desktop')) expect((await conversation.boundingBox())!.width).toBeGreaterThan(800);
  await accessible(page);
  await page.screenshot({ path: `test-results/screens/sidebar-chat-empty-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Explain this example', exact: true }).click();
  await expect(page.getByText(/No genotype, phenotype/)).toBeVisible();
  await page.screenshot({ path: `test-results/screens/sidebar-chat-output-${info.project.name}.png`, fullPage: true });
  const evidence = page.getByRole('button', { name: 'View response evidence' });
  await evidence.click();
  const drawer = page.getByRole('dialog', { name: 'Report details & evidence' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Report details & evidence' })).toBeFocused();
  await expect(drawer.getByText(/not a clinical citation/)).toBeVisible();
  await accessible(page);
  for (let count = 0; count < 12; count++) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.screenshot({ path: `test-results/screens/sidebar-evidence-${info.project.name}.png`, fullPage: false });
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible(); await expect(evidence).toBeFocused();
  await expect(page.getByText(/No genotype, phenotype/)).toBeVisible();
  expect(network).toEqual([]);
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  await accessible(page);
});
// Since 2026-10-27 Reports is in every build; only file download needs owned storage.
test('report navigation is offered without owned storage, beside the local previews', async ({ page }) => {
  await signInAs(page, 'alice', '/local-interpretation');
  await openWorkspaceNavigation(page);
  await expect(page.getByRole('link', { name: 'All reports', exact: true })).toHaveAttribute('href', '/reports');
  await expect(page.getByRole('link', { name: 'Chat preview', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Upload report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Upload report', exact: true })).toBeVisible();
});
