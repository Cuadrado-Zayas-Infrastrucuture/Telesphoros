import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types';
import { signInAs } from '../e2e/helpers';

// No timing assertion: report matched measurements, never make network speed a correctness gate.
test('synthetic patient loading, first visit and return visit', async ({ browser }, testInfo) => {
  const seed = await browser.newPage();
  const me = seed.waitForResponse((response) => response.url().endsWith('/api/v1/me'));
  await signInAs(seed, 'alice', '/workspace');
  const authenticated = await me;
  const api = new URL(authenticated.url()).origin;
  const headers = { Authorization: authenticated.request().headers().authorization };
  const created = await seed.request.post(`${api}/api/v1/patients`, { headers, data: { label: `SYN-PERF-${crypto.randomUUID().slice(0, 8)}` } });
  expect(created.status()).toBe(201);
  const patient = await created.json();
  const path = `/api/v1/patients/${patient.id}`;
  expect(
    (
      await seed.request.post(api + path + '/demographics', {
        headers,
        data: { requestId: crypto.randomUUID(), givenName: 'Synthetic', familyName: 'Performance', dateOfBirth: '1980-01-01', sex: 'female', ethnicity: ['white'] },
      })
    ).status(),
  ).toBe(201);
  for (const drug of BUNDLED_DRUG_LIST.entries.slice(0, 20)) {
    expect(
      (
        await seed.request.post(api + path + '/medications', {
          headers,
          data: {
            requestId: crypto.randomUUID(),
            rxcui: drug.rxcui,
            listVersion: BUNDLED_DRUG_LIST.version,
            status: 'active',
            source: 'clinician-entered',
            startMonth: null,
            stopMonth: null,
          },
        })
      ).status(),
    ).toBe(201);
  }
  const endpoints = [];
  for (let sample = 0; sample < 5; sample++) {
    for (const suffix of ['', '/demographics', '/medications']) {
      const started = performance.now();
      const response = await seed.request.get(api + path + suffix, { headers });
      expect(response.status()).toBe(200);
      await response.body();
      endpoints.push({ sample, endpoint: suffix || '/identity', elapsedMs: performance.now() - started, cacheControl: response.headers()['cache-control'] ?? null });
    }
  }
  await seed.close();
  const samples = [];
  for (const latencyMs of [0, 120]) {
    for (let sample = 0; sample < 5; sample++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: latencyMs, downloadThroughput: -1, uploadThroughput: -1 });
      let records = [];
      const inFlight = new Map();
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() !== 'GET' || (url.pathname !== '/api/v1/patients' && !url.pathname.startsWith(path))) return;
        const record = {
          endpoint: url.pathname === path ? '/identity' : url.pathname === '/api/v1/patients' ? '/roster' : url.pathname.slice(path.length),
          startMs: performance.now(),
        };
        records.push(record);
        inFlight.set(request, record);
      });
      page.on('requestfinished', (request) => {
        const record = inFlight.get(request);
        if (record) record.finishedMs = performance.now();
      });
      for (const visit of ['first', 'return']) {
        records = [];
        if (visit === 'first') await signInAs(page, 'alice', `/patients/${patient.id}`);
        else await page.goBack();
        await expect(page.getByRole('heading', { level: 1, name: patient.label })).toBeVisible();
        await expect(page.getByText('Synthetic', { exact: true })).toBeVisible();
        await expect(page.getByRole('list', { name: 'Recorded medications' }).getByRole('listitem')).toHaveCount(20);
        const ready = performance.now();
        const reads = records.filter((record) => ['/identity', '/demographics', '/medications'].includes(record.endpoint));
        expect(reads, `${visit} visit, latency ${latencyMs}, sample ${sample}`).toHaveLength(3);
        const first = Math.min(...reads.map((record) => record.startMs));
        samples.push({
          sample,
          latencyMs,
          visit,
          readyMs: ready - first,
          rosterRequests: records.filter((r) => r.endpoint === '/roster').length,
          reads: reads.map((r) => ({ endpoint: r.endpoint, startMs: r.startMs - first, durationMs: r.finishedMs === undefined ? null : r.finishedMs - r.startMs })),
        });
        if (visit === 'first') {
          await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
          await expect(page).toHaveURL(/\/workspace$/);
          await expect(page.getByRole('heading', { name: 'Start with a synthetic report.' })).toBeVisible();
        }
      }
      await context.close();
    }
  }
  const result = {
    node: process.version,
    chromium: browser.version(),
    fixture: 'one synthetic patient, complete demographics, 20 active medications',
    cache: 'new browser context for first visit; same-context history navigation for return; no request interception or cache override',
    endpoints,
    samples,
  };
  const output = process.env.PERFORMANCE_OUTPUT || testInfo.outputPath('patient-loading.json');
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Patient-loading measurements: ${output}`);
});
