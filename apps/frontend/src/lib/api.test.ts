import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionEndedError } from '@/auth/AuthProvider';
import { listPatients, reportStorageOrigins, submitReport, type UploadProgress } from './api';
import type { ProductUploadValues } from './productUploadSchema';

const patientId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const date = '2026-10-10T00:00:00.000Z';
const sha = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
const report = (uploaded = false) => ({ id, patientId, type: 'structured', filename: 'synthetic.json', sizeBytes: 1,
  status: 'received', fileUploaded: uploaded, contentType: uploaded ? 'application/json' : null,
  sha256: uploaded ? sha : null, createdAt: date, updatedAt: date });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const target = () => ({ uploadUrl: 'https://storage.example.test/bucket/file?signature=synthetic', method: 'PUT',
  headers: { 'Content-Type': 'application/json' }, expiresAt: new Date(Date.now() + 300000).toISOString() });
function file(name = 'synthetic.json', bytes = 'x') {
  const result = new File([bytes], name);
  Object.defineProperty(result, 'arrayBuffer', { value: async () => new TextEncoder().encode(bytes).buffer });
  return result;
}
let values: ProductUploadValues;
let put: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'https://storage.example.test');
  values = { patientId, reportType: 'structured', file: file(), syntheticConfirmed: true };
  put = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 })); vi.stubGlobal('fetch', put);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function api() {
  return vi.fn().mockResolvedValueOnce(response(report(), 201)).mockResolvedValueOnce(response(target()))
    .mockResolvedValueOnce(response(report(true)));
}

describe('standard report upload transport', () => {
  it('uses an existing patient and authenticated registration; success requires verified completion', async () => {
    const apiFetch = api(); const progress: UploadProgress = {};
    await expect(submitReport(values, apiFetch, progress)).resolves.toEqual({ reference: id });
    expect(apiFetch.mock.calls.map(call => call[0])).toEqual(['/api/v1/reports', `/api/v1/reports/${id}/upload-url`, `/api/v1/reports/${id}/complete`]);
    const body = JSON.parse(apiFetch.mock.calls[0]![1].body);
    expect(body).toMatchObject({ patientId, type: 'structured', filename: 'synthetic.json', sizeBytes: 1, requestId: progress.requestId });
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(put.mock.calls[0]![1]).toEqual({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: values.file,
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(apiFetch.mock.calls[1]![1].body)).toEqual({ contentType: 'application/json', sha256: sha });
  });
  it('retains the request key after a lost registration response, including reselected identical bytes', async () => {
    const progress: UploadProgress = {}; const lost = vi.fn().mockRejectedValue(new Error('signed-url or raw secret error'));
    await expect(submitReport(values, lost, progress)).rejects.toThrow('interrupted');
    const originalKey = progress.requestId;
    const retry = api();
    await expect(submitReport({ ...values, file: file() }, retry, progress)).resolves.toEqual({ reference: id });
    expect(progress.requestId).toBe(originalKey);
    expect(JSON.parse(retry.mock.calls[0]![1].body).requestId).toBe(JSON.parse(lost.mock.calls[0]![1].body).requestId);
  });
  it('never falls back to unkeyed registration after retry state is only partially initialized', async () => {
    const progress: UploadProgress = { identity: JSON.stringify([patientId, 'structured', 'synthetic.json', 1, sha]) };
    const apiFetch = api(); await submitReport(values, apiFetch, progress);
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body).requestId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('recovers a lost completion reply through GET without another PUT or registration', async () => {
    const progress: UploadProgress = {}; const first = api();
    first.mockReset().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(target())).mockRejectedValueOnce(new Error('lost'));
    await expect(submitReport(values, first, progress)).rejects.toThrow('interrupted');
    const retry = vi.fn().mockResolvedValue(response(report(true))); put.mockClear();
    await expect(submitReport(values, retry, progress)).resolves.toEqual({ reference: id });
    expect(retry).toHaveBeenCalledTimes(1); expect(retry.mock.calls[0]![0]).toBe(`/api/v1/reports/${id}`); expect(put).not.toHaveBeenCalled();
  });
  it('never completes after failed PUT; retry obtains a fresh target for the same report', async () => {
    const progress: UploadProgress = {}; const first = api(); put.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(submitReport(values, first, progress)).rejects.toThrow('File transfer failed');
    expect(first).toHaveBeenCalledTimes(2);
    const retry = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(target())).mockResolvedValueOnce(response(report(true)));
    await expect(submitReport(values, retry, progress)).resolves.toEqual({ reference: id });
    expect(retry.mock.calls[0]![0]).toBe(`/api/v1/reports/${id}`);
  });
  it.each(['patient', 'type', 'filename', 'bytes'])('allocates a fresh key after changing %s', async change => {
    const progress: UploadProgress = {}; const lost = vi.fn().mockRejectedValue(new Error('lost'));
    await expect(submitReport(values, lost, progress)).rejects.toThrow('interrupted'); const key = progress.requestId;
    const changed = { ...values };
    if (change === 'patient') changed.patientId = id;
    if (change === 'type') { changed.reportType = 'vcf'; changed.file = file('synthetic.vcf'); }
    if (change === 'filename') changed.file = file('new.json');
    if (change === 'bytes') changed.file = file('synthetic.json', 'y');
    await expect(submitReport(changed, lost, progress)).rejects.toThrow('interrupted'); expect(progress.requestId).not.toBe(key);
  });
  it.each([{ patientId: id }, { type: 'vcf' }, { filename: 'other.json' }, { sizeBytes: 2 }])('refuses inconsistent registration %j before sending bytes', async mismatch => {
    const apiFetch = vi.fn().mockResolvedValue(response({ ...report(), ...mismatch }));
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow('does not match'); expect(put).not.toHaveBeenCalled();
  });
  it.each([{ fileUploaded: false }, { sha256: '0'.repeat(64) }, { contentType: 'text/plain' }, { id: patientId }])('refuses inconsistent completion %j', async mismatch => {
    const apiFetch = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(target())).mockResolvedValueOnce(response({ ...report(true), ...mismatch }));
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow(mismatch.id ? 'does not match' : 'did not verify');
  });
  it.each([
    { uploadUrl: 'https://storage.example.test.evil.test/file' },
    { uploadUrl: 'https://operator:password@storage.example.test/file' },
    { uploadUrl: 'https://storage.example.test/file#fragment' },
    { uploadUrl: 'http://storage.example.test/file' },
    { expiresAt: date }, { headers: { Authorization: 'dummy' } },
    { headers: { 'Content-Type': 'text/plain' } }, { headers: { 'Content-Type': 'application/json', Cookie: 'dummy' } },
    { method: 'POST' },
  ])('rejects unsafe target %j before PUT', async mismatch => {
    const apiFetch = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ ...target(), ...mismatch }));
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow(); expect(put).not.toHaveBeenCalled(); expect(apiFetch).toHaveBeenCalledTimes(2);
  });
  it.each([403, 404, 409, 429, 500])('handles API %i without exposing the response', async status => {
    const apiFetch = vi.fn().mockResolvedValue(response({ message: 'sensitive raw payload' }, status));
    await expect(submitReport(values, apiFetch, {})).rejects.not.toThrow('sensitive raw payload'); expect(put).not.toHaveBeenCalled();
  });
  it('preserves existing expired-session handling', async () => {
    const error = new SessionEndedError('Session expired');
    await expect(submitReport(values, vi.fn().mockRejectedValue(error), {})).rejects.toBe(error);
  });
  it('fails before creating records if synthetic confirmation is absent or file is invalid', async () => {
    const apiFetch = vi.fn();
    for (const value of [{ ...values, syntheticConfirmed: false }, { ...values, file: file('bad.vcf') }, { ...values, file: file('bad name.json') }, { ...values, file: file('empty.json', '') }]) {
      await expect(submitReport(value, apiFetch, {})).rejects.toThrow();
    }
    expect(apiFetch).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
});

describe('storage configuration', () => {
  it('accepts multiple exact HTTPS origins', () => {
    vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'https://one.example.test, https://two.example.test');
    expect(reportStorageOrigins()).toEqual(['https://one.example.test', 'https://two.example.test']);
  });
  it.each(['', 'https://storage.example.test/', 'https://user:pass@storage.example.test', 'https://storage.example.test/path', 'https://storage.example.test?x=1', 'https://storage.example.test#x', 'http://external.example.test', '*', 'https://one.example.test,'])('fails closed for %s', value => {
    vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', value); expect(() => reportStorageOrigins()).toThrow();
  });
  it('allows loopback HTTP only on a loopback rehearsal browser outside production mode', () => {
    vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'http://127.0.0.1:5557');
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } }); vi.stubEnv('MODE', 'e2e');
    expect(reportStorageOrigins()).toEqual(['http://127.0.0.1:5557']);
    vi.stubEnv('MODE', 'production'); expect(() => reportStorageOrigins()).toThrow();
    vi.stubEnv('MODE', 'e2e'); vi.stubGlobal('window', { location: { hostname: 'app.example.test' } }); expect(() => reportStorageOrigins()).toThrow();
  });
});

describe('bounded patient list', () => {
  const patient = { id: patientId, label: 'SYN-TEST', createdAt: date, updatedAt: date };
  it('requests one bounded page with cancellation support', async () => {
    const apiFetch = vi.fn().mockResolvedValue(response({ data: [patient], meta: { page: 2, pageSize: 20, total: 21, totalPages: 2 } }));
    const controller = new AbortController(); await listPatients(apiFetch, 2, controller.signal);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/patients?page=2&pageSize=20', { signal: controller.signal });
  });
  it.each([response({ roles: [] }), response({ data: [patient], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }), response({}, 503)])('refuses unavailable or wrong-page lists', async answer => {
    await expect(listPatients(vi.fn().mockResolvedValue(answer.clone()), 2)).rejects.toThrow('could not be loaded');
  });
});
