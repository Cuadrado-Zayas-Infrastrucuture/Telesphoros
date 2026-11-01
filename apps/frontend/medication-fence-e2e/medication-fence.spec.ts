import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

test('paused recording retains the compact form, creates no entry and leaves reads available', async ({ page }, info) => {
  await signInAs(page, 'alice', '/workspace');
  await openWorkspaceNavigation(page);
  const patients = page.getByRole('region', { name: 'Patients' });
  const label = `SYN-FENCE-${crypto.randomUUID().slice(0, 8)}`;
  await patients.getByRole('button', { name: 'Add patient' }).click();
  await patients.getByLabel('Synthetic patient label').fill(label);
  await patients.getByRole('button', { name: 'Create patient' }).click();
  await expect(patients.getByText(`Added ${label}.`)).toBeVisible();
  await patients.getByRole('link', { name: label, exact: true }).click();
  const section = page.getByRole('region', { name: 'Medications' });
  await expect(section.getByText('No medications recorded yet.')).toBeVisible();
  await section.getByRole('button', { name: 'Add medication' }).click();
  const picker = section.getByRole('combobox', { name: 'Drug', exact: true });
  await picker.fill('hydralaz');
  await picker.press('ArrowDown');
  await picker.press('Enter');
  await section.getByLabel('Start month (optional)').fill('2026-01');
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/medications'));
  await section.getByRole('button', { name: 'Save medication', exact: true }).click();
  const refused = await response;
  expect(refused.status()).toBe(503);
  const original = refused.request().postDataJSON();
  await expect(section.getByRole('alert')).toHaveText('Medication recording is temporarily paused. Your entries are kept; retry later.');
  await expect(picker).toHaveValue('hydrALAZINE');
  await expect(section.getByLabel('Start month (optional)')).toHaveValue('2026-01');
  await expect(section.getByText('Medication saved.')).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async (value) => {
      document.documentElement.setAttribute('data-theme', value);
      document.documentElement.getBoundingClientRect();
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      );
    }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    if (process.env.MEDICATION_SCREENSHOTS) {
      mkdirSync(process.env.MEDICATION_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.MEDICATION_SCREENSHOTS, `fence-${info.project.name}-${theme}.png`), fullPage: true });
    }
  }
  const retried = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/medications'));
  await section.getByRole('button', { name: 'Save medication', exact: true }).click();
  const retry = await retried;
  expect(retry.status()).toBe(503);
  expect(retry.request().postDataJSON()).toEqual(original);
  await section.getByRole('button', { name: 'Cancel', exact: true }).click();
  const read = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith('/medications'));
  await section.getByRole('button', { name: 'Refresh medications' }).click();
  expect((await read).status()).toBe(200);
  await expect(section.getByText('No medications recorded yet.')).toBeVisible();
});
