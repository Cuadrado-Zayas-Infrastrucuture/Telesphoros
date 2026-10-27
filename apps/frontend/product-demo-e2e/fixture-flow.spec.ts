import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { selectReportsPatient, signInAs } from '../e2e/helpers';

for (const fixtureId of ['D01', 'D08', 'D02'] as const) {
  test(`${fixtureId}: real storage to fixed example, with processing disabled`, async ({ page }) => {
    const me = page.waitForResponse((response) => response.url().endsWith('/api/v1/me'));
    await signInAs(page, 'alice');
    const authenticated = await me;
    const api = new URL(authenticated.url()).origin;
    const headers = { Authorization: authenticated.request().headers().authorization! };
    await expect(page.getByRole('button', { name: 'Refresh patients', exact: true })).toBeEnabled();
    const addPatient = page.getByRole('button', { name: 'Add a synthetic patient', exact: true });
    if (await addPatient.isVisible()) await addPatient.click();
    await page.getByLabel('Synthetic patient label', { exact: true }).fill(`SYN-DEMO-${crypto.randomUUID().slice(0, 20)}`);
    const created = page.waitForResponse((response) => response.url().endsWith('/api/v1/patients') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Add patient', exact: true }).click();
    const patientResponse = await created;
    expect(patientResponse.status()).toBe(201);
    const patient = await patientResponse.json();
    const fixture = { id: patient.id as string, label: patient.label as string, api, headers };
    await expect(page.getByLabel(/synthetic patient \(required\)/i)).toHaveValue(fixture.id);
    const bytes = await readFile(new URL(`../../../data/fixtures/lab-reports/captures/${fixtureId}/source.pdf`, import.meta.url));
    const filename = fixtureId === 'D02' ? 'SYN-DEMO-D01.pdf' : `SYN-DEMO-${fixtureId}.pdf`;
    let processingRequests = 0;
    page.on('request', (request) => {
      if (/\/(capture|evaluations|decision|patient-link)(\/|$)/.test(new URL(request.url()).pathname)) processingRequests++;
    });
    await page.getByLabel(/synthetic patient \(required\)/i).selectOption(fixture.id);
    await page.getByLabel(/report type/i).selectOption('lab-pdf');
    await page.getByLabel(/report file/i).setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: bytes });
    await page.getByLabel(/synthetic data only/i).check();
    await page.getByRole('button', { name: 'Upload report', exact: true }).click();
    await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
    const response = await page.request.get(`${fixture.api}/api/v1/reports?patientId=${fixture.id}`, { headers: fixture.headers });
    expect(response.status()).toBe(200);
    const [stored] = (await response.json()).data;
    expect(stored).toMatchObject({ fileUploaded: true, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'received' });
    await page.getByRole('link', { name: 'View reports' }).click();
    await selectReportsPatient(page, fixture);
    await page.getByTestId(`report-${stored.id}`).click();
    const panel = page.getByRole('dialog', { name: 'Report details' });
    await expect(panel.getByText('Fixed synthetic data. No reader, rules engine or model has run on this upload.')).toBeVisible();
    if (fixtureId === 'D02') {
      await expect(panel.getByText('No fixed example matches this file. Other uploads are not analyzed.')).toBeVisible();
      await expect(panel.getByRole('button', { name: /Show.*sample/ })).toHaveCount(0);
      await expect(panel.getByText('Q intermediate.', { exact: true })).toHaveCount(0);
      expect(processingRequests).toBe(0);
      return;
    }
    const button = panel.getByRole('button', { name: fixtureId === 'D01' ? 'Show fixed sample result' : 'Show held sample' });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('heading', { name: fixtureId === 'D01' ? 'Sample result' : 'Sample held' })).toBeVisible();
    if (fixtureId === 'D01') {
      await expect(panel.getByText('Q intermediate.', { exact: true })).toBeVisible();
      await expect(panel.getByRole('row', { name: 'CYP2C19 *1/*2' })).toBeVisible();
    } else {
      await expect(panel.getByText('Sample reason: alignment-unsupported')).toBeVisible();
      await expect(panel.getByText('Test Drug Q', { exact: true })).toHaveCount(0);
      await expect(panel.getByRole('table')).toHaveCount(0);
    }
    await expect(panel.getByText(/No capture approval or evaluation has been recorded/)).toBeVisible();
    await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
    const violations = await page.evaluate(async () => {
      // @ts-expect-error axe is injected into this local synthetic browser check
      return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((violation: { id: string }) => violation.id);
    });
    expect(violations).toEqual([]);
    const layout = await panel.evaluate((element) => ({
      font: getComputedStyle(element).fontFamily,
      controls: [...element.querySelectorAll('button')].filter((button) => button.getClientRects().length > 0).map((button) => button.getBoundingClientRect().height),
      overflow: element.scrollWidth > element.clientWidth,
    }));
    expect(layout.font).toMatch(/Inter/);
    expect(layout.controls.every((height) => height >= 44)).toBe(true);
    expect(layout.overflow).toBe(false);
    await panel.getByRole('heading', { name: fixtureId === 'D01' ? 'Sample result' : 'Sample held' }).evaluate((element) => element.scrollIntoView({ block: 'start' }));
    if (process.env.PRODUCT_DEMO_SCREENSHOTS === 'true') await page.screenshot({ path: test.info().outputPath(`${fixtureId}.png`), fullPage: false });
    expect(processingRequests).toBe(0);
    const refused = await page.request.post(`${fixture.api}/api/v1/reports/${stored.id}/capture`, { headers: fixture.headers });
    expect(refused.status()).toBe(503);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByRole('button', { name: 'Hide fixed sample' }).click();
    await expect(panel.getByRole('heading', { name: /Sample result|Sample held/ })).toHaveCount(0);
  });
}
