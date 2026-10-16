import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNavigation, signInWithPatient } from './helpers';

const STORAGE_ORIGIN = process.env.E2E_REPORT_STORAGE_ORIGIN ?? 'http://127.0.0.1:5557';

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
    if (url.origin === STORAGE_ORIGIN) storage.push(`${request.method()} ${url.pathname}`);
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
  page.on('request', request => { if (new URL(request.url()).origin === STORAGE_ORIGIN) storage.push(request.method()); });
  await fill(page, fixture.id, 'structured', 'refuse.json', Buffer.from('{"bad":'));
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByRole('alert')).toContainText('server refused');
  await expect(page.getByText('Upload complete', { exact: true })).toHaveCount(0);
  expect((await stored(page, fixture))[0]!.fileUploaded).toBe(false); expect(storage).toEqual([]);
});

// --- Reload recovery (M2.2c) ---------------------------------------------------------------------------------------------------------------------------
// A reload signs the app out locally and signs in again instantly; the tab keeps one small record of the interrupted upload.

const RECOVERY_KEY = 'telesphoros.upload-recovery.v2';
const VCF = Buffer.from('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n');

/**
 * Holds the first transfer request (it never reaches the server) until `interrupt()` is called, which fails it the way a closing tab does; later requests pass.
 * `arrived` resolves when the request has been seen, so the test can reload while the bytes are "on their way".
 */
async function holdTransfer(page: Page) {
  let seen!: () => void; const arrived = new Promise<void>(resolve => { seen = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', async route => {
    if (!first) return route.continue();
    first = false; seen(); await released; await route.abort('failed');
  });
  return { arrived, interrupt: () => release() };
}
async function reloadAndSignIn(page: Page, interrupt?: () => void) {
  interrupt?.();
  await page.reload();
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/reports/upload');
  await expect(page.getByRole('heading', { level: 1, name: 'Upload report' })).toBeVisible();
}
async function reselect(page: Page, fixture: { id: string; label: string }, name: string, bytes: Buffer) {
  // The patient list is paged; after a reload it starts on page 1 again, so walk to the page that holds the fixture patient.
  for (let attempts = 0; attempts < 100; attempts++) {
    await expect(page.getByRole('button', { name: 'Refresh patients' })).toBeEnabled();
    if (await page.getByRole('option', { name: fixture.label, exact: true }).count()) break;
    const next = page.getByRole('button', { name: 'Next patients' });
    if (!(await next.count()) || !(await next.isEnabled())) throw new Error('The fixture patient was not listed within the bounded test pages.');
    await next.click();
  }
  await fill(page, fixture.id, 'vcf', name, bytes);
}

test('a reload during the transfer finishes the same upload: one report, one stored file, the same declaration, and nothing sensitive kept', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const registrations: string[] = []; const declarations: string[] = []; let transfers = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/reports')) registrations.push(request.postData() ?? '');
    if (request.method() === 'POST' && request.url().endsWith('/upload-attempts')) declarations.push(request.postData() ?? '');
    if (request.method() === 'PUT' && request.url().endsWith('/bytes')) transfers++;
  });
  const held = await holdTransfer(page);
  await fill(page, fixture.id, 'vcf', 'reload.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await held.arrived;
  const kept = await page.evaluate(key => window.sessionStorage.getItem(key), RECOVERY_KEY);
  expect(kept).toBeTruthy();
  expect(kept).not.toContain(fixture.id);
  expect(kept).not.toMatch(/Bearer|eyJ|patientId|uploadUrl|X-Amz/i);
  expect(JSON.parse(kept!)).toMatchObject({ v: 2, scope: expect.stringMatching(/^[0-9a-f]{64}$/), file: { name: 'reload.vcf', sizeBytes: VCF.length, reportType: 'vcf', sha256: createHash('sha256').update(VCF).digest('hex') } });
  expect((await stored(page, fixture))[0]!.fileUploaded).toBe(false);

  await reloadAndSignIn(page, held.interrupt);
  await expect(page.getByText('An upload was interrupted')).toBeVisible();
  await expect(page.getByText('reload.vcf', { exact: true })).toBeVisible();
  await page.screenshot({ path: `test-results/screens/upload-interrupted-${test.info().project.name}.png`, fullPage: true });
  await reselect(page, fixture, 'reload.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();

  const reports = await stored(page, fixture);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ fileUploaded: true, sizeBytes: VCF.length, sha256: createHash('sha256').update(VCF).digest('hex') });
  expect(registrations).toHaveLength(1); // the reload did not register a second report
  expect(declarations).toHaveLength(2); expect(declarations[0]).toBe(declarations[1]); // the original declaration was replayed
  expect(transfers).toBe(2); // the held one never reached the server
  expect(await page.evaluate(key => window.sessionStorage.getItem(key), RECOVERY_KEY)).toBeNull();
});

test('a reload after the server stored the file finishes without sending it again', async ({ page }) => {
  const fixture = await signInWithPatient(page); let transfers = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/bytes')) transfers++; });
  let replied!: () => void; const stored$ = new Promise<void>(resolve => { replied = resolve; });
  let lose!: () => void; const lost = new Promise<void>(resolve => { lose = resolve; });
  let first = true;
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', async route => {
    if (!first) return route.continue();
    first = false; const reply = await route.fetch(); expect(reply.status()).toBe(200); replied(); await lost; await route.abort('failed'); // the server stored it; the reply never arrives
  });
  await fill(page, fixture.id, 'vcf', 'stored.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await stored$;

  await reloadAndSignIn(page, lose);
  await reselect(page, fixture, 'stored.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  expect(await stored(page, fixture)).toHaveLength(1);
  expect(transfers).toBe(1);
});

test('a different patient or file after a reload is refused until the interrupted upload is finished or cancelled', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const held = await holdTransfer(page);
  await fill(page, fixture.id, 'vcf', 'first.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await held.arrived;
  await reloadAndSignIn(page, held.interrupt);
  await reselect(page, fixture, 'second.vcf', Buffer.concat([VCF, Buffer.from('1\t100\t.\tA\tG\t.\t.\t.\n')]));
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByRole('alert')).toContainText('interrupted upload of another file');
  expect(await stored(page, fixture)).toHaveLength(1);
});

test('cancelling the interrupted upload after a reload leaves nothing stored, clears the record, and the next upload works', async ({ page }) => {
  const fixture = await signInWithPatient(page); let cancels = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/cancel')) cancels++; });
  const held = await holdTransfer(page);
  await fill(page, fixture.id, 'vcf', 'cancel.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await held.arrived;
  await reloadAndSignIn(page, held.interrupt);
  await page.getByRole('button', { name: 'Cancel the interrupted upload' }).click();
  await expect(page.getByText('The interrupted upload was cancelled. You can start a new one.')).toBeVisible();
  await expect(page.getByText('An upload was interrupted')).toHaveCount(0);
  expect(cancels).toBe(1);
  expect(await page.evaluate(key => window.sessionStorage.getItem(key), RECOVERY_KEY)).toBeNull();
  expect((await stored(page, fixture)).every(report => !report.fileUploaded)).toBe(true);

  await reselect(page, fixture, 'cancel.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const reports = await stored(page, fixture);
  expect(reports.filter(report => report.fileUploaded)).toHaveLength(1);
});

test('signing out clears an interrupted upload, so the next person on this tab is not offered it', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const held = await holdTransfer(page);
  await fill(page, fixture.id, 'vcf', 'signout.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await held.arrived;
  await reloadAndSignIn(page, held.interrupt);
  await expect(page.getByText('An upload was interrupted')).toBeVisible();
  await openWorkspaceNavigation(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signed-out$/);
  expect(await page.evaluate(key => window.sessionStorage.getItem(key), RECOVERY_KEY)).toBeNull();
});


test('a different verified caller after a 401 never sees or replays the previous upload', async ({ page, context }) => {
  const fixture = await signInWithPatient(page);
  const held = await holdTransfer(page);
  await fill(page, fixture.id, 'vcf', 'previous-caller.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await held.arrived;
  await reloadAndSignIn(page, held.interrupt);
  await expect(page.getByText('An upload was interrupted')).toBeVisible();
  const kept = await page.evaluate(key => sessionStorage.getItem(key), RECOVERY_KEY);
  expect(kept).toBeTruthy();
  await context.clearCookies(); // End only the synthetic IdP session; product sign-out would clear recovery itself.
  await page.route('**/api/v1/patients?*', route => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED' } } }), { times: 1 });
  await page.getByRole('button', { name: 'Refresh patients' }).click();
  await page.getByRole('button', { name: /Sign in as hal\b/ }).click();
  await page.waitForURL('**/reports/upload');
  await expect(page.getByRole('heading', { level: 1, name: 'Upload report' })).toBeVisible();
  await expect(page.getByText('previous-caller.vcf', { exact: true })).toHaveCount(0);
  await expect(page.getByText('An upload was interrupted')).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), RECOVERY_KEY)).toBeNull();
});

for (const invalid of ['legacy', 'expired'] as const) test(`${invalid} metadata is discarded before the upload route displays recovery`, async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const held = await holdTransfer(page);
  await fill(page, fixture.id, 'vcf', 'discard.vcf', VCF);
  await page.getByRole('button', { name: 'Upload report' }).click();
  await held.arrived;
  await page.evaluate(({ key, invalid }) => {
    const entry = JSON.parse(sessionStorage.getItem(key)!);
    if (invalid === 'legacy') {
      delete entry.scope; entry.v = 1;
      sessionStorage.removeItem(key);
      sessionStorage.setItem('telesphoros.upload-recovery.v1', JSON.stringify(entry));
    } else {
      entry.savedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      sessionStorage.setItem(key, JSON.stringify(entry));
    }
  }, { key: RECOVERY_KEY, invalid });
  await reloadAndSignIn(page, held.interrupt);
  await expect(page.getByText('discard.vcf', { exact: true })).toHaveCount(0);
  await expect(page.getByText('An upload was interrupted')).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), RECOVERY_KEY)).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('telesphoros.upload-recovery.v1'))).toBeNull();
});
