import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { signInWithPatient } from '../e2e/helpers';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Runs after both viewport projects: deliberately adding a newer version makes the
// owned run's inventory refuse further intake. Keep that invariant intact.
test('a newer object version cannot replace the verified attachment', async ({ page }) => {
  const fixture = await signInWithPatient(page); const bytes = Buffer.from('{"synthetic":true}');
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(fixture.id);
  await page.getByLabel(/report type/i).selectOption('structured');
  await page.getByLabel(/report file/i).setInputFiles({ name: 'pinned.json', mimeType: 'application/json', buffer: bytes });
  await page.getByLabel(/synthetic data only/i).check();
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const response = await page.request.get(`${fixture.api}/api/v1/reports?patientId=${fixture.id}`, { headers: fixture.headers });
  const report = (await response.json()).data[0];
  await page.route('**/api/v1/reports/*/download-url', async route => {
    const reply = await route.fetch(); expect(reply.ok()).toBe(true);
    const link = await reply.json(); const url = new URL(link.url);
    expect(url.origin).toBe(process.env.E2E_REPORT_STORAGE_ORIGIN ?? 'http://127.0.0.1:5557'); expect(url.searchParams.has('versionId')).toBe(true);
    const [, bucket, ...key] = url.pathname.split('/');
    expect(bucket).toBe(`synthetic-storage-${process.env.L2_BROWSER_RUN_ID}`);
    const client = new S3Client({ endpoint: url.origin, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
    try {
      const changed = await client.send(new PutObjectCommand({ Bucket: bucket, Key: decodeURIComponent(key.join('/')), Body: Buffer.from('{"newer":true}'), ContentType: 'application/json' }));
      expect(changed.VersionId).toBeTruthy(); expect(changed.VersionId).not.toBe(url.searchParams.get('versionId'));
    } finally { client.destroy(); }
    await route.fulfill({ response: reply });
  });
  await page.getByRole('link', { name: 'View reports' }).click();
  const trigger = page.getByTestId(`report-${report.id}`);
  for (let attempt = 0; attempt < 100; attempt++) {
    await expect(page.getByRole('button', { name: 'Refresh reports' })).toHaveAttribute('aria-disabled', 'false');
    if (await trigger.count()) break;
    const next = page.getByRole('button', { name: 'Next report page', exact: true });
    if (await next.getAttribute('aria-disabled') === 'true') break;
    await next.click();
  }
  await trigger.click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('region', { name: 'Report details', exact: true }).getByRole('button', { name: 'Download pinned.json', exact: true }).click();
  expect(await readFile((await (await downloaded).path())!)).toEqual(bytes);
});
