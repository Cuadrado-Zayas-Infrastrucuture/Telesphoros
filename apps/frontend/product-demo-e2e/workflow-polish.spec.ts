import { expect, test } from '@playwright/test';
import { axeViolations, openPatients, signInAs } from '../e2e/helpers';

const confirmation = 'I confirm this file contains synthetic data only';
const fixture = (id: string) => new URL(`../../../data/fixtures/lab-reports/captures/${id}/source.pdf`, import.meta.url).pathname;

test('replacement, same-file reattachment and failed-upload retry stay clear in chat', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  const picker = page.locator('input[type=file]');
  const details = page.getByRole('dialog', { name: 'Report details', exact: true });
  await picker.setInputFiles(fixture('D01'));
  await details.getByRole('checkbox', { name: confirmation }).check();
  await details.getByRole('button', { name: 'Remove file' }).click();
  await picker.setInputFiles(fixture('D01'));
  await expect(details).toBeVisible();
  await expect(details.getByRole('checkbox', { name: confirmation })).not.toBeChecked();
  await details.getByRole('checkbox', { name: confirmation }).check();
  await picker.setInputFiles(fixture('D08'));
  await expect(details.getByRole('checkbox', { name: confirmation })).not.toBeChecked();
  await details.getByRole('link', { name: 'Add patient' }).click();
  await page.getByRole('textbox', { name: 'Synthetic patient label' }).fill(`SYN-RETRY-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByRole('button', { name: 'Create patient', exact: true }).click();
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
  await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
  await page.getByRole('button', { name: 'Report details', exact: true }).click();
  await details.getByRole('textbox', { name: 'Report note' }).fill('Discuss this synthetic report at the next visit.');
  await details.getByRole('checkbox', { name: confirmation }).check();
  let attempts = 0;
  await page.route('**/api/v1/reports', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    attempts++;
    if (attempts === 1) await route.abort('failed');
    else await route.continue();
  });
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(details.getByRole('alert')).toBeVisible();
  await expect(details.getByRole('textbox', { name: 'Report note' })).toHaveValue('Discuss this synthetic report at the next visit.');
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('upload-retry.png') });
  await details.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation' }).getByText('Received', { exact: true })).toBeVisible();
  await expect(page.getByText('Interpretation is not available in the prototype yet.')).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('a roster beyond 20 patients stays searchable and selectable without losing the draft', async ({ page, browser }, info) => {
  const me = page.waitForResponse((response) => response.url().endsWith('/api/v1/me'));
  await signInAs(page, 'alice', '/workspace');
  const authenticated = await me;
  const api = new URL(authenticated.url()).origin;
  const headers = { Authorization: authenticated.request().headers().authorization! };
  const prefix = `SYN-ROSTER-${crypto.randomUUID().slice(0, 8)}`;
  const firstLabel = `${prefix}-00`;
  let firstId = '';
  for (let index = 0; index < 25; index++) {
    const response = await page.request.post(`${api}/api/v1/patients`, { headers, data: { label: `${prefix}-${String(index).padStart(2, '0')}`, requestId: crypto.randomUUID() } });
    expect(response.status()).toBe(201);
    if (index === 0) firstId = (await response.json()).id;
  }
  // A fresh signed-in view reads the seeded real roster, with this project's viewport/touch settings.
  const view = await browser.newPage({ viewport: page.viewportSize()!, hasTouch: info.project.use.hasTouch, isMobile: info.project.use.isMobile });
  try {
    await signInAs(view, 'alice', '/workspace');
    await openPatients(view); // specs/034 D2: the roster lives on the Patients page
    const patients = view.getByRole('region', { name: 'Patient records', exact: true });
    await expect(view.getByRole('link', { name: 'Add patient', exact: true })).toBeInViewport();
    await patients.getByRole('textbox', { name: 'Find loaded patients' }).fill(firstLabel);
    await expect(patients.getByText(/No match among loaded patients/)).toBeVisible();
    await patients.getByRole('button', { name: 'More patients' }).click();
    await expect(patients.getByRole('link', { name: firstLabel, exact: true })).toBeVisible();
    await patients.getByRole('textbox', { name: 'Find loaded patients' }).fill('');
    expect(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.screenshot({ path: info.outputPath('busy-roster.png') });
    await view.goBack(); // back to the chat
    await view.getByRole('textbox', { name: 'Question' }).fill('Keep this roster-selection draft');
    await view.locator('input[type=file]').setInputFiles(fixture('D01'));
    const details = view.getByRole('dialog', { name: 'Report details', exact: true });
    const choice = details.getByRole('combobox', { name: 'Patient', exact: true });
    const selected = await choice.inputValue();
    await details.getByRole('button', { name: 'More patients' }).click();
    await expect(choice.locator('option', { hasText: firstLabel })).toHaveCount(1);
    await expect(choice).toHaveValue(selected);
    await choice.selectOption(firstId);
    await expect(details.getByRole('textbox', { name: 'Report note' })).toHaveValue('Keep this roster-selection draft');
    expect(await axeViolations(view)).toEqual([]);
    await details.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(view.getByRole('textbox', { name: 'Question' })).toHaveValue('Keep this roster-selection draft');
  } finally { await view.close(); }
});
