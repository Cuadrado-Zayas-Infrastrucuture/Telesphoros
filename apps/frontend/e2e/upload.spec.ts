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

test('VCF completes through the validated intake with no browser request to object storage, and a new upload gets a new report', async ({ page }) => {
  const fixture = await signInWithPatient(page); const bytes = Buffer.from('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n');
  const storage: string[] = []; const transfers: string[] = []; const legacy: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.port === '5557') storage.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'PUT' && url.pathname.endsWith('/bytes')) transfers.push(url.pathname);
    if (/\/(upload-url|complete)$/.test(url.pathname)) legacy.push(url.pathname);
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
  expect(transfers).toHaveLength(2); expect(storage).toEqual([]); expect(legacy).toEqual([]);
});

test('lost registration and transfer replies recover one JSON report without a second transfer', async ({ page }) => {
  const fixture = await signInWithPatient(page); const bytes = Buffer.from('{"synthetic":true}');
  const requestKeys: string[] = []; let transfers = 0;
  await page.route('**/api/v1/reports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requestKeys.push(route.request().postDataJSON().requestId);
    if (requestKeys.length === 1) { const reply = await route.fetch(); expect(reply.status()).toBe(201); return route.abort('failed'); }
    return route.continue();
  });
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', async route => {
    transfers++; const reply = await route.fetch(); expect(reply.status()).toBe(200); await route.abort('failed'); // the server stored it; the browser never heard
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
  expect(requestKeys).toHaveLength(2); expect(requestKeys[0]).toBe(requestKeys[1]); expect(transfers).toBe(1);
});

test('a refused transfer retains form inputs and retries for the same report with the same declaration', async ({ page }) => {
  const fixture = await signInWithPatient(page); let transfers = 0; const declarations: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/upload-attempts')) declarations.push(request.postData() ?? ''); });
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', async route => {
    transfers++;
    if (transfers === 1) return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } });
    return route.continue();
  });
  await fill(page, fixture.id, 'vcf', 'retry.vcf', Buffer.from('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n'));
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByRole('alert')).toContainText('server refused or interrupted');
  await expect(page.getByLabel(/synthetic patient \(required\)/i)).toHaveValue(fixture.id);
  await expect(page.getByLabel(/report type/i)).toHaveValue('vcf');
  await expect(page.getByLabel(/synthetic data only/i)).toBeChecked();
  expect((await stored(page, fixture))[0]!.fileUploaded).toBe(false);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const reports = await stored(page, fixture); expect(reports).toHaveLength(1); expect(reports[0]!.fileUploaded).toBe(true);
  expect(transfers).toBe(2); expect(declarations).toHaveLength(2); expect(declarations[0]).toBe(declarations[1]); // the same declaration is replayed, not a new attempt
});

test('a malformed file is refused by the server and cannot show upload success', async ({ page }) => {
  const fixture = await signInWithPatient(page); const storage: string[] = [];
  page.on('request', request => { if (new URL(request.url()).port === '5557') storage.push(request.method()); });
  await fill(page, fixture.id, 'structured', 'refuse.json', Buffer.from('{"bad":'));
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByRole('alert')).toContainText('server refused');
  await expect(page.getByText('Upload complete', { exact: true })).toHaveCount(0);
  expect((await stored(page, fixture))[0]!.fileUploaded).toBe(false); expect(storage).toEqual([]);
});
