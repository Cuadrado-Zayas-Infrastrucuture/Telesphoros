import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitReport, localStorageOrigin, type UploadProgress } from './localReportApi';
import type { UploadReportValues } from './uploadReportSchema';

const id = '11111111-1111-4111-8111-111111111111';
const revision = '33333333-3333-4333-8333-333333333333';
const attemptId = '44444444-4444-4444-8444-444444444444';
const original = '55555555-5555-4555-8555-555555555555';
const date = '2026-10-08T00:00:00.000Z';
const sha = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
const patient = { id, label: 'SYN-TEST', createdAt: date, updatedAt: date };
const report = (uploaded = false) => ({ id, patientId: id, type: 'structured', filename: 'synthetic.json', sizeBytes: 1, status: 'received', fileUploaded: uploaded, contentType: uploaded ? 'application/json' : null, sha256: uploaded ? sha : null, createdAt: date, updatedAt: date });
const attempt = (state: string) => ({ attemptId, revision, state, expiresAt: new Date(Date.now() + 300000).toISOString() });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('local upload orchestration (through the validated intake)', () => {
  let values: UploadReportValues;
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } });
    vi.stubGlobal('fetch', vi.fn());
    const file = new File(['x'], 'synthetic.json');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('x').buffer });
    values = { patientLabel: 'SYN-TEST', reportType: 'structured', file, syntheticConfirmed: true };
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  /** patient, report, revision, declaration, bytes, read-back */
  const api = () => vi.fn().mockResolvedValueOnce(response(patient, 201)).mockResolvedValueOnce(response(report(), 201)).mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
    .mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));

  it('returns success only after a committed attempt and a verified report, sending the bytes through the API and nothing to storage', async () => {
    const apiFetch = api();
    await expect(submitReport(values, apiFetch, {})).resolves.toEqual({ reference: id });
    expect(apiFetch.mock.calls.map(call => call[0])).toEqual([
      '/api/v1/patients', '/api/v1/reports', `/api/v1/reports/${id}/upload-state`, `/api/v1/reports/${id}/upload-attempts`,
      `/api/v1/reports/${id}/upload-attempts/${attemptId}/bytes`, `/api/v1/reports/${id}`,
    ]);
    expect(apiFetch.mock.calls[4]![1]).toMatchObject({ method: 'PUT', body: values.file, headers: { 'X-Upload-Revision': revision } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { fileUploaded: false }, { sha256: '0'.repeat(64) }, { contentType: 'text/plain' }, { sizeBytes: 2 },
  ])('refuses an inconsistent final report %j', async (change) => {
    const apiFetch = vi.fn().mockResolvedValueOnce(response(patient, 201)).mockResolvedValueOnce(response(report(), 201)).mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
      .mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response({ ...report(true), ...change }));
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow();
  });

  it('does not read the report back after a failed transfer; a retry reuses the patient and report and replays the declaration', async () => {
    const progress: UploadProgress = {};
    const first = vi.fn().mockResolvedValueOnce(response(patient, 201)).mockResolvedValueOnce(response(report(), 201)).mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
      .mockResolvedValueOnce(response(attempt('declared'))).mockRejectedValueOnce(new Error('Interrupted'));
    await expect(submitReport(values, first, progress)).rejects.toThrow();
    expect(first).toHaveBeenCalledTimes(5);
    const retry = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
    await expect(submitReport(values, retry, progress)).resolves.toEqual({ reference: id });
    expect(retry.mock.calls.map(call => call[0])).toEqual([`/api/v1/reports/${id}`, `/api/v1/reports/${id}/upload-attempts`, `/api/v1/reports/${id}`]);
  });

  it('recovers a file that is already stored without sending it again', async () => {
    const progress: UploadProgress = {};
    await expect(submitReport(values, api(), progress)).resolves.toEqual({ reference: id });
    // Same file, label and type again: no second patient, no second report, no second transfer.
    const again = vi.fn().mockResolvedValue(response(report(true)));
    await expect(submitReport(values, again, progress)).resolves.toEqual({ reference: id });
    expect(again.mock.calls.map(call => call[0])).toEqual([`/api/v1/reports/${id}`]);
    expect(fetch).not.toHaveBeenCalled();
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
  it('reports a conflicting synthetic label without exposing the response', async () => {
    const apiFetch = vi.fn().mockResolvedValue(response({ message: 'sensitive raw payload' }, 409));
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow('new synthetic label');
  });
});

describe('local emulator configuration', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts a configured loopback origin', () => { vi.stubEnv('VITE_LOCAL_REVIEW_S3_ORIGIN','http://127.0.0.1:5556'); expect(localStorageOrigin()).toBe('http://127.0.0.1:5556'); });
  it.each(['https://example.com','http://localhost:5555','http://127.0.0.1:5555/path','https://127.0.0.1:5555'])('refuses non-emulator origin %s', value => { vi.stubEnv('VITE_LOCAL_REVIEW_S3_ORIGIN',value); expect(() => localStorageOrigin()).toThrow(); });
});
