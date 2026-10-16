import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { signInWithPatient } from '../e2e/helpers';

// This uses the built product and real loopback S3 protocol, not a mocked downloader.
test('reports CORS permits GET and refuses retired PUT and an unapproved origin', async ({ page }) => {
  const fixture = await signInWithPatient(page);
  const bytes = Buffer.from('{"synthetic":true}');
  await page.getByLabel(/synthetic patient \(required\)/i).selectOption(fixture.id);
  await page.getByLabel(/report type/i).selectOption('structured');
  await page.getByLabel(/report file/i).setInputFiles({ name: 'cors-synthetic.json', mimeType: 'application/json', buffer: bytes });
  await page.getByLabel(/synthetic data only/i).check();
  await page.getByRole('button', { name: 'Upload report', exact: true }).click();
  await expect(page.getByText('Upload complete', { exact: true })).toBeVisible();
  const reports = await page.request.get(`${fixture.api}/api/v1/reports?patientId=${fixture.id}`, { headers: fixture.headers });
  const report = (await reports.json()).data[0];
  const reply = await page.request.get(`${fixture.api}/api/v1/reports/${report.id}/download-url`, { headers: fixture.headers });
  expect(reply.status()).toBe(200);
  const { url } = await reply.json(); // Do not log signed URLs or bearer headers.
  const origin = new URL(page.url()).origin;
  const parsed = new URL(url);
  expect(parsed.origin).toBe(process.env.E2E_REPORT_STORAGE_ORIGIN ?? 'http://127.0.0.1:5557');
  const bucket = `synthetic-storage-${process.env.L2_BROWSER_RUN_ID}`;
  expect(parsed.pathname.split('/')[1]).toBe(bucket);
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({ endpoint: parsed.origin, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
  const control = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Synthetic CORS control</title>');
  });
  let originalRules: unknown;
  let policyChanged = false;
  try {
    const configured = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    expect(configured.CORSRules).toEqual([{ AllowedOrigins: [origin], AllowedMethods: ['GET'], AllowedHeaders: ['Content-Type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 300 }]);
    originalRules = configured.CORSRules;
    const preflight = (method: string, caller = origin) => page.request.fetch(url, {
      method: 'OPTIONS', headers: { Origin: caller, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'Content-Type' },
    });
    const get = await preflight('GET');
    expect(get.status()).toBe(200);
    expect(get.headers()['access-control-allow-origin']).toBe(origin);
    expect(get.headers()['access-control-allow-methods']).toBe('GET');
    // Moto can answer OPTIONS with 200 while excluding the requested method. The browser must refuse it.
    const put = await preflight('PUT');
    expect((put.headers()['access-control-allow-methods'] ?? '').split(/,\s*/)).not.toContain('PUT');
    const refusedPut = await page.evaluate(async url => {
      try { await fetch(url, { method: 'PUT', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: '{"syntheticRefused":true}' }); return false; } catch { return true; }
    }, url);
    expect(refusedPut).toBe(true);
    const readable = await page.evaluate(async url => {
      const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
      return { ok: response.ok, text: await response.text() };
    }, url);
    expect(readable).toEqual({ ok: true, text: bytes.toString() });

    // A real server gives this document the same loopback address space as storage.
    // The identical page must succeed after its origin is allowed: a transport failure cannot pass as a CORS refusal.
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(0, '127.0.0.1', resolve);
    });
    const controlOrigin = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
    await page.goto(controlOrigin + '/cors-control');
    expect(await page.evaluate(() => window.location.origin)).toBe(controlOrigin);
    const refused = await page.evaluate(async url => {
      try { await fetch(url, { credentials: 'omit', cache: 'no-store' }); return false; } catch { return true; }
    }, url);
    expect(refused).toBe(true);
    // Only this run's fresh synthetic bucket is temporarily changed; restore its original rule in finally.
    policyChanged = true;
    const expanded = [{ ...configured.CORSRules[0], AllowedOrigins: [origin, controlOrigin] }];
    await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: expanded } }));
    expect((await client.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules).toEqual(expanded);
    const allowed = await page.evaluate(async url => {
      const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store' });
      return { ok: response.ok, text: await response.text() };
    }, url);
    expect(allowed).toEqual({ ok: true, text: bytes.toString() });
  } finally {
    try {
      if (policyChanged) {
        await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: originalRules } }));
        expect((await client.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules).toEqual(originalRules);
      }
    } finally {
      client.destroy();
      if (control.listening) await new Promise<void>((resolve, reject) => control.close(error => error ? reject(error) : resolve()));
    }
  }
});
