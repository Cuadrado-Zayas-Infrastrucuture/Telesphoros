import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);

async function axeViolations(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected into the page above
    const results = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return results.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`);
  });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}
const toggle = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('the landing is English by default, whatever the browser language', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'es-ES' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'A clearer view of your PGx reports.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(toggle(page, 'Español')).toBeVisible();
  await context.close();
});

test('choosing Spanish changes the whole landing, passes axe and fits the viewport; the choice survives a reload; English comes back', async ({ page }) => {
  await page.goto('/');
  await toggle(page, 'Español').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Una vista más clara de tus informes PGx.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Flujo' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Iniciar sesión en Telesphoros' }).first()).toBeVisible();
  await expect(page.getByText('Vista previa de desarrollo. Solo datos sintéticos.').first()).toBeVisible();
  await expect(page.getByText('Solo datos sintéticos', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'Mascota de Telesphoros con una capa verde azulada' })).toHaveCount(1);
  await expect(page.locator('footer')).toContainText('No apto para uso clínico');
  // The interactive walkthrough follows the language, and its state still works.
  await page.getByRole('button', { name: 'Verificar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verificado por el servidor', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Comparar con una carga incompleta' }).click();
  await expect(page.getByRole('heading', { name: 'Incompleto', exact: true })).toBeVisible();
  await noOverflow(page);
  expect(await axeViolations(page)).toEqual([]);
  // Nothing English is left in the landing's own headings.
  const headings = await page.locator('main h1, main h2, main h3').allTextContents();
  expect(headings.join(' | ')).not.toMatch(/A clearer view|Working toward|Take a look inside|Why we’re building/);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Una vista más clara de tus informes PGx.');

  await toggle(page, 'English').click();
  await expect(page.getByRole('heading', { level: 1, name: 'A clearer view of your PGx reports.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await axeViolations(page)).toEqual([]);
});

test('the language control is a 44px target and works without browser storage', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
  });
  await page.goto('/');
  const control = toggle(page, 'Español');
  expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  await control.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Una vista más clara de tus informes PGx.' })).toBeVisible();
});

test('other pages stay English and the shell returns to English when leaving the landing', async ({ page }) => {
  await page.goto('/');
  await toggle(page, 'Español').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.goto('/definitely/not/here');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toHaveCount(1);
});
