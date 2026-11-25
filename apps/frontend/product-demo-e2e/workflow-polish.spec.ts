import { expect, test } from '@playwright/test';
import { axeViolations, openPatients, signInAs } from '../e2e/helpers';

// Spec 052 RC1b: "replacement, same-file reattachment and failed-upload retry stay clear in chat" left with the chat; Attach a report's own
// suites (e2e/upload.spec.ts, e2e/upload-navigation.spec.ts) prove its retry and recovery rules.
const fixture = (id: string) => new URL(`../../../data/fixtures/lab-reports/captures/${id}/source.pdf`, import.meta.url).pathname;

test('a roster beyond 20 patients stays searchable, and Attach a report pages to the oldest without losing the chosen file', async ({ page, browser }, info) => {
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
    await patients.getByRole('textbox', { name: 'Find a patient' }).fill(firstLabel);
    await expect(patients.getByText(/No match among loaded patients/)).toBeVisible();
    await patients.getByRole('button', { name: 'More patients' }).click();
    await expect(patients.getByRole('link', { name: firstLabel, exact: true })).toBeVisible();
    await patients.getByRole('textbox', { name: 'Find a patient' }).fill('');
    expect(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.screenshot({ path: info.outputPath('busy-roster.png') });
    // Spec 052 RC1b: the file is attached on Attach a report, whose patient list pages as the Patients list does; the chosen file stays.
    await view.goBack(); // back to the home
    await view.getByRole('main').getByRole('link', { name: 'Attach a report', exact: true }).click();
    await expect(view.getByRole('heading', { level: 1, name: 'Attach a report' })).toBeVisible();
    await view.getByLabel(/report type/i).selectOption('lab-pdf');
    await view.getByLabel(/report file/i).setInputFiles(fixture('D01'));
    await view.getByRole('button', { name: 'Refresh patients' }).click();
    for (let pages = 0; pages < 100; pages++) {
      await expect(view.getByRole('button', { name: 'Refresh patients' })).toBeEnabled();
      if (await view.getByRole('option', { name: firstLabel, exact: true }).count()) break;
      await view.getByRole('button', { name: 'Next patients' }).click();
    }
    const choice = view.getByLabel(/synthetic patient \(required\)/i);
    await choice.selectOption(firstId);
    await expect(choice).toHaveValue(firstId);
    expect(await view.getByLabel(/report file/i).evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('source.pdf');
    expect(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await axeViolations(view)).toEqual([]);
  } finally { await view.close(); }
});
