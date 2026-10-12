// Acceptance-only process. Credentials travel over private IPC; no traces, URLs or page dumps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import axios from 'axios';
import { createPilotRouter } from '../dist/router.js';
import { createStoredPgxReader } from '../dist/stored-pgx.js';
import { terminologyIssues } from '../test/fhir-ig/terminology.js';
import { validate } from '../test/fhir-r4/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { chromium, expect } = createRequire(path.join(root, 'apps/frontend/package.json'))('@playwright/test');
const runtime = path.join(root, 'packages/smart-pilot/openemr/.runtime');
const origin = 'http://127.0.0.1:8767';
let browser, context, chart, page, server, settings;
const reads = { ehr: 0, backend: 0, pdf: 0, tokenExchanges: 0, unexpected: 0 };
let pdfUrl, diagnostic;
let step = 'initializing';
if (process.env.NODE_ENV !== 'test' || !process.send) throw new Error('Test IPC required');
// Observe the connector's actual transport. Never record bearer tokens, query strings or payloads.
axios.interceptors.request.use(request => {
  const url = new URL(request.url);
  const method = (request.method || 'get').toUpperCase();
  if (url.href === settings.registration.tokenEndpoint && method === 'POST') reads.tokenExchanges++;
  else if (method !== 'GET') reads.unexpected++;
  else if (url.href.startsWith(settings.registration.issuer + '/')) reads.ehr++;
  else if (url.href.startsWith(settings.config.apiBaseUrl + '/')) reads.backend++;
  else if (url.origin === settings.config.sourcePdf.storageOrigin) reads.pdf++;
  return request;
});
const link = () => page.getByRole('link', { name: 'Download verified synthetic source PDF' });
const preview = () => page.getByText('Versioned FHIR preview (synthetic only)', { exact: true });
async function startPilot(selection) {
  if (server) await new Promise(resolve => server.close(resolve));
  const registration = structuredClone(settings.registration);
  for (const patient of registration.patients) {
    // Retain the registration fixtures: failures must not fall back to them.
    patient.stored = selection;
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(createPilotRouter({ origin, registrations: { openemr: registration }, storedReader: createStoredPgxReader(settings.config), onDiagnostic: value => { diagnostic = value; } }));
  const dist = path.join(root, 'packages/smart-pilot/dist-ui');
  app.get('/smart/evidence', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  app.use(express.static(dist, { index: false }));
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(8767, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
}
async function launch(number) {
  await page?.close(); pdfUrl = undefined;
  await chart.bringToFront();
  step = 'chart-search';
  await chart.locator('#anySearchBox').fill('Synthetic');
  await chart.locator('#search_globals').click();
  step = 'chart-search-result';
  await chart.frameLocator('iframe[name="fin"]').getByText(new RegExp(`Pilot ${number}`)).first().waitFor();
  await chart.frameLocator('iframe[name="fin"]').getByText(`Pilot ${number}, Synthetic`, { exact: true }).click();
  const target = chart.frameLocator('iframe[name="pat"]').getByRole('link', { name: 'Open synthetic PGx review in a new tab' });
  step = 'chart-launch-link';
  await target.waitFor();
  await expect(target).toHaveAttribute('href', new RegExp(`[?&]pid=${910000 + number}(&|$)`));
  // Use the real chart link, including its EHR-issued launch context.
  step = 'chart-popup';
  const popup = context.waitForEvent('page');
  await target.click();
  page = await popup;
  await page.bringToFront();
  const password = page.locator('input[type="password"]');
  const authorize = page.locator('#authorize-btn');
  step = 'oauth-login-or-authorize';
  await expect(password.or(authorize)).toBeVisible({ timeout: 20000 });
  if (await password.isVisible()) {
    step = 'oauth-username';
    await page.locator('input[type="text"][name="username"]').fill('synthetic-admin');
    step = 'oauth-password';
    await password.fill(settings.password);
    step = 'oauth-submit';
    await page.locator('button[name="user_role"][value="api"]').click();
  }
  step = 'oauth-authorize';
  await authorize.click();
  step = 'callback';
  await page.waitForURL(url => url.origin === origin && url.pathname === '/smart/evidence');
  step = 'launch-context';
  await expect(page.getByRole('status')).toHaveText(number === 1 ? 'Synthetic context verified' : 'Genomic consent required', { timeout: 20000 });
  assert.equal(new URL(page.url()).hash, '');
  await expect(page.getByText(/Clinical recommendations are disabled/)).toBeVisible();
  await expect(page.getByText(settings.registration.patients[number - 1].fhirId, { exact: true })).toBeVisible();
}
async function active(expected) {
  step = 'active-evidence';
  await expect(page.getByRole('status')).toHaveText('Synthetic context verified', { timeout: 20000 });
  await expect(link()).toBeVisible();
  if (await page.locator('details').getAttribute('open') === null) await preview().click();
  const bundle = JSON.parse(await page.locator('pre').textContent());
  step = 'bundle-schema';
  assert.equal(validate(bundle), true);
  assert.deepEqual(terminologyIssues(bundle), []);
  step = 'bundle-identity';
  assert.equal(bundle.entry.filter(e => e.resource.resourceType === 'Observation').length, 4);
  assert.ok(JSON.stringify(bundle).includes(expected.evaluationId));
  assert.ok(!JSON.stringify(bundle).includes('synthetic-evaluation-2'));
  const document = bundle.entry.find(e => e.resource.resourceType === 'DocumentReference').resource;
  step = 'pdf-identity';
  assert.ok(document.extension.some(e => e.valueString === expected.version));
  assert.equal(document.content[0].attachment.data, settings.pdf);
  assert.equal(document.content[0].attachment.url, undefined);
  pdfUrl = await link().getAttribute('href');
  assert.ok(pdfUrl.startsWith('blob:' + origin));
  step = 'download-verified-pdf';
  const downloaded = page.waitForEvent('download');
  await link().click();
  const download = await downloaded;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('base64'), settings.pdf);
  await download.delete();
  await expect(page.getByText('Stored synthetic evaluation.', { exact: true })).toBeVisible();
}
async function cleared() {
  await expect(link()).toHaveCount(0);
  await expect(preview()).toHaveCount(0);
  await expect(page.locator('pre')).toHaveCount(0);
  await expect(page.getByText(/^CYP2(?:B6|C19):/)).toHaveCount(0);
  if (pdfUrl) assert.equal(await page.evaluate(url => window.__workflowRevoked.includes(url), pdfUrl), true);
}
async function close() {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
async function command(message) {
  switch (message.action) {
    case 'start': {
      settings = message;
      assert.equal(settings.registration.clientId, 'synthetic-telesphoros');
      assert.equal(settings.registration.issuer, 'http://127.0.0.1:8301/apis/default/fhir');
      assert.deepEqual(settings.registration.patients.map(p => p.syntheticIdentifier), ['TSP-SYNTHETIC-1', 'TSP-SYNTHETIC-2']);
      assert.deepEqual(settings.registration.patients.map(p => p.consent), [true, false]);
      settings.password = fs.readFileSync(path.join(runtime, 'docker.env'), 'utf8').match(/^PILOT_ADMIN_PASSWORD=(.+)$/m)?.[1];
      assert.ok(settings.password);
      step = 'pilot-listen';
      await startPilot(message.selection);
      step = 'browser-login';
      browser = await chromium.launch({ headless: true, ...(process.env.WORKFLOW_BROWSER_CHANNEL ? { channel: process.env.WORKFLOW_BROWSER_CHANNEL } : {}) });
      context = await browser.newContext();
      // Observe native revocation, without bypassing the viewer's CSP or mocking evidence.
      await context.addInitScript(() => {
        window.__workflowRevoked = [];
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = url => { window.__workflowRevoked.push(url); revoke(url); };
      });
      context.setDefaultTimeout(20000);
      chart = await context.newPage();
      await chart.goto('http://127.0.0.1:8301/interface/login/login.php');
      await chart.locator('#authUser').fill('synthetic-admin');
      await chart.locator('#clearPass').fill(settings.password);
      await chart.locator('#login-button').click();
      await chart.locator('iframe[name="cal"]').waitFor();
      const dismiss = chart.getByRole('button', { name: 'Ask again later' });
      await dismiss.waitFor({ timeout: 3000 }).catch(() => {});
      if (await dismiss.isVisible()) await dismiss.click();
      await launch(1);
      await active(message);
      break;
    }
    case 'withheld':
      // No button/clock interception: wait for the real 15-second periodic recheck.
      await expect(page.getByText(new RegExp(`State: ${message.state}\\.`))).toBeVisible({ timeout: 25000 });
      await expect(page.getByRole('status')).toHaveText('Selected evaluation evidence is withheld');
      await cleared();
      if (message.absent) assert.ok(!(await page.locator('body').textContent()).includes(message.absent));
      break;
    case 'active':
      await page.getByRole('button', { name: 'Recheck evidence' }).click();
      await active(message);
      break;
    case 'offline':
      await context.setOffline(true);
      await expect(page.getByRole('status')).toContainText('View paused');
      await cleared();
      break;
    case 'online':
      await context.setOffline(false);
      await active(message);
      break;
    case 'relaunch':
      await page.close(); page = undefined; pdfUrl = undefined;
      await startPilot(message.selection); // explicit operator selection, then a NEW chart launch
      await launch(1);
      await active(message);
      break;
    case 'unavailable':
      await page.getByRole('button', { name: 'Recheck evidence' }).click();
      await expect(page.getByRole('status')).toContainText('Context could not be verified', { timeout: 20000 });
      await cleared();
      await expect(page.getByRole('heading', { name: 'Selected evaluation history' })).toHaveCount(0);
      break;
    case 'consent': {
      const before = reads.backend;
      await launch(2);
      await cleared();
      assert.equal(reads.backend, before);
      await expect(page.getByRole('heading', { name: 'Selected evaluation history' })).toHaveCount(0);
      break;
    }
    case 'close': await close(); break;
    default: throw new Error('Unknown acceptance command');
  }
  return { ...reads };
}
process.on('message', async message => {
  try { step = message.action; process.send({ ok: true, reads: await command(message) }); }
  catch { process.send({ ok: false, step: `${step}/${diagnostic?.code || 'browser-assertion'}` }); }
});
process.on('disconnect', () => { void close().finally(() => process.exit()); });
