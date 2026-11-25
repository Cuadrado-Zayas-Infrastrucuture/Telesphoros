import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { openAccountMenu, openPatients, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

// Spec 052 RC1b: attaching a report happens on Attach a report (/reports/upload); the chat that did it before is gone. This file was
// chat-upload.spec.ts; the chat's own cases (its draft kept across pages, its note, its "Back to chat") left with it.

/** Chooses a patient on Attach a report, paging its patient list as a person would (the same bounded loop as `signInWithPatient`). */
async function choosePatientOnUploadPage(page: Page, label: string) {
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

test('add a patient with demographics and a medication, then attach a synthetic PDF for them on Attach a report', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  let declarations = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/reports') declarations++;
  });
  await openPatients(page);
  await page.getByRole('link', { name: 'Add patient', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New patient', exact: true })).toBeVisible();
  const label = `SYN-ATTACH-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('textbox', { name: 'Synthetic patient label' }).fill(label);
  await page.getByRole('textbox', { name: 'Given name' }).fill('Synthetic');
  await page.getByRole('textbox', { name: 'Family name' }).fill('Example');
  await page.getByLabel('Date of birth').fill('1980-02-29');
  await page.getByRole('combobox', { name: 'Sex', exact: true }).selectOption('female');
  await page.getByRole('checkbox', { name: 'Hispanic or Latino' }).check();
  await page.screenshot({ path: test.info().outputPath('new-patient.png') });
  await page.getByRole('button', { name: 'Create patient', exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Demographics' }).getByText('Synthetic', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Demographics' }).getByText('Example', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Medications', exact: true })).toBeVisible();
  const medications = page.getByRole('region', { name: 'Medications' });
  await medications.getByRole('button', { name: 'Add medication' }).click();
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('hydralaz');
  await medications.getByRole('option', { name: 'hydralazine', exact: true }).click();
  await medications.getByLabel('Source', { exact: true }).selectOption('patient-reported');
  await medications.getByRole('button', { name: 'Save medication', exact: true }).click();
  await expect(medications.getByRole('heading', { name: 'hydralazine' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('patient-record.png') });
  expect(declarations).toBe(0);

  // From the home, as a person would: its quick action opens Attach a report (spec 052 RC-2).
  await openWorkspaceNavigation(page);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('main').getByRole('link', { name: 'Attach a report', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Attach a report' })).toBeVisible();
  await choosePatientOnUploadPage(page, label);
  await page.getByLabel(/report type/i).selectOption('lab-pdf');
  await page.getByLabel(/report file/i).setInputFiles(new URL('../../../data/fixtures/lab-reports/captures/D01/source.pdf', import.meta.url).pathname);
  await page.getByLabel(/synthetic data only/i).check();
  expect(declarations).toBe(0);
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected for this browser verification.
    return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('attach-report-filled.png') });
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  expect(declarations).toBe(1);
  await page.screenshot({ path: test.info().outputPath('attach-report-uploaded.png') });
});

test('Reports opens as a page, not a panel', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  // Reports is a destination page (specs/041 C1).
  await openWorkspaceNavigation(page);
  await page.locator('header.workspace-navigation').getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reports', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Report history', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('reports-page.png') });
});

// Spec 052 RC-3: Settings is a page in the main area, with the way back home.
test('Settings opens as a page, with Back to home', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  // Settings is in the account menu at the sidebar's foot (specs/034 D4).
  await openAccountMenu(page);
  await page.locator('header.workspace-navigation').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Account preferences' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('settings-page.png') });
  await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your worklist' })).toBeVisible();
});
