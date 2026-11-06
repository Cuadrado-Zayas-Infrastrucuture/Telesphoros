import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { openAccountMenu, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

test('attach in chat, complete details, and upload into the conversation', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  let declarations = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/reports') declarations++;
  });
  await page.locator('input[type=file]').setInputFiles(new URL('../../../data/fixtures/lab-reports/captures/D01/source.pdf', import.meta.url).pathname);
  const dialog = page.getByRole('dialog', { name: 'Report details', exact: true });
  await expect(dialog).toBeVisible();
  expect(declarations).toBe(0);
  await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Report details', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Report note' }).fill('Draft kept while adding patient');
  await dialog.getByRole('link', { name: 'Add patient', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New patient', exact: true })).toBeVisible();
  const label = `SYN-CHAT-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('textbox', { name: 'Synthetic patient label' }).fill(label);
  await page.getByRole('textbox', { name: 'Given name' }).fill('Synthetic');
  await page.getByRole('textbox', { name: 'Family name' }).fill('Example');
  await page.getByLabel('Date of birth').fill('1980-02-29');
  await page.getByRole('combobox', { name: 'Sex', exact: true }).selectOption('female');
  await page.getByRole('checkbox', { name: 'Hispanic or Latino' }).check();
  await expect(page.getByRole('button', { name: 'Attach a report' })).not.toBeVisible();
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
  await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue('Draft kept while adding patient');
  await page.getByRole('button', { name: 'Report details', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Patient', exact: true }).locator('option:checked')).toHaveText(label);
  expect(declarations).toBe(0);
  await dialog.getByRole('textbox', { name: 'Report note' }).fill('Synthetic report for review');
  await dialog.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }).check();
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected for this browser verification.
    return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('chat-report-details.png') });
  await dialog.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation' }).getByText('Received', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/workspace$/);
  expect(declarations).toBe(1);
  await page.screenshot({ path: test.info().outputPath('chat-report-uploaded.png') });
});

for (const [link, title] of [['Reports', 'Report history'], ['Settings', 'Account preferences']] as const) {
  test(`${link} opens as a panel and returns to the same draft`, async ({ page }) => {
    await signInAs(page, 'alice', '/workspace');
    await page.getByRole('textbox', { name: 'Question' }).fill('Unsent synthetic question');
    // Reports is a destination; Settings is in the account menu at the sidebar's foot (specs/034 D1, D4).
    if (link === 'Settings') await openAccountMenu(page);
    else await openWorkspaceNavigation(page);
    await page.locator('header.workspace-navigation').getByRole('link', { name: link, exact: true }).click();
    const panel = page.getByRole('dialog', { name: title, exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: title, exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('dialog')?.id)).toBe('workspace-panel');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${link.toLowerCase().replaceAll(' ', '-')}-panel.png`) });
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue('Unsent synthetic question');
  });
}
