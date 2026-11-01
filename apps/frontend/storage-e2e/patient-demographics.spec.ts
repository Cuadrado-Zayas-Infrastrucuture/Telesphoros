import { expect, test } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

const label = () => `SYN-${crypto.randomUUID().slice(0, 8)}`;

test.describe('Patient demographics: collected in Add patient, read and corrected on the patient page (spec 025 PD-c; needs the database, so it runs in the owned-storage suite)', () => {
  test('a clinician adds a patient with demographics, opens its page, corrects it; a reader reads it; a label alone shows Incomplete', async ({ page, browser }) => {
    const given = `Zzyzx${crypto.randomUUID().slice(0, 6)}`;
    await signInAs(page, 'alice', '/workspace');
    await openWorkspaceNavigation(page);
    const section = page.getByRole('region', { name: 'Patients' });
    const created = label();
    await section.getByRole('button', { name: 'Add patient' }).click();
    await section.getByRole('textbox', { name: 'Synthetic patient label' }).fill(created);
    await section.getByRole('textbox', { name: 'Given name' }).fill(given);
    await section.getByRole('textbox', { name: 'Family name' }).fill('Testcase');
    await section.getByLabel('Date of birth').fill('1980-02-29');
    await section.getByRole('combobox', { name: 'Sex' }).selectOption('female');
    await section.getByRole('checkbox', { name: 'Hispanic or Latino' }).check();
    await section.getByRole('button', { name: 'Create patient' }).click();
    await expect(section.getByText(`Added ${created}.`)).toBeVisible();
    const row = section.getByRole('list', { name: 'Patients' }).getByRole('listitem').filter({ hasText: created });
    await expect(row.getByText('Incomplete')).toHaveCount(0);

    await row.getByRole('link', { name: created }).click();
    await expect(page.getByRole('heading', { level: 1, name: created })).toBeVisible();
    const demographics = page.getByRole('region', { name: 'Demographics' });
    await expect(demographics.getByText(given)).toBeVisible();
    await expect(demographics.getByText('Complete', { exact: true })).toBeVisible();
    expect(page.url()).not.toContain(given);
    expect(await page.title()).not.toContain(given);
    const patientUrl = page.url();

    await demographics.getByRole('button', { name: 'Correct' }).click();
    await demographics.getByRole('textbox', { name: 'Family name' }).fill('Corrected');
    await demographics.getByRole('button', { name: 'Save correction' }).click();
    await expect(demographics.getByText('Corrected', { exact: true })).toBeVisible();
    await expect(demographics.getByRole('listitem')).toHaveCount(2);
    await demographics.getByRole('button', { name: 'View' }).click();
    await expect(demographics.getByText('Testcase', { exact: true })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    // gina is a reviewer in the same organization: she reads, and is offered no correction.
    const reader = await browser.newPage();
    await signInAs(reader, 'gina', new URL(patientUrl).pathname);
    const readerSection = reader.getByRole('region', { name: 'Demographics' });
    await expect(readerSection.getByText('Corrected', { exact: true })).toBeVisible();
    await expect(readerSection.getByRole('button', { name: 'Correct' })).toHaveCount(0);
    await reader.close();

    // bob is in another organization: the patient does not exist for him, and no demographics are shown.
    const outsider = await browser.newPage();
    await signInAs(outsider, 'bob', new URL(patientUrl).pathname);
    await expect(outsider.getByText('This patient is not available.')).toBeVisible();
    await expect(outsider.getByText(given)).toHaveCount(0);
    await outsider.close();

    await page.getByRole('link', { name: 'Workspace', exact: true }).click();
    await openWorkspaceNavigation(page);
    const bare = label();
    await section.getByRole('button', { name: 'Add patient' }).click();
    await section.getByRole('textbox', { name: 'Synthetic patient label' }).fill(bare);
    await section.getByRole('button', { name: 'Create patient' }).click();
    await expect(section.getByRole('list', { name: 'Patients' }).getByRole('listitem').filter({ hasText: bare }).getByText('Incomplete')).toBeVisible();
  });
});
