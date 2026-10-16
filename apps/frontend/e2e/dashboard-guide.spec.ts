import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { signInAs, signInWithPatient } from './helpers';
const require = createRequire(import.meta.url);

test('guided upload validates, retains its file and completes through the real intake', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  await page.getByRole('button', { name: 'Guide me step by step' }).click();
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByLabel(/synthetic patient \(required\)/i)).toBeFocused();
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(fixture.id);
  await expect(page.getByText('Choose an existing patient.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByRole('heading', { name: 'Choose file' })).toBeFocused();
  await page.getByLabel(/report type/i).selectOption('structured');
  await page.getByLabel(/report file/i).setInputFiles({ name: 'synthetic-guide.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByRole('heading', { name: 'Review upload' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Upload summary' })).toContainText('synthetic-guide.json');
  await page.getByRole('button', { name: 'Previous step' }).click();
  expect(await page.getByLabel(/report file/i).evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('synthetic-guide.json');
  await page.getByRole('button', { name: 'Next step' }).click();
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByLabel(/synthetic data only/i)).toBeFocused();
  await page.getByLabel(/synthetic data only/i).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: `test-results/screens/guided-upload-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
});


for (const persona of ['bob', 'gina', 'carol'] as const) {
  test(`${persona} does not gain guided upload access`, async ({ page }) => {
    await signInAs(page, persona, '/reports/upload');
    await expect(page.getByRole('heading', { name: 'You do not have access to this page' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guide me step by step' })).toHaveCount(0);
  });
}
