import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { signInAs, signInWithPatient } from './helpers';

const require = createRequire(import.meta.url);
// The upload page needs a signed-in clinician, so those tests sign in first (through the real flow).
const PAGES = [
  { path: '/', name: 'overview', auth: false },
  { path: '/reports/upload', name: 'upload', auth: true },
];
const open = (page: Page, path: string, auth: boolean) => (auth ? signInAs(page, 'alice', path) : page.goto(path).then(() => undefined));

async function axeViolations(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected into the page above
    const results = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return results.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`);
  });
}

for (const { path, name, auth } of PAGES) {
  test.describe(`${name} page`, () => {
    test('fits the viewport with no horizontal scroll', async ({ page }, info) => {
      await open(page, path, auth);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/screens/${info.project.name}-${name}.png`, fullPage: true });
    });

    test('has no WCAG 2.0/2.1 A/AA violations in a real browser (incl. colour contrast)', async ({ page }) => {
      await open(page, path, auth);
      await page.waitForLoadState('networkidle');
      expect(await axeViolations(page)).toEqual([]);
    });

    test('interactive controls meet the 44px minimum touch target', async ({ page }) => {
      await open(page, path, auth);
      await page.waitForLoadState('networkidle');
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('main a, main button, header a, input:not([type=checkbox]), select')]
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 43.5)
          .map(({ el, rect }) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(rect.height)}px`),
      );
      expect(small).toEqual([]);
    });
  });
}

test('keyboard: skip link is the first tab stop and jumps to main content', async ({ page }) => {
  await page.goto('/');
  // The route is lazy-loaded: wait for real content before using the keyboard.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});

test('keyboard: the whole upload form can be completed without a mouse', async ({ page }) => {
  await signInWithPatient(page);
  await page.getByLabel(/synthetic patient \(required\)/i).focus();
  await page.keyboard.press('s');
  await expect(page.getByLabel(/synthetic patient \(required\)/i)).not.toHaveValue('');
  for (let attempts = 0; attempts < 5 && !(await page.getByLabel(/report type/i).evaluate(element => element === document.activeElement)); attempts++) await page.keyboard.press('Tab');
  await expect(page.getByLabel(/report type/i)).toBeFocused();
  // Native-select typeahead chooses the named option without depending on platform popup behavior.
  await page.keyboard.press('v');
  await expect(page.getByLabel(/report type/i)).toHaveValue('vcf');
  await page.keyboard.press('Tab');
  await page.getByLabel(/report file/i).setInputFiles({ name: 'ok.vcf', mimeType: 'text/plain', buffer: Buffer.from('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n') });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Upload report' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Upload complete/)).toBeVisible();
});

test('form: field-level errors, input preserved after a failed submit, loading state', async ({ page }) => {
  const patient = await signInWithPatient(page);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Choose an existing patient.')).toBeVisible();
  await expect(page.getByText('Choose a report type.')).toBeVisible();
  await expect(page.getByText('Choose a report file.')).toBeVisible();
  await expect(page.getByText('Confirm that this file contains synthetic data only.')).toBeVisible();

  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(patient.id);
  await page.getByLabel(/report type/i).selectOption('vcf');
  await page.getByLabel(/report file/i).setInputFiles({ name: 'fail.vcf', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await page.getByLabel(/synthetic data only/i).check();

  await page.route('**/api/v1/reports', async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({ status: 429, json: { message: 'synthetic refusal' } });
  });
  const submit = page.getByRole('button', { name: 'Upload report' });
  await submit.click();
  const busy = page.getByRole('button', { name: /uploading/i });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();

  await expect(page.getByRole('alert')).toContainText('Too many requests. Wait a moment');
  await expect(page.getByLabel(/synthetic patient \(required\)/i)).toHaveValue(patient.id);
  await expect(page.getByLabel(/report type/i)).toHaveValue('vcf');
  await expect(page.getByLabel(/synthetic data only/i)).toBeChecked();
  await expect(submit).toBeEnabled();
});

test('images: lazy attribute, meaningful alt, and only AVIF/WebP are served to a modern browser', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (req) => requests.push(req.url()));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const img = page.getByRole('img', { name: /double helix/i });
  // Chromium begins lazy fetches well before an image scrolls into view (and this page is short),
  // so we assert what we control: the attribute, dimensions (no layout shift) and the served format.
  await expect(img).toHaveAttribute('loading', 'lazy');
  await expect(img).toHaveAttribute('width', /\d+/);
  await expect(img).toHaveAttribute('height', /\d+/);
  await img.scrollIntoViewIfNeeded();
  await expect.poll(() => requests.filter((url) => url.includes('helix')).length).toBeGreaterThan(0);
  const served = requests.filter((url) => url.includes('helix'));
  expect(served.every((url) => /\.(avif|webp)$/.test(url))).toBe(true);
});

test('unknown routes show the not-found page, not a blank screen', async ({ page }) => {
  await page.goto('/definitely/not/here');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
