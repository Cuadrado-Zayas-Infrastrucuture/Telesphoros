import { expect, test } from '@playwright/test';
import { axeViolations, openPatients, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

test('a treatment follow-up saves its reminder, opens from chat and survives retry and reload', async ({ page }) => {
  await signInAs(page, 'alice', '/workspace');
  await page.getByRole('textbox', { name: 'Question' }).fill('Keep this synthetic patient discussion');
  await openPatients(page); // specs/034 D2
  await page.getByRole('link', { name: 'Add patient', exact: true }).click();
  const label = `SYN-FOLLOWUP-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('textbox', { name: 'Synthetic patient label' }).fill(label);
  await page.getByRole('button', { name: 'Create patient', exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  const medications = page.getByRole('region', { name: 'Medications' });
  await medications.getByRole('button', { name: 'Add medication' }).click();
  await medications.getByRole('combobox', { name: 'Drug', exact: true }).fill('hydralaz');
  await medications.getByRole('option', { name: 'hydralazine', exact: true }).click();
  await medications.getByLabel('Source', { exact: true }).selectOption('patient-reported');
  await medications.getByRole('button', { name: 'Save medication', exact: true }).click();
  await expect(medications.getByRole('heading', { name: 'hydralazine' })).toBeVisible();
  const followups = page.getByRole('region', { name: 'Follow-up', exact: true });
  await followups.getByRole('button', { name: 'Schedule follow-up', exact: true }).click();
  let form = followups.getByRole('form', { name: 'Schedule follow-up' });
  await form.getByRole('combobox', { name: 'Recorded medication' }).selectOption({ label: 'hydralazine · active' });
  await form.getByLabel('Reason or treatment goal').fill('Synthetic treatment response check');
  await form.getByLabel('Next follow-up date').fill('2026-01-01');
  await form.getByLabel('Reminder timezone').fill('America/Puerto_Rico');
  await form.getByRole('button', { name: 'Schedule follow-up', exact: true }).click();
  await expect(followups.getByText('Follow-up saved.', { exact: true })).toBeVisible();
  await expect(followups.getByText('Overdue: 2026-01-01 (America/Puerto_Rico)', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue('Keep this synthetic patient discussion');
  await openWorkspaceNavigation(page);
  await page.getByRole('button', { name: /^Follow-ups/ }).click();
  const inbox = page.getByRole('dialog', { name: 'Follow-ups', exact: true });
  await expect(inbox.getByRole('link', { name: `${label} · hydralazine` })).toBeVisible();
  let summaryReads = 0;
  await page.route('**/api/v1/followups/summary', async (route) => {
    summaryReads++;
    if (summaryReads === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'synthetic-unavailable' }) });
    else if (summaryReads === 2)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          definition: 'followup-response-v1',
          asOf: '2026-01-01T00:00:00Z',
          total: 0,
          responses: { improved: 99, unchanged: 0, worsened: 0, notAssessed: 0, noAssessment: 0 },
        }),
      });
    else await route.continue();
  });
  const summaryButton = inbox.getByRole('button', { name: 'Recorded treatment responses' });
  await summaryButton.focus();
  await page.keyboard.press('Enter');
  const summary = inbox.getByRole('region', { name: 'Recorded treatment responses' });
  await expect(summary.getByRole('alert')).toContainText('Counts could not be verified');
  await expect(inbox.getByRole('link', { name: `${label} · hydralazine` })).toBeVisible();
  await summary.getByRole('button', { name: 'Retry response summary' }).click();
  await expect(summary.getByRole('button', { name: 'Retry response summary' })).toBeEnabled();
  await expect(summary.getByRole('table')).toHaveCount(0);
  await summary.getByRole('button', { name: 'Retry response summary' }).click();
  const missing = summary.getByRole('row', { name: /No assessment recorded/ }).getByRole('cell');
  await expect(missing).toHaveText(/[1-9][0-9]*/);
  expect(summaryReads).toBe(3);
  expect(await axeViolations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('followup-summary-missing.png') });
  await summaryButton.click();
  await page.screenshot({ path: test.info().outputPath('followup-inbox.png') });
  await inbox.getByRole('link', { name: `${label} · hydralazine` }).click();
  await followups.getByRole('button', { name: 'Document', exact: true }).click();
  form = followups.getByRole('form', { name: 'Document follow-up' });
  await expect(form.getByRole('combobox', { name: 'Recorded medication' })).toHaveValue(/.+/);
  await form.getByRole('combobox', { name: 'Treatment response' }).selectOption('improved');
  await form.getByRole('combobox', { name: 'Adverse symptoms' }).selectOption('none-reported');
  await form.getByLabel('Follow-up note').fill('Synthetic patient reports improvement and no adverse symptoms.');
  await form.getByRole('combobox', { name: 'Follow-up plan' }).selectOption('date');
  await form.getByRole('button', { name: 'In 14 days' }).click();
  const nextDate = await form.getByLabel('Next follow-up date').inputValue();
  let attempts = 0;
  await page.route('**/api/v1/patients/*/followups', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    attempts++;
    if (attempts === 1) await route.abort('failed');
    else await route.continue();
  });
  await form.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('draft is kept');
  await expect(form.getByLabel('Follow-up note')).toHaveValue('Synthetic patient reports improvement and no adverse symptoms.');
  const violations = await axeViolations(page);
  if (violations.length) {
    const targets = await page.evaluate(async () => {
      // @ts-expect-error axe is injected by axeViolations.
      const result = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
      return result.violations.map((item: { id: string; nodes: { target: string[] }[] }) => ({ id: item.id, targets: item.nodes.map((node) => node.target) }));
    });
    await test.info().attach('accessibility-targets', { body: JSON.stringify(targets), contentType: 'application/json' });
  }
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.screenshot({ path: test.info().outputPath('followup-form.png') });
  await form.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(followups.getByText('Follow-up saved.', { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
  const patientPath = new URL(page.url()).pathname;
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // The fake identity provider remembers the same Alice session and returns without an account picker.
  await page.waitForURL(`**${patientPath}`);
  await expect(followups.getByText(`Next follow-up: ${nextDate} (America/Puerto_Rico)`, { exact: true })).toBeVisible();
  await expect(followups.getByText(/Response: improved/)).toBeVisible();
  await followups.getByRole('button', { name: 'History', exact: true }).click();
  await expect(followups.getByRole('list', { name: 'Follow-up history' }).getByText('Version 1 · schedule')).toBeVisible();
  await followups.screenshot({ path: test.info().outputPath('followup-history.png') });
  await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
  await openWorkspaceNavigation(page);
  await page.getByRole('button', { name: /^Follow-ups/ }).click();
  await inbox.getByRole('button', { name: 'Recorded treatment responses' }).click();
  await expect(summary.getByRole('row', { name: /^Improved/ }).getByRole('cell')).toHaveText(/[1-9][0-9]*/);
  await expect(summary.getByText(/Response documented in/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('followup-summary-response.png') });
});
