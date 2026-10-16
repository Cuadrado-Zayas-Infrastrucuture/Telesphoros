import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { submitReport, type UploadProgress } from './api';
import { cancelOwnedUpload, downloadReport, retireOwnedUpload } from './ownedStorageApi';
import { productUploadSchema } from './productUploadSchema';
import { endRecoverySession, startRecoverySession } from './uploadRecovery';
const patientId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const revision = '33333333-3333-4333-8333-333333333333';
const attemptId = '44444444-4444-4444-8444-444444444444';
const original = '55555555-5555-4555-8555-555555555555';
const sha = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
const report = (fileUploaded = false) => ({ id, patientId, filename: 'synthetic.json', type: 'structured', sizeBytes: 1, status: 'received', fileUploaded, sha256: fileUploaded ? sha : null, contentType: fileUploaded ? 'application/json' : null, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' });
const attempt = (state: string) => ({ attemptId, revision, state, expiresAt: new Date(Date.now() + 300000).toISOString() });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const file = new File(['x'], 'synthetic.json');
Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('x').buffer });
const values = { patientId, reportType: 'structured' as const, file, syntheticConfirmed: true };
beforeEach(() => {
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
  vi.stubEnv('MODE', 'test');
  vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } });
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('replays a lost declaration using its original revision, then sends only authenticated API bytes', async () => {
  const api = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ revision: original, fileUploaded: false })).mockRejectedValueOnce(new Error('lost'));
  const progress: UploadProgress = {};
  await expect(submitReport(values, api, progress)).rejects.toThrow('interrupted');
  const declaration = api.mock.calls[2]![1].body;
  api.mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
  await expect(submitReport(values, api, progress)).resolves.toEqual({ reference: id });
  expect(api.mock.calls[4]![1].body).toBe(declaration);
  expect(JSON.parse(declaration).revision).toBe(original);
  expect(api.mock.calls[5]![1]).toMatchObject({ method: 'PUT', body: file, redirect: 'error', headers: { 'X-Upload-Revision': revision } });
  expect(fetch).not.toHaveBeenCalled();
});
it('recovers a lost committed response without a second byte transfer', async () => {
  const api = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ revision: original, fileUploaded: false })).mockResolvedValueOnce(response(attempt('declared'))).mockRejectedValueOnce(new Error('lost'));
  const progress: UploadProgress = {};
  await expect(submitReport(values, api, progress)).rejects.toThrow();
  api.mockResolvedValueOnce(response(report(true)));
  await expect(submitReport(values, api, progress)).resolves.toEqual({ reference: id });
  expect(api.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1);
});
it('resumes unresolved storage without resending bytes', async () => {
  const api = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ revision: original, fileUploaded: false })).mockResolvedValueOnce(response(attempt('unresolved'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
  await expect(submitReport(values, api, {})).resolves.toEqual({ reference: id });
  expect(api.mock.calls.some(call => call[0].endsWith('/resume'))).toBe(true);
  expect(api.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false);
});
it('has no direct-upload fallback after a refusal', async () => {
  const api = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({}, 503));
  await expect(submitReport(values, api, {})).rejects.toThrow();
  expect(api.mock.calls.some(call => call[0].endsWith('/upload-url'))).toBe(false); expect(fetch).not.toHaveBeenCalled();
});
it('recovers an unknown declaration before cancelling, and requires server acknowledgement', async () => {
  const progress: UploadProgress = { reportId: id, declaration: { requestId: original, revision: original, contentType: 'application/json', sha256: sha } };
  const api = vi.fn().mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('cancelling')));
  await expect(cancelOwnedUpload(api, progress)).rejects.toThrow('pending');
  expect(api.mock.calls[1]![1].headers['X-Upload-Revision']).toBe(revision);
  api.mockResolvedValueOnce(response(attempt('cancelled')));
  await expect(cancelOwnedUpload(api, progress)).resolves.toBeUndefined();
});
it('allows PDF only for the opted-in product schema', () => {
  const pdf = { ...values, reportType: 'lab-pdf', file: new File(['%PDF-1.7\n%%EOF'], 'sample.pdf') };
  expect(productUploadSchema.safeParse(pdf).success).toBe(true);
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'false'); expect(productUploadSchema.safeParse(pdf).success).toBe(false);
});
it.each(['https://evil.invalid/file', 'https://storage.example.test/file#fragment', 'https://user:pass@storage.example.test/file'])('refuses unsafe download %s before retrieval', async url => {
  vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'https://storage.example.test');
  const api = vi.fn().mockResolvedValue(response({ url, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  await expect(downloadReport(api, id, 'sample.json', 1, sha)).rejects.toThrow('unavailable'); expect(fetch).not.toHaveBeenCalled();
});
it('refuses an expired signed URL before retrieval', async () => {
  vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'https://storage.example.test');
  const api = vi.fn().mockResolvedValue(response({ url: 'https://storage.example.test/file', expiresAt: new Date(Date.now() - 1).toISOString() }));
  await expect(downloadReport(api, id, 'sample.json', 1, sha)).rejects.toThrow('unavailable'); expect(fetch).not.toHaveBeenCalled();
});
it('refuses wrong bytes and omits credentials and referrers on downloads', async () => {
  vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'https://storage.example.test');
  const api = vi.fn().mockResolvedValue(response({ url: 'https://storage.example.test/file', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  vi.mocked(fetch).mockResolvedValue(new Response('y'));
  await expect(downloadReport(api, id, 'sample.json', 1, sha)).rejects.toThrow('unavailable');
  expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
});
it('keeps the known attempt identity when an intake response does not match it', async () => {
  const api = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ revision: original, fileUploaded: false })).mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response({ ...attempt('committed'), attemptId: original }));
  const progress: UploadProgress = {};
  await expect(submitReport(values, api, progress)).rejects.toThrow('interrupted');
  expect(progress.attempt?.attemptId).toBe(attemptId);
  expect(progress.attempt?.state).toBe('declared');
});
it('does not register metadata when the caller already cancelled', async () => {
  const api = vi.fn(); const controller = new AbortController(); controller.abort();
  await expect(submitReport(values, api, {}, controller.signal)).rejects.toThrow(); expect(api).not.toHaveBeenCalled();
});


const pendingStages = ['registration', 'state', 'declaration', 'bytes', 'cancel'] as const;
it.each(pendingStages.flatMap(stage => (['page', 'session'] as const).map(lifetime => ({ stage, lifetime }))))('retiring the $lifetime during pending $stage work prevents late progress and further API calls', async ({ stage, lifetime }) => {
  const owner = startRecoverySession('a'.repeat(64));
  const progress: UploadProgress = stage === 'cancel' ? { reportId: id, declaration: { requestId: original, revision, contentType: 'application/json', sha256: sha }, attempt: { attemptId, revision, state: 'declared', expiresAt: new Date(Date.now() + 300000).toISOString() } } : {};
  // Cancellation can begin with progress restored before this page sent a request.
  if (stage === 'cancel') {
    const { bindRecovery } = await import('./uploadRecovery');
    bindRecovery(progress, owner);
  }
  let reached!: () => void; const pendingBody = new Promise<void>(resolve => { reached = resolve; });
  let finish!: (body: unknown) => void;
  const at = stage === 'registration' ? 0 : stage === 'state' ? 1 : stage === 'declaration' ? 2 : stage === 'bytes' ? 3 : 0;
  const bodies = stage === 'cancel' ? [attempt('cancelled')] : [report(), {revision: original, fileUploaded: false}, attempt('declared'), attempt('committed'), report(true)];
  let calls = 0;
  const api = vi.fn(async () => { const index = calls++; const reply = response(bodies[index]); if (index === at) reply.json = () => { reached(); return new Promise(resolve => { finish = resolve; }); }; return reply; });
  const operation = stage === 'cancel' ? cancelOwnedUpload(api, progress) : submitReport(values, api, progress, undefined, owner);
  const refused = expect(operation).rejects.toThrow(lifetime === 'page' ? 'Upload page ended' : 'Upload session ended');
  await pendingBody;
  const snapshot = JSON.stringify(progress);
  if (lifetime === 'page') retireOwnedUpload(progress); else endRecoverySession(owner);
  finish(bodies[at]); await refused;
  expect(JSON.stringify(progress)).toBe(snapshot);
  expect(api).toHaveBeenCalledTimes(at + 1);
  endRecoverySession(owner);
});

it('idle progress survives initial cleanup replay, but retired active progress cannot restart', async () => {
  const progress: UploadProgress = {};
  retireOwnedUpload(progress);
  const interrupted = vi.fn().mockRejectedValue(new Error('synthetic interruption'));
  await expect(submitReport(values, interrupted, progress)).rejects.toThrow('interrupted');
  expect(interrupted).toHaveBeenCalledTimes(1);
  retireOwnedUpload(progress);
  const none = vi.fn();
  await expect(submitReport(values, none, progress)).rejects.toThrow('Upload page ended');
  await expect(cancelOwnedUpload(none, progress)).rejects.toThrow('Upload page ended');
  expect(none).not.toHaveBeenCalled();
});
