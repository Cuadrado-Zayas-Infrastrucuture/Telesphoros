import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNavigation, signInAs } from '../e2e/helpers';
const require = createRequire(import.meta.url);
async function accessible(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected for browser acceptance only
    const result = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return result.violations.map((item: { id: string }) => item.id);
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function evidence(page: Page) {
  await page.getByRole('button', { name: 'Report details & evidence', exact: true }).click();
  return page.getByRole('dialog', { name: 'Report details & evidence', exact: true });
}
async function closeEvidence(page: Page) { await page.getByRole('button', { name: 'Close report details & evidence', exact: true }).click(); }
async function ask(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.isVisible())) await page.getByText('Questions', { exact: true }).click();
  await button.click();
}
test('branded synthetic explanation supports keyboard, recovery, stop, reset and no requests', async ({ page }, info) => {
  await signInAs(page, 'alice', '/local-interpretation');
  await expect(page.getByRole('heading', { name: 'Chat workspace' })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' }); await accessible(page);
  const requests: string[] = [];
  page.on('request', request => { if (['fetch', 'xhr', 'websocket', 'eventsource'].includes(request.resourceType())) requests.push(new URL(request.url()).pathname); });
  const question = page.getByRole('button', { name: 'Explain this example', exact: true });
  await question.focus(); await page.keyboard.press('Enter');
  const status = page.getByRole('region', { name: 'AI-assisted explanation' }).getByRole('status');
  await expect(status).toHaveText('Loading a fixed synthetic response…');
  await expect(page.locator('[class~="motion-safe:animate-pulse"]')).toHaveCSS('animation-name', 'none');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Sample question', exact: true })).toBeFocused();
  await expect(status).toContainText('stopped'); await question.click();
  await expect(page.getByText(/No genotype, phenotype/)).toBeVisible();
  const drawer = await evidence(page); await drawer.getByText('Response source', { exact: true }).click();
  await expect(drawer.getByText(/not a clinical citation/)).toBeVisible(); await accessible(page); await closeEvidence(page);
  await evidence(page); await page.getByText('Preview controls', { exact: true }).click();
  await page.getByRole('button', { name: 'Simulate next response failure' }).click(); await closeEvidence(page);
  await ask(page, 'What evidence is missing?'); await expect(page.getByRole('alert')).toContainText('simulated failure');
  await page.getByRole('button', { name: 'Retry sample response' }).click();
  await expect(page.getByRole('textbox', { name: 'Sample question', exact: true })).toBeFocused();
  await expect(page.getByText(/^This example has no accepted/)).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('textbox', { name: 'Sample question', exact: true }).fill('Synthetic custom question');
  await page.keyboard.press('Shift+Enter'); await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await page.keyboard.press('Enter'); await expect(page.getByText(/only demonstrates three fixed questions/)).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Sample question', exact: true })).toHaveValue('');
  expect(requests).toEqual([]);
  await page.addStyleTag({ content: 'html { font-size: 200%; }' }); await question.click();
  await expect(page.getByText(/No genotype, phenotype/)).toBeVisible(); await accessible(page);
  await page.screenshot({ path: `test-results/screens/sidebar-zoom-${info.project.name}.png`, fullPage: true });
});
test('reader may explore fixtures without receiving report permissions', async ({ page }) => {
  await signInAs(page, 'bob', '/local-interpretation'); await openWorkspaceNavigation(page);
  await expect(page.getByRole('link', { name: 'Upload report', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Download|Approve|Evaluate/ })).toHaveCount(0);
  await ask(page, 'What are the limitations?'); await expect(page.getByText(/^These words are a fixed/)).toBeVisible();
  const drawer = await evidence(page); await expect(drawer.getByRole('button', { name: 'Choose file' })).toHaveCount(0);
});
test('attachments, nested image dialog, feedback and scroll controls remain local and keyboard accessible', async ({ page }, info) => {
  await signInAs(page, 'alice', '/local-interpretation');
  const network: string[] = []; page.on('request', request => { if (['fetch', 'xhr'].includes(request.resourceType())) network.push(new URL(request.url()).pathname); });
  const brand = page.getByRole('img', { name: 'Telesphoros shield and Rx logo', exact: true });
  await expect(brand).toBeVisible(); expect((await brand.boundingBox())!.width).toBeGreaterThanOrEqual(64);
  await expect(page.getByRole('img', { name: 'Telesphoros mascot in a teal cloak', exact: true })).toHaveJSProperty('naturalWidth', 162);
  await expect(page.locator('[data-mascot-context="assistant"]')).toHaveAttribute('data-mascot-variant', 'centered');
  const drawer = await evidence(page), imageTrigger = drawer.getByRole('button', { name: 'Preview bundled source image' });
  await imageTrigger.click(); const image = page.getByRole('dialog', { name: 'Synthetic source image', exact: true });
  await expect(image).toBeVisible(); await accessible(page);
  await image.getByRole('button', { name: 'Zoom image', exact: true }).click();
  const viewport = image.getByRole('region', { name: 'Source image viewport' });
  expect(await viewport.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await viewport.focus(); await page.keyboard.press('ArrowRight'); await expect(viewport).toBeFocused();
  await image.getByRole('button', { name: 'Fit to width', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(image).not.toBeVisible(); await expect(imageTrigger).toBeFocused();
  await expect(drawer).toBeVisible(); await expect(drawer.getByRole('button', { name: 'Choose file', exact: true })).toBeDisabled();
  await drawer.getByLabel('This file contains synthetic data only').check();
  const picker = drawer.getByLabel('Choose synthetic attachment');
  await picker.setInputFiles({ name: 'SYN-invalid.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('SYNTHETIC') });
  await expect(drawer.getByRole('alert')).toContainText('Choose one nonempty');
  await picker.setInputFiles({ name: 'SYN-layout-example.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
  await expect(drawer.getByText('SYN-layout-example.json')).toBeVisible(); await closeEvidence(page);
  const question = page.getByRole('button', { name: 'Explain this example', exact: true });
  for (let count = 1; count <= 3; count++) { await question.click(); await expect(page.getByText('Fixed demonstration copy · not model output', { exact: true })).toHaveCount(count); }
  const region = page.getByRole('region', { name: 'Explanation conversation' }); await region.evaluate(el => { el.scrollTop = 0; });
  await expect(page.getByRole('button', { name: 'Latest message' })).toBeVisible();
  await evidence(page); await drawer.getByText('Example tool activity', { exact: true }).click();
  await expect(drawer.getByRole('list', { name: 'Simulated process steps' })).toBeVisible(); await closeEvidence(page);
  expect(await region.evaluate(el => el.scrollTop)).toBeLessThan(10);
  await page.getByRole('button', { name: 'Latest message' }).click(); await expect(page.getByRole('group', { name: 'End of conversation' })).toBeFocused();
  expect(await region.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(32);
  const helpful = page.getByRole('button', { name: 'Helpful', exact: true }).last(), notHelpful = page.getByRole('button', { name: 'Not helpful', exact: true }).last();
  await helpful.click(); await expect(helpful).toHaveAttribute('aria-pressed', 'true'); await notHelpful.click(); await expect(notHelpful).toHaveAttribute('aria-pressed', 'true');
  await accessible(page); await page.screenshot({ path: `test-results/screens/sidebar-feedback-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText('SYN-layout-example.json')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Helpful', exact: true })).toHaveCount(0);
  expect(network).toEqual([]);
});
test('staged loader and text shimmer describe only simulated activity', async ({ page }) => {
  await signInAs(page, 'alice', '/local-interpretation'); const now = new Date();
  await page.clock.install({ time: now }); await page.clock.pauseAt(now);
  await page.getByRole('button', { name: 'Explain this example', exact: true }).click(); await page.clock.runFor(500);
  await expect(page.getByText('Preparing sample preview…')).toBeVisible();
  const drawer = await evidence(page); await drawer.getByText('Example tool activity', { exact: true }).click();
  await expect(drawer.getByRole('list', { name: 'Simulated process steps' })).toBeVisible(); await closeEvidence(page);
  await expect(page.locator('.preview-shimmer')).toHaveCSS('animation-name', 'preview-shimmer');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(page.locator('.preview-shimmer')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('[class~="motion-safe:animate-spin"]')).toHaveCSS('animation-name', 'none');
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click(); await page.clock.runFor(2000);
  await expect(page.getByText('Fixed demonstration copy · not model output', { exact: true })).toHaveCount(0);
  await page.clock.resume(); await accessible(page);
});
