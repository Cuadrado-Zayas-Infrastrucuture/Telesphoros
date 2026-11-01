import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrugList } from '@telesphoros/shared-types';
import { expect, test } from '@playwright/test';
import { axeViolations, openWorkspaceNavigation, signInAs } from '../e2e/helpers';

const list: DrugList = JSON.parse(readFileSync(new URL('../../../packages/shared-types/src/drug-list/bundled.json', import.meta.url), 'utf8'));
const name = 'SYN-retired-ingredient';

// Historical fixture construction through the real repository and ledger writer. No API bypass is shipped.
// Its old synthetic catalog/code is intentionally absent from the current bundle; no row is updated or tampered with.
const seed = `
const {randomUUID} = require('node:crypto');
const {Database} = require('./dist/db/database');
const {PostgresLedgerRecordsRepository} = require('./dist/storage/postgres/ledger-records.repository');
const {PostgresPatientMedicationsRepository} = require('./dist/storage/postgres/patient-medications.repository');
(async () => {
  const db = new Database({url:process.env.E2E_DATABASE_URL,ssl:'disable'});
  try {
    const repo = new PostgresPatientMedicationsRepository(db,new PostgresLedgerRecordsRepository(db));
    await repo.insertVersion('alpha','11111111-1111-4111-8111-111111111111',{
      id:randomUUID(),entryId:randomUUID(),patientId:process.env.SYN_PATIENT_ID,name:'SYN-retired-ingredient',requestHash:'a'.repeat(64),
      input:{requestId:randomUUID(),rxcui:'991001',listVersion:'a'.repeat(64),status:'active',startMonth:'2026-01',stopMonth:null,source:'patient-reported'}
    });
  } finally { await db.onModuleDestroy(); }
})().catch(error => { console.error(error); process.exitCode=1; });
`;

test('historical ingredient corrections and stops remain compact among 20 medications', async ({ page }, info) => {
  await signInAs(page, 'alice', '/workspace');
  await openWorkspaceNavigation(page);
  const patients = page.getByRole('region', { name: 'Patients' });
  const label = `SYN-RETIRED-${crypto.randomUUID().slice(0, 8)}`;
  await patients.getByRole('button', { name: 'Add patient' }).click();
  await patients.getByLabel('Synthetic patient label').fill(label);
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/patients'));
  await patients.getByRole('button', { name: 'Create patient' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const patient = await response.json();
  const api = new URL(response.url()).origin;
  const headers = { Authorization: response.request().headers().authorization! };
  await promisify(execFile)(process.execPath, ['-e', seed], {
    cwd: fileURLToPath(new URL('../../backend', import.meta.url)),
    env: { ...process.env, SYN_PATIENT_ID: patient.id },
    timeout: 30_000,
  });
  for (const entry of list.entries.slice(0, 19)) {
    const saved = await page.request.post(`${api}/api/v1/patients/${patient.id}/medications`, {
      headers,
      data: { requestId: crypto.randomUUID(), rxcui: entry.rxcui, listVersion: list.version, status: 'active', source: 'clinician-entered', startMonth: null, stopMonth: null },
    });
    expect(saved.status()).toBe(201);
  }
  await patients.getByRole('link', { name: label, exact: true }).click();
  const section = page.getByRole('region', { name: 'Medications' });
  await expect(section.getByRole('list', { name: 'Recorded medications' }).getByRole('listitem')).toHaveCount(20);
  for (const action of ['Correct', 'Stop']) {
    const details = section.getByRole('button', { name: `Details for ${name}` });
    if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
    await section.getByRole('button', { name: `${action} ${name}`, exact: true }).click();
    await expect(section.getByLabel('Recorded drug')).toHaveValue(name);
    await expect(section.getByLabel('Recorded drug')).toHaveAttribute('readonly');
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
      const widths = info.project.name === 'desktop-1280' ? [390, 768, 1280] : [375];
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(await section.getByLabel('Recorded drug').evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        expect(await axeViolations(page)).toEqual([]);
        if (process.env.MEDICATION_SCREENSHOTS) {
          mkdirSync(process.env.MEDICATION_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.MEDICATION_SCREENSHOTS, `retired-${action}-${width}-${theme}.png`), fullPage: true });
        }
      }
    }
    if (action === 'Correct') await section.getByLabel('Source', { exact: true }).selectOption('clinician-entered');
    else await section.getByLabel('Stop month (optional)').fill('2026-03');
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/medications'));
    await section.getByRole('button', { name: action === 'Correct' ? 'Save correction' : 'Save stopped medication' }).click();
    const result = await saved;
    expect(result.status()).toBe(201);
    expect(await result.json()).toMatchObject({ name, rxcui: '991001', listVersion: 'a'.repeat(64), version: action === 'Correct' ? 2 : 3 });
    await expect(section.getByText('Medication saved.')).toBeVisible();
  }
  await expect(section.getByText('19 active · 1 stopped')).toBeVisible();
});
