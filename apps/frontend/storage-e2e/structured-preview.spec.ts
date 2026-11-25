import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { signInAs, openPatients, openWorkspaceNavigation, selectReportsPatient } from '../e2e/helpers';

/** Chooses a patient on Attach a report, paging its patient list as a person would (the same bounded loop as `signInWithPatient`). */
async function choosePatientOnUploadPage(page: import('@playwright/test').Page, label: string) {
  await page.getByRole('button', { name: 'Refresh patients' }).click();
  for (let attempts = 0; attempts < 100; attempts++) {
    await expect(page.getByRole('button', { name: 'Refresh patients' })).toBeEnabled();
    if (await page.getByRole('option', { name: label, exact: true }).count()) break;
    const next = page.getByRole('button', { name: 'Next patients' });
    if (!(await next.count()) || !(await next.isEnabled())) throw new Error('Synthetic patient not listed within the bounded pages.');
    await next.click();
  }
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption({ label });
}

// Spec 052 RC1b: the report is attached on Attach a report, not in the chat, which is gone.
test('upload, stored uncertain findings, and independent patient-link review', async ({ page, browser }) => {
  await signInAs(page, 'alice', '/workspace');
  const filename = `synthetic-${crypto.randomUUID().slice(0, 8)}.json`;
  // Each browser case represents a different synthetic issuer, so its identifiers never collide across patients.
  const source = JSON.parse(readFileSync(new URL('../../../data/fixtures/pgx-contracts/uncertain/package.json', import.meta.url), 'utf8'));
  source.report.laboratoryId = `syn-lab-${crypto.randomUUID()}`;
  source.report.assay.manifest.laboratoryId = source.report.laboratoryId;
  await openPatients(page);
  await page.getByRole('link', { name: 'Add patient', exact: true }).click();
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
  await openWorkspaceNavigation(page);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('main').getByRole('link', { name: 'Attach a report', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Attach a report' })).toBeVisible();
  await choosePatientOnUploadPage(page, label);
  await page.getByLabel(/report type/i).selectOption('structured');
  await page.getByLabel(/report file/i).setInputFiles({ name: filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await page.getByLabel(/synthetic data only/i).check();
  const uploaded = page.waitForResponse((r) => /upload-attempts\/[^/]+\/bytes$/.test(r.url()) && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  expect((await uploaded).status()).toBe(200);
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  await openWorkspaceNavigation(page);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Reports', exact: true }).click();
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
    const record = review.getByRole('button', { name: 'Save findings for review', exact: true });
    await expect(record).toBeEnabled();
    expect((await record.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await record.click();
    await expect(review.getByText('Saved · ready for findings review', { exact: true })).toBeVisible();
    await review.getByText('Saved source history (1)', { exact: true }).click();
    await expect(review.getByRole('list', { name: 'Saved source history' })).toContainText('Revision 1 (final)');
    await review.getByRole('list', { name: 'Saved source history' }).scrollIntoViewIfNeeded();
    expect(await reviewPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await reviewPage.evaluate(async () => {
      // @ts-expect-error axe injected into this synthetic local browser.
      return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
    })).toEqual([]);
    await reviewPage.screenshot({ path: test.info().outputPath('structured-verified.png'), fullPage: true });
    // A fresh read must retain the recorded state; it cannot be an optimistic local-only update.
    await reviewPage.getByRole('button', { name: 'Back to reports' }).click();
    await reviewPage.getByRole('button', { name: `Open ${filename}`, exact: true }).click();
    await reviewPage.getByRole('button', { name: 'Show structured findings' }).click();
    await expect(review.getByText('verified', { exact: true })).toBeVisible();
    await expect(review.getByText('Saved · ready for findings review', { exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: 'Save findings for review', exact: true })).toHaveCount(0);
  } finally { await reviewer.close(); }

  // Independent findings review: a third person, who neither uploaded (alice) nor saved (gina) the evidence.
  const independent = await browser.newContext({ viewport: page.viewportSize()! });
  try {
    const third = await independent.newPage();
    await signInAs(third, 'hal', '/reports');
    await selectReportsPatient(third, createdPatient);
    await third.getByRole('button', { name: `Open ${filename}`, exact: true }).click();
    await third.getByRole('button', { name: 'Show structured findings' }).click();
    const panel = third.getByRole('region', { name: 'Structured report inspection' });
    await expect(panel.getByText('Awaiting independent review', { exact: true })).toBeVisible();
    const findings = panel.getByRole('list', { name: 'Findings for review' });
    await expect(findings).toContainText('analytical result ambiguous');
    await expect(panel.getByRole('list', { name: 'Outstanding actions' })).toContainText('Check each saved finding against its source');
    const matches = panel.getByRole('button', { name: /: Matches source$/ });
    await matches.scrollIntoViewIfNeeded();
    expect((await matches.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await third.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await third.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
    const axe = () => third.evaluate(async () => {
      // @ts-expect-error axe injected into this synthetic local browser.
      return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
    });
    expect(await axe()).toEqual([]);
    await third.screenshot({ path: test.info().outputPath('structured-findings-review.png'), fullPage: true });
    await matches.click();
    await expect(panel.getByText('Findings review complete', { exact: true })).toBeVisible();
    await expect(findings).toContainText('Matches its source');
    // Recording a match keeps the uncertainty visible and adds no interpretation or prescribing control.
    await expect(findings).toContainText('analytical result ambiguous');
    await expect(findings).toContainText('interpretation indeterminate');
    await expect(panel.getByRole('button', { name: /prescrib|approve|release|interpret/i })).toHaveCount(0);
    expect(await axe()).toEqual([]);
    expect(await third.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await third.screenshot({ path: test.info().outputPath('structured-findings-reviewed.png'), fullPage: true });
    // A fresh read keeps the decision (a later decision may still amend it, so the controls remain).
    await third.getByRole('button', { name: 'Back to reports' }).click();
    await third.getByRole('button', { name: `Open ${filename}`, exact: true }).click();
    await third.getByRole('button', { name: 'Show structured findings' }).click();
    await expect(panel.getByText('Findings review complete', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /: Matches source$/ })).toHaveCount(1);
  } finally { await independent.close(); }
});
