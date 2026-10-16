import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNavigation, signInAs, signInWithPatient } from '../e2e/helpers';

async function storageInventory() {
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const { S3Client, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({ endpoint: 'http://127.0.0.1:5557', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
  const versions: string[] = []; let keyMarker: string | undefined; let versionMarker: string | undefined;
  try {
    for (let page = 0; page < 100; page++) {
      const result = await client.send(new ListObjectVersionsCommand({ Bucket: `synthetic-storage-${process.env.L2_BROWSER_RUN_ID}`, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
      for (const item of [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]) versions.push(`${item.Key}:${item.VersionId}`);
      if (!result.IsTruncated) return versions.sort();
      if (!result.NextKeyMarker) throw new Error('Incomplete version inventory');
      keyMarker = result.NextKeyMarker; versionMarker = result.NextVersionIdMarker;
    }
    throw new Error('Version inventory exceeded its bound');
  } finally { client.destroy(); }
}

const samples = [
  { type: 'lab-pdf', name: 'synthetic.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n') },
  { type: 'vcf', name: 'synthetic.vcf', mime: 'text/x-vcf', bytes: Buffer.from('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n') },
  { type: 'structured', name: 'synthetic.json', mime: 'application/json', bytes: Buffer.from('{"synthetic":true}') },
];
async function fill(page: Page, patient: string, sample: typeof samples[number]) {
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(patient);
  await page.getByLabel(/report type/i).selectOption(sample.type);
  await page.getByLabel(/report file/i).setInputFiles({ name: sample.name, mimeType: sample.mime, buffer: sample.bytes });
  await page.getByLabel(/synthetic data only/i).check();
}
async function rows(page: Page, fixture: Awaited<ReturnType<typeof signInWithPatient>>) {
  const response = await page.request.get(`${fixture.api}/api/v1/reports?patientId=${fixture.id}`, { headers: fixture.headers });
  expect(response.status()).toBe(200); return (await response.json()).data;
}
async function findReport(page: Page, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await expect(page.getByRole('button', { name: 'Refresh reports' })).toHaveAttribute('aria-disabled', 'false');
    const trigger = page.getByTestId(`report-${id}`);
    if (await trigger.count()) { await trigger.click(); return page.getByRole('region', { name: 'Report details', exact: true }); }
    const next = page.getByRole('button', { name: 'Next report page', exact: true });
    if (await next.getAttribute('aria-disabled') === 'true') break;
    await next.click();
  }
  throw new Error('Synthetic report not found within bounded pages.');
}
for (const sample of samples) test(`${sample.type}: browser intake, verified attachment bytes, no storage credentials`, async ({ page }) => {
  const fixture = await signInWithPatient(page);
  let storagePuts = 0; let authenticatedGets = 0; let downloadedVersion = false;
  page.on('request', req => {
    if (new URL(req.url()).port === '5557') {
      if (req.method() === 'PUT') storagePuts++;
      if (req.headers().authorization || req.headers().cookie || req.headers().referer) authenticatedGets++;
      if (req.method() === 'GET') downloadedVersion ||= new URL(req.url()).searchParams.has('versionId');
    }
  });
  await fill(page, fixture.id, sample);
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const reports = await rows(page, fixture); expect(reports).toHaveLength(1);
  const clinical = await page.request.post(`${fixture.api}/api/v1/reports/${reports[0].id}/capture`, { headers: fixture.headers }); expect(clinical.status()).toBe(503);
  expect(reports[0]).toMatchObject({ fileUploaded: true, sha256: createHash('sha256').update(sample.bytes).digest('hex'), contentType: sample.mime, status: 'received' });
  await page.getByRole('link', { name: 'View reports' }).click();
  const item = await findReport(page, reports[0].id);
  const downloaded = page.waitForEvent('download');
  await item.getByRole('button', { name: `Download ${sample.name}`, exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(sample.name);
  expect(await readFile((await download.path())!)).toEqual(sample.bytes);
  expect(storagePuts).toBe(0); expect(authenticatedGets).toBe(0); expect(downloadedVersion).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('lost registration, declaration and byte replies recover one report with one transfer', async ({ page }) => {
  const fixture = await signInWithPatient(page); let registrations = 0; let declarations = 0; let puts = 0;
  for (const suffix of ['reports', 'reports/*/upload-attempts', 'reports/*/upload-attempts/*/bytes']) {
    await page.route(`**/api/v1/${suffix}`, async route => {
      if (!['POST', 'PUT'].includes(route.request().method())) return route.continue();
      let lose: boolean;
      if (suffix === 'reports') lose = ++registrations === 1;
      else if (suffix.endsWith('bytes')) { puts++; lose = true; }
      else lose = ++declarations === 1;
      if (!lose) return route.continue();
      const reply = await route.fetch(); expect(reply.ok()).toBe(true); await route.abort('failed');
    });
  }
  await fill(page, fixture.id, samples[2]!);
  for (let retry = 0; retry < 3; retry++) {
    await page.getByRole('button', { name: 'Upload report', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  expect(await rows(page, fixture)).toHaveLength(1); expect(puts).toBe(1); expect(registrations).toBe(2); expect(declarations).toBe(2);
});

test('cancel after an interrupted transfer receives acknowledgement and permits starting over', async ({ page }) => {
  const fixture = await signInWithPatient(page); let cancels = 0;
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', route => route.abort('failed'));
  page.on('request', req => { if (req.url().endsWith('/cancel')) cancels++; });
  await fill(page, fixture.id, samples[2]!);
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a new upload' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Upload cancelled');
  await expect(page.getByRole('button', { name: 'Start a new upload' })).toBeEnabled();
  expect(cancels).toBe(1); expect((await rows(page, fixture))[0].fileUploaded).toBe(false);
});

test('malformed file refused by server without verified success or any direct-upload route', async ({ page }) => {
  const fixture = await signInWithPatient(page); let legacy = 0;
  const before = await storageInventory();
  page.on('request', req => { if (req.url().endsWith('/upload-url')) legacy++; });
  await fill(page, fixture.id, { ...samples[2]!, bytes: Buffer.from('{"bad":') });
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('server refused');
  expect((await rows(page, fixture))[0].fileUploaded).toBe(false); expect(legacy).toBe(0);
  expect(await storageInventory()).toEqual(before);
});

test('reader sees metadata but cannot request a file or upload', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  await fill(page, fixture.id, samples[2]!); await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const report = (await rows(page, fixture))[0];
  await page.getByRole('button', { name: /sign out/i }).click();
  const me = page.waitForResponse(res => res.url().endsWith('/api/v1/me'));
  await signInAs(page, 'bob', '/reports');
  const reply = await me; const headers = { Authorization: reply.request().headers().authorization! };
  await expect(page.getByText('Your role can view report metadata only.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Download / })).toHaveCount(0);
  await expect(page.getByTestId(`report-${report.id}`)).toHaveCount(0);
  const foreign = await page.request.get(`${fixture.api}/api/v1/reports/${report.id}`, { headers }); expect(foreign.status()).toBe(404);
  const refused = await page.request.get(`${fixture.api}/api/v1/reports/${report.id}/download-url`, { headers }); expect(refused.status()).toBe(403);
});


test('reports pagination, keyboard download, reviewer access and accessibility', async ({ page }) => {
  const fixture = await signInWithPatient(page); const sample = samples[2]!;
  await fill(page, fixture.id, sample); await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const report = (await rows(page, fixture))[0];
  // Metadata-only rows prove bounded paging without adding storage writes or clinical records.
  for (let index = 0; index < 21; index++) {
    const response = await page.request.post(`${fixture.api}/api/v1/reports`, { headers: fixture.headers, data: { patientId: fixture.id, type: 'structured', filename: `page-${index}.json`, sizeBytes: 2 } });
    expect(response.status()).toBe(201);
  }
  await page.getByRole('button', { name: /sign out/i }).click();
  await signInAs(page, 'gina', '/reports');
  await expect(page.getByRole('button', { name: 'Next report page', exact: true })).toHaveAttribute('aria-disabled', 'false');
  const require = createRequire(import.meta.url);
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe injected for this synthetic test
    return (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const button = (await findReport(page, report.id)).getByRole('button', { name: `Download ${report.filename}`, exact: true });
  await button.focus(); await expect(button).toBeFocused();
  const downloaded = page.waitForEvent('download'); await page.keyboard.press('Enter');
  expect(await readFile((await (await downloaded).path())!)).toEqual(sample.bytes);
  await page.screenshot({ path: `test-results/l2-reports-${test.info().project.name}.png`, fullPage: true });
  await openWorkspaceNavigation(page);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic report storage' })).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('Clinical processing is disabled');
  await expect(page.getByRole('link', { name: 'Upload a synthetic report' })).toHaveCount(0);
  await page.context().clearCookies(); await signInAs(page, 'gina', '/reports/upload');
  await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
});

test('a reload during the transfer finishes the same upload against the real database and bucket: one report, one stored version', async ({ page }) => {
  const fixture = await signInWithPatient(page); const sample = samples[1]!;
  const before = await storageInventory();
  let seen!: () => void; const arrived = new Promise<void>(resolve => { seen = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', async route => {
    if (!first) return route.continue();
    first = false; seen(); await released; await route.abort('failed');
  });
  await fill(page, fixture.id, sample);
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await arrived;
  expect(await storageInventory()).toEqual(before); // nothing is in the bucket yet
  release();
  await page.reload();
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/reports/upload');
  await expect(page.getByText('An upload was interrupted')).toBeVisible();
  for (let attempts = 0; attempts < 100; attempts++) { // the patient list is paged and starts on page 1 again after a reload
    await expect(page.getByRole('button', { name: 'Refresh patients' })).toBeEnabled();
    if (await page.getByRole('option', { name: fixture.label, exact: true }).count()) break;
    const next = page.getByRole('button', { name: 'Next patients' });
    if (!(await next.count()) || !(await next.isEnabled())) throw new Error('The fixture patient was not listed within the bounded test pages.');
    await next.click();
  }
  await fill(page, fixture.id, sample);
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const reports = await rows(page, fixture);
  expect(reports).toHaveLength(1); expect(reports[0].fileUploaded).toBe(true);
  expect((await storageInventory()).length - before.length).toBe(1); // exactly one stored version, from the one report
});
