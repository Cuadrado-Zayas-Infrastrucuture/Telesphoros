import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceNavigation, signInWithPatient } from './helpers';

const REPORT = Buffer.from('{"synthetic":true}');
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function record(page: Page) {
  return page.evaluate(() => {
    const records = ['telesphoros.upload-recovery.v1', 'telesphoros.upload-recovery.v2'].map(key => sessionStorage.getItem(key)).filter(raw => raw !== null);
    if (records.length > 1) throw new Error('Multiple recovery records');
    return records.length ? JSON.parse(records[0]!) as { requestId: string; reportId: string; declaration?: { requestId: string }; file: { reportType: string; sizeBytes: number; sha256: string } } : null;
  });
}
async function fill(page: Page, fixture: { id: string; label: string }, name: string) {
  for (let count = 0; count < 100; count++) {
    await expect(page.getByRole('button', { name: 'Refresh patients' })).toBeEnabled();
    if (await page.getByRole('option', { name: fixture.label, exact: true }).count()) break;
    const next = page.getByRole('button', { name: 'Next patients' });
    if (!(await next.count()) || !(await next.isEnabled())) throw new Error('Synthetic patient not found');
    await next.click();
  }
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(fixture.id);
  await page.getByLabel(/report type/i).selectOption('structured');
  await page.getByLabel(/report file/i).setInputFiles({ name, mimeType: 'application/json', buffer: REPORT });
  await page.getByLabel(/synthetic data only/i).check();
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
}
async function navigateAwayAndBack(page: Page) {
  await openWorkspaceNavigation(page);
  await page.locator('header.workspace-navigation').getByRole('link', { name: /^Telesphoros/ }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await openWorkspaceNavigation(page);
  await page.getByRole('link', { name: 'Upload report', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/upload$/);
}
async function holdFirstTransfer(page: Page) {
  const arrived = latch(), released = latch(), done = latch(); let first = true;
  await page.route('**/api/v1/reports/*/upload-attempts/*/bytes', async route => {
    if (!first) return route.continue();
    first = false; arrived.release(); await released.promise;
    try { await route.abort('failed'); } finally { done.release(); }
  });
  return { arrived: arrived.promise, release: released.release, done: done.promise };
}

test('an abandoned registration cannot replace newer recovery, and the newer upload still retries', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const arrived = latch(), released = latch(), delivered = latch(); let oldId = '', registrations = 0, meCalls = 0;
  const declarations: string[] = [];
  page.on('request', req => { if (req.url().endsWith('/api/v1/me')) meCalls++; if (req.method() === 'POST' && req.url().endsWith('/upload-attempts')) declarations.push(req.postData()!); });
  await page.route('**/api/v1/reports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    registrations++;
    if (route.request().postDataJSON().filename !== 'navigation-old.json') return route.continue();
    const reply = await route.fetch(); expect(reply.status()).toBe(201); oldId = (await reply.json()).id;
    arrived.release(); await released.promise;
    try { await route.fulfill({ response: reply }); } finally { delivered.release(); }
  });
  const held = await holdFirstTransfer(page);
  try {
    await fill(page, fixture, 'navigation-old.json'); await arrived.promise;
    await navigateAwayAndBack(page);
    await fill(page, fixture, 'navigation-current.json'); await held.arrived;
    const kept = await record(page); expect(kept?.file).not.toHaveProperty('name'); expect(kept?.file.reportType).toBe('structured');
    const received = page.waitForResponse(reply => reply.url().endsWith('/api/v1/reports') && reply.request().postDataJSON()?.filename === 'navigation-old.json');
    released.release(); await delivered.promise; await received;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(await record(page)).toEqual(kept);
    expect(meCalls).toBe(0); // both navigations kept the same verified sign-in
    expect((await page.request.get(fixture.api + '/api/v1/reports/' + oldId, { headers: fixture.headers })).status()).toBe(200); // retirement never cancels/deletes server state
    held.release(); await held.done;
    await expect(page.getByText('Upload failed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Upload report', exact: true }).click();
    await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
    expect(registrations).toBe(2);
    expect(declarations).toHaveLength(2); expect(declarations[0]).toBe(declarations[1]);
    expect(await record(page)).toBeNull();
  } finally { released.release(); held.release(); }
});

test('navigation and reload retain original recovery keys and finish the same upload', async ({ page }) => {
  const fixture = await signInWithPatient(page), held = await holdFirstTransfer(page);
  let registrations = 0; const declarations: string[] = [];
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/v1/reports')) registrations++; if (req.method() === 'POST' && req.url().endsWith('/upload-attempts')) declarations.push(req.postData()!); });
  try {
    await fill(page, fixture, 'navigation-resume.json'); await held.arrived;
    const kept = await record(page);
    await navigateAwayAndBack(page); held.release(); await held.done;
    await expect(page.getByText('An upload was interrupted', { exact: true })).toBeVisible();
    expect(await record(page)).toEqual(kept);
    await page.reload(); await expect(page).toHaveURL(/\/signin$/);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL('**/reports/upload');
    await expect(page.getByText('An upload was interrupted', { exact: true })).toBeVisible();
    expect(await record(page)).toEqual(kept);
    await fill(page, fixture, 'navigation-resume.json');
    await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
    expect(registrations).toBe(1);
    expect(declarations).toHaveLength(2); expect(declarations[0]).toBe(declarations[1]);
    expect(await record(page)).toBeNull();
  } finally { held.release(); }
});

test('navigation keeps recovery cancellable and only server acknowledgement clears it', async ({ page }) => {
  const fixture = await signInWithPatient(page), held = await holdFirstTransfer(page);
  const cancelArrived = latch(), releaseCancel = latch(); let cancels = 0;
  await page.route('**/api/v1/reports/*/upload-attempts/*/cancel', async route => {
    cancels++; const reply = await route.fetch(); expect(reply.status()).toBe(200); cancelArrived.release(); await releaseCancel.promise; await route.fulfill({ response: reply });
  });
  try {
    await fill(page, fixture, 'navigation-cancel.json'); await held.arrived;
    const kept = await record(page);
    await navigateAwayAndBack(page); held.release(); await held.done;
    await page.getByRole('button', { name: 'Cancel the interrupted upload', exact: true }).click(); await cancelArrived.promise;
    expect(await record(page)).toEqual(kept);
    releaseCancel.release();
    await expect(page.getByText('The interrupted upload was cancelled. You can start a new one.', { exact: true })).toBeVisible();
    expect(cancels).toBe(1); expect(await record(page)).toBeNull();
    await fill(page, fixture, 'navigation-cancel.json'); await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  } finally { held.release(); releaseCancel.release(); }
});
