import { expect, test } from '@playwright/test';
import { signInWithPatient } from './helpers';

test('older-backend 404 keeps sign-in and same-page upload retries working without recovery storage', async ({ page }) => {
  await page.route('**/api/v1/me/recovery-scope', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  const fixture = await signInWithPatient(page);
  let transfers = 0;
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', async route => {
    transfers++; const reply = await route.fetch(); expect(reply.status()).toBe(200); await route.abort('failed');
  });
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(fixture.id);
  await page.getByLabel(/report type/i).selectOption('structured');
  await page.getByLabel(/report file/i).setInputFiles({ name: 'compatibility-synthetic.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
  await page.getByLabel(/synthetic data only/i).check();
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload failed', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => [sessionStorage.getItem('telesphoros.upload-recovery.v1'), sessionStorage.getItem('telesphoros.upload-recovery.v2')])).toEqual([null, null]);
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  expect(transfers).toBe(1);
});

test('repaired API preserves the legacy /me body and separately authenticates recovery scope', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const me = await page.request.get(fixture.api + '/api/v1/me', { headers: fixture.headers });
  expect(me.status()).toBe(200); expect(await me.json()).toEqual({ roles: ['clinician'] });
  const scope = await page.request.get(fixture.api + '/api/v1/me/recovery-scope', { headers: fixture.headers });
  expect(scope.status()).toBe(200); expect(await scope.json()).toEqual({ recoveryScope: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect((await page.request.get(fixture.api + '/api/v1/me/recovery-scope')).status()).toBe(401);
});
