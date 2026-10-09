import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitReport, localStorageOrigin, type UploadProgress } from './localReportApi';
import type { UploadReportValues } from './uploadReportSchema';

const id = '11111111-1111-4111-8111-111111111111';
const date = '2026-10-08T00:00:00.000Z';
const sha = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
const report = (uploaded = false) => ({ id, patientId: id, type: 'structured', filename: 'synthetic.json', sizeBytes: 1, status: 'received', fileUploaded: uploaded, contentType: uploaded ? 'application/json' : null, sha256: uploaded ? sha : null, createdAt: date, updatedAt: date });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const target = (uploadUrl = 'http://127.0.0.1:5555/demo/file') => ({ uploadUrl, method: 'PUT', headers: { 'Content-Type': 'application/json' }, expiresAt: date });

describe('local upload orchestration', () => {
  let values: UploadReportValues;
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } });
    const file = new File(['x'], 'synthetic.json');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('x').buffer });
    values = { patientLabel: 'SYN-TEST', reportType: 'structured', file, syntheticConfirmed: true };
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  function api() {
    return vi.fn().mockResolvedValueOnce(response({ id, label: 'SYN-TEST', createdAt: date, updatedAt: date })).mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(target())).mockResolvedValueOnce(response(report(true)));
  }

  it('returns success only after verified completion and sends no bearer to storage', async () => {
    const apiFetch = api(); const put = vi.fn().mockResolvedValue(new Response('', { status: 200 })); vi.stubGlobal('fetch', put);
    await expect(submitReport(values, apiFetch, {})).resolves.toEqual({ reference: id });
    expect(apiFetch.mock.calls.at(-1)?.[0]).toBe(`/api/v1/reports/${id}/complete`);
    expect(put.mock.calls[0]?.[1]).toEqual({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: values.file, credentials: 'omit', redirect: 'error' });
  });

  it.each([
    { fileUploaded: false }, { sha256: '0'.repeat(64) }, { contentType: 'text/plain' }, { sizeBytes: 2 },
  ])('refuses inconsistent completion %j', async (change) => {
    const apiFetch = api(); apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(response({ id, label: 'SYN-TEST', createdAt: date, updatedAt: date })).mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(target())).mockResolvedValueOnce(response({ ...report(true), ...change }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow('did not verify');
  });

  it('does not complete after a failed PUT; retry reuses metadata', async () => {
    const apiFetch = api(); const progress: UploadProgress = {};
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Interrupted')));
    await expect(submitReport(values, apiFetch, progress)).rejects.toThrow('Interrupted');
    expect(apiFetch).toHaveBeenCalledTimes(4);
    const retry = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(target())).mockResolvedValueOnce(response(report(true)));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    await expect(submitReport(values, retry, progress)).resolves.toEqual({ reference: id });
    expect(retry.mock.calls[0]?.[0]).toBe(`/api/v1/reports/${id}`);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it('recovers a lost completion response without reuploading', async () => {
    const progress: UploadProgress = { file: values.file, label: values.patientLabel, type: values.reportType, patientId: id, reportId: id };
    const put = vi.fn(); vi.stubGlobal('fetch', put);
    await expect(submitReport(values, vi.fn().mockResolvedValue(response(report(true))), progress)).resolves.toEqual({ reference: id });
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects an external destination before sending bytes', async () => {
    const apiFetch = api(); apiFetch.mockReset(); apiFetch.mockResolvedValueOnce(response({ id, label: 'SYN-TEST', createdAt: date, updatedAt: date })).mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(target('https://example.com/file')));
    const put = vi.fn(); vi.stubGlobal('fetch', put);
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow('not the local emulator');
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses missing synthetic confirmation without creating records', async () => {
    const apiFetch = vi.fn();
    await expect(submitReport({ ...values, syntheticConfirmed: false }, apiFetch, {})).rejects.toThrow('Confirm synthetic');
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('refuses a nonlocal browser before creating records', async () => {
    vi.stubGlobal('window', { location: { hostname: 'example.com' } });
    const apiFetch = vi.fn();
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow('local only');
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('refuses unexpected storage authorization headers', async () => {
    const apiFetch = vi.fn().mockResolvedValueOnce(response({ id, label: 'SYN-TEST', createdAt: date, updatedAt: date })).mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ ...target(), headers: { Authorization: 'dummy-test-header' } }));
    const put = vi.fn(); vi.stubGlobal('fetch', put);
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow('Unexpected upload headers');
    expect(put).not.toHaveBeenCalled();
  });
});

describe('local emulator configuration', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts a configured loopback origin', () => { vi.stubEnv('VITE_LOCAL_REVIEW_S3_ORIGIN','http://127.0.0.1:5556'); expect(localStorageOrigin()).toBe('http://127.0.0.1:5556'); });
  it.each(['https://example.com','http://localhost:5555','http://127.0.0.1:5555/path','https://127.0.0.1:5555'])('refuses non-emulator origin %s', value => { vi.stubEnv('VITE_LOCAL_REVIEW_S3_ORIGIN',value); expect(() => localStorageOrigin()).toThrow(); });
});
