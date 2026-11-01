import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

async function openPatient(page: Page) {
  await signInAs(page, 'alice', '/workspace');
  await openWorkspaceNavigation(page);
  const patients = page.getByRole('region', { name: 'Patients' });
  const label = `SYN-MED-${crypto.randomUUID().slice(0, 8)}`;
  await patients.getByRole('button', { name: 'Add patient' }).click();
  await patients.getByLabel('Synthetic patient label').fill(label);
  await patients.getByRole('button', { name: 'Create patient' }).click();
  await expect(patients.getByText(`Added ${label}.`)).toBeVisible();
  await patients.getByRole('link', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
  return new URL(page.url()).pathname;
}

async function reveal(section: Locator) {
  const details = section.getByRole('button', { name: 'Details for hydralazine' });
  if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
}

test('clinicians add, correct and stop coded medications; readers see prior versions; expanded light/dark forms reflow', async ({ page, browser }, info) => {
  const path = await openPatient(page);
  const medications = page.getByRole('region', { name: 'Medications' });
  await expect(medications.getByText('No medications recorded yet.')).toBeVisible();
  const attribution = medications.getByText(/This product uses publicly available data courtesy of/);
  await expect(attribution).toBeHidden();
  await medications.getByText('Drug list information', { exact: true }).click();
  await expect(attribution).toBeVisible();
  await expect(attribution).toContainText('U.S. National Library of Medicine');
  await expect(medications.getByText('This bundled snapshot may not reflect the most current or accurate NLM data.')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await medications.getByText('Drug list information', { exact: true }).click();
  await medications.getByRole('button', { name: 'Add medication' }).click();
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('hydralaz');
  await expect(medications.getByRole('option', { name: 'hydralazine', exact: true })).toHaveText('hydrALAZINE');
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('hydralaz');
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).press('ArrowDown');
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).press('Enter');
  await medications.getByLabel('Source', { exact: true }).selectOption('patient-reported');
  await medications.getByLabel('Start month (optional)').fill('2026-01');
  const saved = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/medications'));
  await medications.getByRole('button', { name: 'Save medication', exact: true }).click();
  expect((await saved).postDataJSON()).toMatchObject({ rxcui: '5470', status: 'active', source: 'patient-reported', startMonth: '2026-01', stopMonth: null });
  expect((await saved).postDataJSON()).not.toHaveProperty('name');
  await expect(medications.getByRole('heading', { name: 'hydralazine' })).toHaveText('hydrALAZINE');

  await medications.getByRole('button', { name: 'Add medication' }).click();
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('codeine');
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('codeine');
  if (info.project.name === 'mobile-375') await medications.getByRole('option', { name: 'codeine', exact: true }).tap();
  else await medications.getByRole('option', { name: 'codeine', exact: true }).click();
  await medications.getByLabel('Status', { exact: true }).selectOption('stopped');
  await medications.getByLabel('Stop month (optional)').fill('2026-02');
  await medications.getByRole('button', { name: 'Save medication', exact: true }).click();
  const entries = medications.getByRole('list', { name: 'Recorded medications' }).getByRole('listitem');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText('hydrALAZINE');
  await expect(entries.nth(1)).toContainText('codeine');

  await reveal(medications);
  await medications.getByRole('button', { name: 'Correct hydralazine', exact: true }).click();
  await medications.getByLabel('Source', { exact: true }).selectOption('clinician-entered');
  await medications.getByRole('button', { name: 'Save correction' }).click();
  await expect(medications.getByText('Medication saved.')).toBeVisible();
  await reveal(medications);
  await expect(entries.filter({ hasText: 'hydrALAZINE' })).toContainText('Version 2 (current)');
  await reveal(medications);
  await medications.getByRole('button', { name: 'Stop hydralazine', exact: true }).click();
  await medications.getByLabel('Stop month (optional)').fill('2026-03');
  await medications.getByRole('button', { name: 'Save stopped medication' }).click();
  await expect(medications.getByText('Medication saved.')).toBeVisible();
  await reveal(medications);
  await expect(entries.filter({ hasText: 'hydrALAZINE' })).toContainText('Version 3 (current)');
  await expect(entries.filter({ hasText: 'hydrALAZINE' })).toContainText('Stop: 2026-03');
  await reveal(medications);
  await medications.getByRole('button', { name: 'Earlier versions of hydralazine' }).click();
  await expect(medications.getByText('Version 2 (earlier)')).toBeVisible();
  await medications.getByRole('button', { name: 'Previous version' }).click();
  await expect(medications.getByText('Version 1 (earlier)')).toBeVisible();
  await expect(medications.getByText('Active · Patient-reported')).toBeVisible();
  await reveal(medications);
  await medications.getByRole('button', { name: 'Earlier versions of hydralazine' }).click();

  for (const persona of ['gina', 'bob', 'carol', 'dave'] as const) {
    const reader = await browser.newPage();
    await signInAs(reader, persona, path);
    const section = reader.getByRole('region', { name: 'Medications' });
    if (persona === 'gina') {
      await expect(section.getByRole('heading', { name: 'hydralazine' })).toBeVisible();
      await reveal(section);
      await expect(section.getByRole('button', { name: /^(Add|Correct|Stop) / })).toHaveCount(0);
      await reveal(section);
      await section.getByRole('button', { name: 'Earlier versions of hydralazine' }).click();
      await expect(section.getByText('Version 2 (earlier)')).toBeVisible();
    } else {
      await expect(reader.getByText(persona === 'bob' ? 'This patient is not available.' : 'You do not have access to this page')).toBeVisible();
      await expect(section).toHaveCount(0);
    }
    await reader.close();
  }

  await medications.getByRole('button', { name: 'Add medication' }).click();
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('hydralaz');
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('hydralaz');
  await medications.getByRole('option', { name: 'hydralazine', exact: true }).click();
  await medications.getByLabel('Status', { exact: true }).selectOption('stopped');
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('ami');
  await expect(medications.getByRole('listbox', { name: 'Drug suggestions' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    // Measure the chosen theme after finite color transitions finish, rather than a mixed transition frame.
    await page.evaluate(async () => {
      document.documentElement.getBoundingClientRect();
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    expect(await axeViolations(page)).toEqual([]);
    if (info.project.name === 'desktop-1280') {
      const directory = process.env.MEDICATION_SCREENSHOTS ?? info.outputPath('medications');
      mkdirSync(directory, { recursive: true });
      for (const width of [390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(directory, `medications-${width}-${theme}.png`), fullPage: true });
        if (width === 1280) await medications.getByRole('form', { name: 'Add medication' }).screenshot({ path: join(directory, `medication-picker-${theme}.png`) });
      }
    }
  }
  expect(page.url()).not.toContain('hydralazine');
  expect(await page.title()).not.toContain('hydralazine');
});

test('a lost save response replays one version; a concurrent correction stays a conflict until reloaded', async ({ page, browser }) => {
  const path = await openPatient(page);
  const medications = page.getByRole('region', { name: 'Medications' });
  await medications.getByRole('button', { name: 'Add medication' }).click();
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('hydralaz');
  await medications.getByRole('option', { name: 'hydralazine', exact: true }).click();
  const requestIds: string[] = [];
  await page.route('**/api/v1/patients/*/medications', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requestIds.push(route.request().postDataJSON().requestId);
    const response = await route.fetch(); // the actual backend commits before the synthetic lost response
    if (requestIds.length === 1) return route.abort('failed');
    await route.fulfill({ response });
  });
  await medications.getByRole('button', { name: 'Save medication', exact: true }).click();
  await expect(medications.getByRole('alert')).toContainText('retry');
  await medications.getByRole('button', { name: 'Save medication', exact: true }).click();
  await expect(medications.getByText('Medication saved.')).toBeVisible();
  await reveal(medications);
  await expect(medications.getByText('Version 1 (current)')).toBeVisible();
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
  await expect(medications.getByRole('listitem')).toHaveCount(1);
  await page.unroute('**/api/v1/patients/*/medications');

  await reveal(medications);
  await medications.getByRole('button', { name: 'Correct hydralazine' }).click();
  await medications.getByLabel('Start month (optional)').fill('2026-01');
  const other = await browser.newPage();
  await signInAs(other, 'alice', path);
  const concurrent = other.getByRole('region', { name: 'Medications' });
  await reveal(concurrent);
  await concurrent.getByRole('button', { name: 'Correct hydralazine' }).click();
  await concurrent.getByLabel('Source', { exact: true }).selectOption('patient-reported');
  await concurrent.getByRole('button', { name: 'Save correction' }).click();
  await expect(concurrent.getByText('Medication saved.')).toBeVisible();
  await reveal(concurrent);
  await expect(concurrent.getByText('Version 2 (current)')).toBeVisible();
  await medications.getByRole('button', { name: 'Save correction' }).click();
  await expect(medications.getByRole('alert')).toContainText('Cancel and reload');
  await expect(medications.getByLabel('Start month (optional)')).toHaveValue('2026-01');
  await medications.getByRole('button', { name: 'Cancel', exact: true }).click();
  await reveal(medications);
  await expect(medications.getByText('Version 2 (current)')).toBeVisible();
  await other.close();
});
