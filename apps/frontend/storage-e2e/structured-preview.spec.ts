import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { signInAs, openWorkspaceNavigation, selectReportsPatient } from '../e2e/helpers';

test('chat upload, stored uncertain findings, and independent patient-link review', async ({ page, browser }) => {
  await signInAs(page, 'alice', '/workspace');
  const filename = `synthetic-${crypto.randomUUID().slice(0, 8)}.json`;
  await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'application/json', buffer: readFileSync(new URL('../../../data/fixtures/pgx-contracts/uncertain/package.json', import.meta.url)) });
  const dialog = page.getByRole('dialog', { name: 'Report details', exact: true });
  await dialog.getByRole('link', { name: 'Add patient', exact: true }).click();
  const label = `SYN-PGX-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('textbox', { name: 'Synthetic patient label' }).fill(label);
  await page.getByRole('textbox', { name: 'Given name' }).fill('Synthetic');
  await page.getByRole('textbox', { name: 'Family name' }).fill('Example');
  await page.getByLabel('Date of birth').fill('1980-02-29');
  await page.getByRole('combobox', { name: 'Sex', exact: true }).selectOption('female');
  await page.getByRole('checkbox', { name: 'Hispanic or Latino' }).check();
  const creation = page.waitForResponse((response) => response.url().endsWith('/api/v1/patients') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create patient', exact: true }).click();
  const createdPatient = await (await creation).json() as { id: string; label: string };
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
  await page.getByRole('button', { name: 'Report details', exact: true }).click();
  const picker = dialog.getByRole('combobox', { name: 'Patient', exact: true });
  await expect(picker.getByRole('option', { name: label, exact: true })).toBeAttached();
  await picker.selectOption({ label });
  await dialog.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }).check();
  const uploaded = page.waitForResponse((r) => /upload-attempts\/[^/]+\/bytes$/.test(r.url()) && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: 'Upload report', exact: true }).click();
  expect((await uploaded).status()).toBe(200);
  await expect(page.getByRole('region', { name: 'Conversation' }).getByText('Received', { exact: true })).toBeVisible();
  await openWorkspaceNavigation(page);
  await page.getByRole('link', { name: 'All reports', exact: true }).click();
  await selectReportsPatient(page, createdPatient);
  await page.getByRole('button', { name: `Open ${filename}`, exact: true }).click();
  await page.getByRole('button', { name: 'Show structured findings' }).click();
  const section = page.getByRole('region', { name: 'Structured report inspection' });
  await expect(section.getByText(label, { exact: true })).toBeVisible();
  await expect(section.getByRole('list', { name: 'Laboratory findings' })).toContainText('ambiguous');
  await expect(section.getByText('Review patient link', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('structured-uploader.png'), fullPage: true });

  const reviewer = await browser.newContext({ viewport: page.viewportSize()! });
  try {
    const reviewPage = await reviewer.newPage();
    await signInAs(reviewPage, 'gina', '/reports');
    await selectReportsPatient(reviewPage, createdPatient);
    await reviewPage.getByRole('button', { name: `Open ${filename}`, exact: true }).click();
    await reviewPage.getByRole('button', { name: 'Show structured findings' }).click();
    const review = reviewPage.getByRole('region', { name: 'Structured report inspection' });
    await expect(review.getByText(label, { exact: true })).toBeVisible();
    await review.getByText('Review patient link', { exact: true }).click();
    const save = review.getByRole('button', { name: 'Record patient-link decision' });
    await expect(save).toBeDisabled();
    await review.getByLabel('Reason for decision').selectOption('documented-clinic-procedure');
    await expect(save).toBeDisabled();
    await review.getByRole('checkbox').check();
    await expect(save).toBeEnabled();
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await reviewPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await reviewPage.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
    const violations = await reviewPage.evaluate(async () => {
      // @ts-expect-error axe injected into this synthetic local browser.
      return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
    });
    expect(violations).toEqual([]);
    await reviewPage.screenshot({ path: test.info().outputPath('structured-review-expanded.png'), fullPage: true });
    await save.click();
    await expect(review.getByText('verified', { exact: true })).toBeVisible();
    await expect(review.getByRole('status')).toHaveText('Patient-link decision recorded. Findings remain source evidence only.');
    await reviewPage.screenshot({ path: test.info().outputPath('structured-verified.png'), fullPage: true });
    // A fresh read must retain the recorded state; it cannot be an optimistic local-only update.
    await reviewPage.getByRole('button', { name: 'Back to reports' }).click();
    await reviewPage.getByRole('button', { name: `Open ${filename}`, exact: true }).click();
    await reviewPage.getByRole('button', { name: 'Show structured findings' }).click();
    await expect(review.getByText('verified', { exact: true })).toBeVisible();
  } finally { await reviewer.close(); }
});
