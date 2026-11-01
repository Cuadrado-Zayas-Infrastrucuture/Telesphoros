import { expect, test } from '@playwright/test';
import { axeViolations, signInAs } from './helpers';

const KEY = 'telesphoros.storage-consent.v1';

test('necessary-only consent permits sign-in and session appearance without optional persistence', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await signInAs(page, 'alice', '/settings', 'necessary');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual({ version: 1, preferences: false });
  await page.locator('label[for="theme-dark"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('telesphoros.theme'))).toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Allow preferences', exact: true })).toHaveCount(0);
});

test('saved preferences can be withdrawn in Settings while current appearance and required session data remain usable', async ({ page }, info) => {
  await signInAs(page, 'alice', '/settings');
  await page.locator('label[for="theme-dark"]').click();
  expect(await page.evaluate(() => localStorage.getItem('telesphoros.theme'))).toBe('dark');
  await page.evaluate(() => sessionStorage.setItem('consent.synthetic-check', 'keep'));
  const reopen = page.getByRole('button', { name: 'Cookie settings', exact: true });
  await reopen.click();
  const dialog = page.getByRole('dialog', { name: 'Cookies and browser storage', exact: true });
  const optional = dialog.getByRole('checkbox', { name: 'Remember display and language settings' });
  expect((await dialog.locator('label[for="storage-optional-preferences"]').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(optional).toBeChecked();
  await optional.uncheck();
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath('consent-preferences-dark.png') });
  await dialog.getByRole('button', { name: 'Save choices', exact: true }).click();
  await expect(reopen).toBeFocused();
  expect(await page.evaluate(() => ['telesphoros.theme', 'telesphoros.sidebar', 'telesphoros.landing.language'].map((key) => localStorage.getItem(key)))).toEqual([null, null, null]);
  expect(await page.evaluate(() => sessionStorage.getItem('consent.synthetic-check'))).toBe('keep');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('first-visit preferences start off, support keyboard cancellation and follow the landing language without saving it', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Español', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Cookies y almacenamiento del navegador', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('telesphoros.landing.language'))).toBeNull();
  const manage = page.getByRole('button', { name: 'Configurar', exact: true });
  await manage.click();
  const dialog = page.getByRole('dialog', { name: 'Cookies y almacenamiento del navegador', exact: true });
  const optional = dialog.getByRole('checkbox', { name: 'Recordar apariencia e idioma' });
  await expect(optional).not.toBeChecked();
  await optional.focus();
  await optional.press('Space');
  await expect(optional).toBeChecked();
  expect(await axeViolations(page)).toEqual([]);
  expect(await dialog.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length)).toBe(0);
  await page.screenshot({ path: info.outputPath('consent-preferences-spanish.png') });
  await optional.press('Escape');
  await expect(manage).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('the first-visit bar leaves chat controls usable without deciding and gives acceptance and rejection equal weight', async ({ page }, info) => {
  const insets = { top: 24, right: 16, bottom: 34, left: 16 };
  const device = await page.context().newCDPSession(page);
  await device.send('Emulation.setSafeAreaInsetsOverride', { insets });
  await signInAs(page, 'alice', '/workspace', 'unanswered');
  const bar = page.getByRole('region', { name: 'Cookies and browser storage', exact: true });
  await expect(bar).toBeVisible();
  const reject = bar.getByRole('button', { name: 'Use necessary only', exact: true });
  const accept = bar.getByRole('button', { name: 'Allow preferences', exact: true });
  expect((await reject.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await accept.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const button of [reject, accept]) {
    expect(await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].every((rect) => rect.left >= box.left && rect.right <= box.right);
    })).toBe(true);
  }
  const color = await reject.evaluate((element) => getComputedStyle(element).backgroundColor);
  await expect(accept).toHaveCSS('background-color', color);
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await send.scrollIntoViewIfNeeded();
  const sendBox = await send.boundingBox();
  const barBox = await bar.boundingBox();
  const viewport = page.viewportSize()!;
  expect(barBox!.x).toBeGreaterThanOrEqual(insets.left);
  expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(viewport.width - insets.right);
  expect(barBox!.y).toBeGreaterThanOrEqual(insets.top);
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(viewport.height - insets.bottom);
  expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(barBox!.y);
  const heading = await page.getByRole('heading', { name: 'Start with a synthetic report.', exact: true }).boundingBox();
  const composer = await page.getByRole('form', { name: 'Report and question' }).boundingBox();
  expect(heading!.y + heading!.height).toBeLessThanOrEqual(composer!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath('consent-bar-workspace.png') });
});

test('blocked storage applies a temporary decision and explains that it was not saved', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Use necessary only', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cookies and browser storage', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('prevented clearing saved preferences');
  await dialog.getByRole('button', { name: 'Close cookie settings', exact: true }).click();
  await expect(page.getByRole('main')).toBeFocused();
  await page.getByRole('button', { name: 'Cookie settings', exact: true }).click();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
});
