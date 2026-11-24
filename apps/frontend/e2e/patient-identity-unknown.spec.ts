import { expect, test, type Page } from '@playwright/test';
import { axeViolations, openPatients, signInWithPatient } from './helpers';

// docs/design/plans/patient-page-identity-outage.md: the patient page when the identity cannot be read now. Nothing here is answered by the
// test: the e2e API runs on the in-memory store, which has no demographics, so it answers the demographics read with 503 by itself (#452).
// That is the same answer a deployed API gives when the patient's key cannot be opened. Synthetic patient, made by the test.

/** Opens the patient's page the way a person does: the Patients list, then the patient's link (a reload would lose the in-memory session). */
async function openPatientPage(page: Page, label: string) {
  await openPatients(page);
  await expect(page.getByRole('list', { name: 'Patients' })).toBeVisible();
  const link = page.getByRole('link', { name: label, exact: true });
  const more = page.getByRole('button', { name: 'More patients', exact: true });
  for (let attempts = 0; attempts < 100 && (await link.count()) === 0; attempts++) {
    if ((await more.count()) === 0) break;
    await more.click();
    await expect.poll(async () => (await link.count()) > 0 || (await more.count()) === 0 || (await more.isEnabled())).toBe(true);
  }
  await link.click();
}

test('the patient page stays up with a warning naming the label, never looks like "none recorded", and holds recording', async ({ page }) => {
  const patient = await signInWithPatient(page);
  await openPatientPage(page, patient.label);

  await expect(page.getByRole('heading', { level: 1, name: patient.label })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: "The patient's identity could not be loaded" })).toContainText(`Make sure this is patient ${patient.label}`);
  await expect(page.getByRole('group', { name: 'Patient identity' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Genomic profile and medication check' })).toBeVisible();

  const demographics = page.getByRole('region', { name: 'Demographics' });
  await expect(demographics).toContainText('The demographics could not be loaded. Use Retry above.');
  await expect(demographics.getByText('No demographics recorded yet.')).toHaveCount(0);
  await expect(demographics.getByRole('button', { name: 'Record demographics' })).toHaveCount(0);
  await expect(page.getByText("Results, decisions and follow-ups open once the patient's identity has loaded.")).toBeVisible();

  // Retry asks again; the in-memory API still has no demographics, so the warning stays and nothing else on the page is lost.
  await page.getByRole('button', { name: 'Retry loading the identity' }).click();
  await expect(page.getByRole('alert').filter({ hasText: "The patient's identity could not be loaded" })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: patient.label })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});
