import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInWithPatient } from './helpers';

async function fill(page: Page, patientId: string, type: 'vcf' | 'structured', name: string, bytes: Buffer) {
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(patientId);
  await page.getByLabel(/report type/i).selectOption(type);
  await page.getByLabel(/report file/i).setInputFiles({ name, mimeType: type === 'vcf' ? 'text/plain' : 'application/json', buffer: bytes });
  await page.getByLabel(/synthetic data only/i).check();
}
async function stored(page: Page, fixture: Awaited<ReturnType<typeof signInWithPatient>>) {
  const response = await page.request.get(`${fixture.api}/api/v1/reports?patientId=${fixture.id}&pageSize=100`, { headers: fixture.headers });
  expect(response.status()).toBe(200);
  return (await response.json()).data as { id: string; patientId: string; fileUploaded: boolean; sha256: string; sizeBytes: number; contentType: string }[];
}

test('VCF completes through real HTTP storage, omits API credentials, and a new upload gets a new report', async ({ page }) => {
  const fixture = await signInWithPatient(page); const bytes = Buffer.from('##fileformat=VCFv4.2\n');
  const credentials: boolean[] = [];
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).port === '5557') {
      const headers = request.headers(); credentials.push(Boolean(headers.authorization || headers.cookie));
    }
  });
  await fill(page, fixture.id, 'vcf', 'synthetic.vcf', bytes);
  await page.screenshot({ path: `test-results/screens/upload-form-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  let reports = await stored(page, fixture); expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ patientId: fixture.id, fileUploaded: true, sizeBytes: bytes.length,
    contentType: 'text/x-vcf', sha256: createHash('sha256').update(bytes).digest('hex') });
  await page.screenshot({ path: `test-results/screens/upload-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Upload another report' }).click();
  await fill(page, fixture.id, 'vcf', 'synthetic.vcf', bytes); await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  reports = await stored(page, fixture); expect(reports).toHaveLength(2); expect(reports[0]!.id).not.toBe(reports[1]!.id);
  expect(credentials).toEqual([false, false]);
});

test('lost registration and completion replies recover one JSON report without a second PUT', async ({ page }) => {
  const fixture = await signInWithPatient(page); const bytes = Buffer.from('{"synthetic":true}');
  const requestKeys: string[] = []; let completions = 0; let puts = 0;
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).port === '5557') puts++; });
  await page.route('**/api/v1/reports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requestKeys.push(route.request().postDataJSON().requestId);
    if (requestKeys.length === 1) { const reply = await route.fetch(); expect(reply.status()).toBe(201); return route.abort('failed'); }
    return route.continue();
  });
  await page.route('**/api/v1/reports/*/complete', async route => {
    completions++; const reply = await route.fetch(); expect(reply.status()).toBe(200); await route.abort('failed');
  });
  await fill(page, fixture.id, 'structured', 'synthetic.json', bytes);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByRole('alert')).toContainText('interrupted');
  expect(await stored(page, fixture)).toHaveLength(1);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByRole('alert')).toContainText('interrupted');
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const reports = await stored(page, fixture); expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ fileUploaded: true, sizeBytes: bytes.length, contentType: 'application/json', sha256: createHash('sha256').update(bytes).digest('hex') });
  expect(requestKeys).toHaveLength(2); expect(requestKeys[0]).toBe(requestKeys[1]); expect(completions).toBe(1); expect(puts).toBe(1);
});

test('a failed transfer retains form inputs and retries with a fresh URL for the same report', async ({ page }) => {
  const fixture = await signInWithPatient(page); const urls: string[] = []; let targets = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/upload-url')) targets++; });
  await page.route('http://127.0.0.1:5557/**', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    urls.push(route.request().url());
    if (urls.length === 1) return route.fulfill({ status: 503 });
    return route.continue();
  });
  await fill(page, fixture.id, 'vcf', 'retry.vcf', Buffer.from('synthetic'));
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByRole('alert')).toContainText('File transfer failed');
  await expect(page.getByLabel(/synthetic patient \(required\)/i)).toHaveValue(fixture.id);
  await expect(page.getByLabel(/report type/i)).toHaveValue('vcf');
  await expect(page.getByLabel(/synthetic data only/i)).toBeChecked();
  expect((await stored(page, fixture))[0]!.fileUploaded).toBe(false);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const reports = await stored(page, fixture); expect(reports).toHaveLength(1); expect(reports[0]!.fileUploaded).toBe(true);
  expect(urls).toHaveLength(2); expect(targets).toBe(2);
  // The backend deliberately retains one object key; retry requests renewed authorization for it.
  expect(new URL(urls[0]!).pathname).toBe(new URL(urls[1]!).pathname);
});

test('an unexpected storage origin sends no file and cannot show upload success', async ({ page }) => {
  const fixture = await signInWithPatient(page); let externalRequests = 0;
  page.on('request', request => { if (new URL(request.url()).hostname === 'unexpected.example.invalid') externalRequests++; });
  await page.route('**/api/v1/reports/*/upload-url', async route => {
    const reply = await route.fetch(); expect(reply.status()).toBe(200);
    await route.fulfill({ json: { ...await reply.json(), uploadUrl: 'https://unexpected.example.invalid/file' } });
  });
  await fill(page, fixture.id, 'structured', 'refuse.json', Buffer.from('{}'));
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByRole('alert')).toContainText('No file was sent');
  await expect(page.getByText('Upload complete', { exact: true })).toHaveCount(0);
  expect(externalRequests).toBe(0); expect((await stored(page, fixture))[0]!.fileUploaded).toBe(false);
});
