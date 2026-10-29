import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionEndedError } from '@/auth/AuthProvider';
import { createPatient, listPatients, reportStorageOrigins, submitReport, SubmitError, type UploadProgress } from './api';
import type { ProductUploadValues } from './productUploadSchema';

const patientId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const date = '2026-10-10T00:00:00.000Z';
const sha = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
const report = (uploaded = false) => ({
  id,
  patientId,
  type: 'structured',
  filename: 'synthetic.json',
  sizeBytes: 1,
  status: 'received',
  fileUploaded: uploaded,
  contentType: uploaded ? 'application/json' : null,
  sha256: uploaded ? sha : null,
  createdAt: date,
  updatedAt: date,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const revision = '33333333-3333-4333-8333-333333333333';
const attemptId = '44444444-4444-4444-8444-444444444444';
const original = '55555555-5555-4555-8555-555555555555';
const attempt = (state: string) => ({ attemptId, revision, state, expiresAt: new Date(Date.now() + 300000).toISOString() });
function file(name = 'synthetic.json', bytes = 'x') {
  const result = new File([bytes], name);
  Object.defineProperty(result, 'arrayBuffer', { value: async () => new TextEncoder().encode(bytes).buffer });
  return result;
}
let values: ProductUploadValues;
let storage: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  values = { patientId, reportType: 'structured', file: file(), syntheticConfirmed: true };
  // Nothing in an upload talks to object storage from the browser any more: this must stay untouched.
  storage = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
/** The whole happy path: register, read the revision, declare, send the bytes through the API, read the report back. */
function api() {
  return vi
    .fn()
    .mockResolvedValueOnce(response(report(), 201))
    .mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
    .mockResolvedValueOnce(response(attempt('declared')))
    .mockResolvedValueOnce(response(attempt('committed')))
    .mockResolvedValueOnce(response(report(true)));
}

describe('standard report upload (the validated intake)', () => {
  it('uses an existing patient and authenticated registration; success requires a committed attempt and a verified report', async () => {
    const apiFetch = api();
    const progress: UploadProgress = {};
    await expect(submitReport(values, apiFetch, progress)).resolves.toEqual({ reference: id });
    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/reports',
      `/api/v1/reports/${id}/upload-state`,
      `/api/v1/reports/${id}/upload-attempts`,
      `/api/v1/reports/${id}/upload-attempts/${attemptId}/bytes`,
      `/api/v1/reports/${id}`,
    ]);
    const body = JSON.parse(apiFetch.mock.calls[0]![1].body);
    expect(body).toMatchObject({ patientId, type: 'structured', filename: 'synthetic.json', sizeBytes: 1, requestId: progress.requestId });
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.parse(apiFetch.mock.calls[2]![1].body)).toMatchObject({ revision: original, contentType: 'application/json', sha256: sha });
    // The bytes go to the API with the attempt's revision, never to a storage URL, and no direct-upload route is used.
    expect(apiFetch.mock.calls[3]![1]).toMatchObject({
      method: 'PUT',
      body: values.file,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'X-Upload-Revision': revision },
    });
    expect(apiFetch.mock.calls.some((call) => /upload-url|\/complete$/.test(call[0]))).toBe(false);
    expect(storage).not.toHaveBeenCalled();
  });
  it('works in a production build on a real host (no local-browser restriction any more)', async () => {
    vi.stubEnv('MODE', 'production');
    vi.stubGlobal('window', { location: { hostname: 'app.example.test' } });
    await expect(submitReport(values, api(), {})).resolves.toEqual({ reference: id });
  });
  it('retains the request key after a lost registration response, including reselected identical bytes', async () => {
    const progress: UploadProgress = {};
    const lost = vi.fn().mockRejectedValue(new Error('signed-url or raw secret error'));
    await expect(submitReport(values, lost, progress)).rejects.toThrow('interrupted');
    const originalKey = progress.requestId;
    const retry = api();
    await expect(submitReport({ ...values, file: file() }, retry, progress)).resolves.toEqual({ reference: id });
    expect(progress.requestId).toBe(originalKey);
    expect(JSON.parse(retry.mock.calls[0]![1].body).requestId).toBe(JSON.parse(lost.mock.calls[0]![1].body).requestId);
  });
  it('never falls back to unkeyed registration after retry state is only partially initialized', async () => {
    const progress: UploadProgress = { identity: JSON.stringify([patientId, 'structured', 'synthetic.json', 1, sha]) };
    const apiFetch = api();
    await submitReport(values, apiFetch, progress);
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body).requestId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('recovers a lost transfer reply without registering or declaring again, and without sending the bytes twice', async () => {
    const progress: UploadProgress = {};
    const first = vi
      .fn()
      .mockResolvedValueOnce(response(report()))
      .mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
      .mockResolvedValueOnce(response(attempt('declared')))
      .mockRejectedValueOnce(new Error('lost'));
    await expect(submitReport(values, first, progress)).rejects.toThrow('interrupted');
    const retry = vi
      .fn()
      .mockResolvedValueOnce(response(report()))
      .mockResolvedValueOnce(response(attempt('committed')))
      .mockResolvedValueOnce(response(report(true)));
    await expect(submitReport(values, retry, progress)).resolves.toEqual({ reference: id });
    expect(retry.mock.calls.map((call) => call[0])).toEqual([`/api/v1/reports/${id}`, `/api/v1/reports/${id}/upload-attempts`, `/api/v1/reports/${id}`]);
    expect(retry.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(false);
  });
  it.each(['patient', 'type', 'filename', 'bytes'])('allocates a fresh key after changing %s', async (change) => {
    const progress: UploadProgress = {};
    const lost = vi.fn().mockRejectedValue(new Error('lost'));
    await expect(submitReport(values, lost, progress)).rejects.toThrow('interrupted');
    const key = progress.requestId;
    const changed = { ...values };
    if (change === 'patient') changed.patientId = id;
    if (change === 'type') {
      // The only other type is lab-pdf, which the form accepts only in owned local storage mode.
      vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
      changed.reportType = 'lab-pdf';
      changed.file = file('synthetic.pdf');
    }
    if (change === 'filename') changed.file = file('new.json');
    if (change === 'bytes') changed.file = file('synthetic.json', 'y');
    await expect(submitReport(changed, lost, progress)).rejects.toThrow('interrupted');
    expect(progress.requestId).not.toBe(key);
  });
  it.each([{ patientId: id }, { type: 'lab-pdf' }, { filename: 'other.json' }, { sizeBytes: 2 }])(
    'refuses inconsistent registration %j before declaring or sending bytes',
    async (mismatch) => {
      const apiFetch = vi.fn().mockResolvedValue(response({ ...report(), ...mismatch }));
      await expect(submitReport(values, apiFetch, {})).rejects.toThrow('interrupted');
      expect(apiFetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([{ fileUploaded: false }, { sha256: '0'.repeat(64) }, { contentType: 'text/plain' }, { id: patientId }])('refuses an inconsistent final report %j', async (mismatch) => {
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce(response(report()))
      .mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
      .mockResolvedValueOnce(response(attempt('declared')))
      .mockResolvedValueOnce(response(attempt('committed')))
      .mockResolvedValueOnce(response({ ...report(true), ...mismatch }));
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow('interrupted');
  });
  it('does not treat an attempt that is not committed as a success', async () => {
    const apiFetch = vi
      .fn()
      .mockResolvedValueOnce(response(report()))
      .mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
      .mockResolvedValueOnce(response(attempt('declared')))
      .mockResolvedValueOnce(response(attempt('stored')));
    await expect(submitReport(values, apiFetch, {})).rejects.toThrow('interrupted');
    expect(apiFetch).toHaveBeenCalledTimes(4); // it never read the report back as uploaded
  });
  it.each([403, 404, 409, 429, 500])('handles API %i without exposing the response', async (status) => {
    const apiFetch = vi.fn().mockResolvedValue(response({ message: 'sensitive raw payload' }, status));
    await expect(submitReport(values, apiFetch, {})).rejects.not.toThrow('sensitive raw payload');
    expect(storage).not.toHaveBeenCalled();
  });
  it('preserves existing expired-session handling', async () => {
    const error = new SessionEndedError('Session expired');
    await expect(submitReport(values, vi.fn().mockRejectedValue(error), {})).rejects.toBe(error);
  });
  it('fails before creating records if synthetic confirmation is absent or file is invalid', async () => {
    const apiFetch = vi.fn();
    for (const value of [
      { ...values, syntheticConfirmed: false },
      { ...values, file: file('bad.pdf') },
      { ...values, file: file('raw.vcf') }, // no raw genomic data is accepted
      { ...values, file: file('bad name.json') },
      { ...values, file: file('empty.json', '') },
    ]) {
      await expect(submitReport(value, apiFetch, {})).rejects.toThrow();
    }
    expect(apiFetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
  });
});

describe('storage configuration (signed download links)', () => {
  it('accepts multiple exact HTTPS origins', () => {
    vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'https://one.example.test, https://two.example.test');
    expect(reportStorageOrigins()).toEqual(['https://one.example.test', 'https://two.example.test']);
  });
  it.each([
    '',
    'https://storage.example.test/',
    'https://user:pass@storage.example.test',
    'https://storage.example.test/path',
    'https://storage.example.test?x=1',
    'https://storage.example.test#x',
    'http://external.example.test',
    '*',
    'https://one.example.test,',
  ])('fails closed for %s', (value) => {
    vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', value);
    expect(() => reportStorageOrigins()).toThrow();
  });
  it('allows loopback HTTP only on a loopback rehearsal browser outside production mode', () => {
    vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'http://127.0.0.1:5557');
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } });
    vi.stubEnv('MODE', 'e2e');
    expect(reportStorageOrigins()).toEqual(['http://127.0.0.1:5557']);
    vi.stubEnv('MODE', 'production');
    expect(() => reportStorageOrigins()).toThrow();
    vi.stubEnv('MODE', 'e2e');
    vi.stubGlobal('window', { location: { hostname: 'app.example.test' } });
    expect(() => reportStorageOrigins()).toThrow();
  });
});

describe('bounded patient list', () => {
  const patient = { id: patientId, label: 'SYN-TEST', createdAt: date, updatedAt: date };
  it('requests one bounded page with cancellation support', async () => {
    const apiFetch = vi.fn().mockResolvedValue(response({ data: [patient], meta: { page: 2, pageSize: 20, total: 21, totalPages: 2 } }));
    const controller = new AbortController();
    await listPatients(apiFetch, 2, controller.signal);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/patients?page=2&pageSize=20', { signal: controller.signal });
  });
  it.each([response({ roles: [] }), response({ data: [patient], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }), response({}, 503)])(
    'refuses unavailable or wrong-page lists',
    async (answer) => {
      await expect(listPatients(vi.fn().mockResolvedValue(answer.clone()), 2)).rejects.toThrow('could not be loaded');
    },
  );
});

describe('adding a synthetic patient', () => {
  const created = { id: patientId, label: 'SYN-0002', createdAt: date, updatedAt: date };
  const requestId = '66666666-6666-4666-8666-666666666666';

  it('posts only the label and a request id, and returns the patient the server made', async () => {
    const apiFetch = vi.fn().mockResolvedValue(response(created, 201));
    await expect(createPatient(apiFetch, 'SYN-0002', requestId)).resolves.toMatchObject({ id: patientId, label: 'SYN-0002' });
    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/patients');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ label: 'SYN-0002', requestId });
  });

  it.each([
    [409, 'already exists'],
    [403, 'cannot add patients'],
    [400, 'not accepted'],
    [422, 'not accepted'],
    [429, 'Too many requests'],
    [503, 'could not be added'],
  ])('answers %i with a plain message and keeps the status', async (status, words) => {
    const error = await createPatient(vi.fn().mockResolvedValue(response({ message: 'internal detail' }, status)), 'SYN-0002', requestId).catch((caught) => caught);
    expect(error).toBeInstanceOf(SubmitError);
    expect(error.message).toContain(words);
    expect(error.message).not.toContain('internal detail');
    expect(error.status).toBe(status);
  });

  it('never shows a raw transport error or a malformed answer', async () => {
    const lost = await createPatient(vi.fn().mockRejectedValue(new TypeError('socket secret-detail')), 'SYN-0002', requestId).catch((caught) => caught);
    expect(lost).toBeInstanceOf(SubmitError);
    expect(lost.message).toContain('Check your connection');
    expect(lost.message).not.toContain('secret-detail');
    await expect(createPatient(vi.fn().mockResolvedValue(response({ id: 'not-a-uuid' }, 201)), 'SYN-0002', requestId)).rejects.toThrow('could not be added');
  });

  it('passes an ended session through untouched', async () => {
    const ended = new SessionEndedError();
    await expect(createPatient(vi.fn().mockRejectedValue(ended), 'SYN-0002', requestId)).rejects.toBe(ended);
  });

  it.each(['Jane Doe', '', 'x'.repeat(41), 'SYN_0002'])('refuses the label %j before any request is made', async (label) => {
    const apiFetch = vi.fn();
    await expect(createPatient(apiFetch, label, requestId)).rejects.toThrow();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
