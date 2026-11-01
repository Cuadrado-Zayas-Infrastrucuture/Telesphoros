import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrugList } from '@telesphoros/shared-types';
import { expect, test } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

const list: DrugList = JSON.parse(readFileSync(new URL('../../../packages/shared-types/src/drug-list/bundled.json', import.meta.url), 'utf8'));

test('20 recorded medications stay compact, searchable and readable in both themes', async ({ page }, info) => {
  await signInAs(page, 'alice', '/workspace');
  await openWorkspaceNavigation(page);
  const patients = page.getByRole('region', { name: 'Patients' });
  const label = `SYN-TWENTY-${crypto.randomUUID().slice(0, 8)}`;
  await patients.getByRole('button', { name: 'Add patient' }).click();
  await patients.getByLabel('Synthetic patient label').fill(label);
  const created = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/patients'));
  await patients.getByRole('button', { name: 'Create patient' }).click();
  const authenticated = await created;
  const api = new URL(authenticated.url()).origin;
  const headers = { Authorization: authenticated.request().headers().authorization! };
  // Fixture construction uses the actual tenant-scoped API. The list count and layout are verified independently in the browser.
  expect(authenticated.status()).toBe(201);
  const patient = await authenticated.json();
  await patients.getByRole('link', { name: label, exact: true }).click();
  const codes = [
    '5470',
    ...list.entries
      .filter((entry) => entry.rxcui !== '5470')
      .slice(0, 19)
      .map((entry) => entry.rxcui),
  ];
  for (const [index, rxcui] of codes.entries()) {
    const recorded = await page.request.post(`${api}/api/v1/patients/${patient.id}/medications`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        rxcui,
        listVersion: list.version,
        status: index < 16 ? 'active' : 'stopped',
        source: index % 2 ? 'patient-reported' : 'clinician-entered',
        startMonth: '2026-01',
        stopMonth: index < 16 ? null : '2026-03',
      },
    });
    expect(recorded.status()).toBe(201);
  }
  const medications = page.getByRole('region', { name: 'Medications' });
  await medications.getByRole('button', { name: 'Refresh medications' }).click();
  const rows = medications.getByRole('list', { name: 'Recorded medications' }).getByRole('listitem');
  await expect(rows).toHaveCount(20);
  await expect(medications.getByText('16 active · 4 stopped')).toBeVisible();
  await medications.getByLabel('Find recorded medication').fill('HYDRALAZ');
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole('heading', { name: 'hydralazine' })).toHaveText('hydrALAZINE');
  await medications.getByLabel('Find recorded medication').clear();
  await expect(rows).toHaveCount(20);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async (value) => {
      document.documentElement.setAttribute('data-theme', value);
      document.documentElement.getBoundingClientRect();
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    }, theme);
    for (const width of info.project.name === 'desktop-1280' ? [390, 768, 1280] : [375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await rows.first().evaluate((row) => row.getBoundingClientRect().height)).toBeLessThan(width >= 768 ? 90 : 130);
      expect(await axeViolations(page)).toEqual([]);
      if (info.project.name === 'desktop-1280') {
        const directory = process.env.MEDICATION_SCREENSHOTS ?? info.outputPath('medications');
        mkdirSync(directory, { recursive: true });
        await page.screenshot({ path: join(directory, `medications-20-${width}-${theme}.png`), fullPage: true });
      }
    }
  }
});
