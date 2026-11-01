import { expect, test, type Locator, type Page } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, selectReportsPatient, signInAs, signInWithPatient } from './helpers';

const insets = { top: 24, right: 32, bottom: 34, left: 32 };
async function cutout(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setSafeAreaInsetsOverride', { insets });
}
async function withinSafeArea(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(insets.left);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - insets.right + 1);
  expect(box!.y).toBeGreaterThanOrEqual(insets.top);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - insets.bottom + 1);
}

test('the page, navigation and chat controls stay inside device safe areas', async ({ page }, info) => {
  await cutout(page);
  await signInAs(page, 'alice', '/workspace');
  await expect(page.locator('body')).toHaveCSS('padding-top', '24px');
  await expect(page.locator('body')).toHaveCSS('padding-left', '32px');
  await expect(page.locator('body')).toHaveCSS('padding-right', '32px');
  await expect(page.locator('body')).toHaveCSS('padding-bottom', '34px');
  await withinSafeArea(page, page.getByRole('button', { name: 'Send', exact: true }));
  await openWorkspaceNavigation(page);
  await withinSafeArea(page, page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Settings', exact: true }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath('safe-area-chat.png'), fullPage: true });
});

test('report details and its close button avoid the cutout and home indicator', async ({ page }, info) => {
  await cutout(page);
  const fixture = await signInWithPatient(page);
  const name = `safe-area-${crypto.randomUUID().slice(0, 8)}.json`;
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(fixture.id);
  await page.getByLabel(/report type/i).selectOption('structured');
  await page.getByLabel(/report file/i).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
  await page.getByLabel(/synthetic data only/i).check();
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  await openWorkspaceNavigation(page);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'All reports', exact: true }).click();
  await selectReportsPatient(page, fixture);
  await page.getByRole('button', { name: `Open ${name}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Report details' });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.y).toBe(insets.top);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width - insets.right + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height - insets.bottom + 1);
  const close = dialog.getByRole('button', { name: 'Back to reports' });
  await withinSafeArea(page, close);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath('safe-area-details.png'), fullPage: true });
  await close.click();
  await expect(page.getByRole('button', { name: `Open ${name}` })).toBeFocused();
});
