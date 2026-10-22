import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitReport as rawSubmitReport, SubmitError, type UploadProgress, type ApiFetch } from './api';
import { cancelOwnedUpload, downloadReport, restoreProgress, retireOwnedUpload } from './ownedStorageApi';
import type { ProductUploadValues } from './productUploadSchema';
import { bindRecovery, clearRecovery, endRecoverySession, forgetUpload, readRecovery, rememberUpload, startRecoverySession, RECOVERY_LIFETIME_MS, type RecoverySession } from './uploadRecovery';

const patientId = '11111111-1111-4111-8111-111111111111';
const otherPatient = '66666666-6666-4666-8666-666666666666';
const id = '22222222-2222-4222-8222-222222222222';
const revision = '33333333-3333-4333-8333-333333333333';
const attemptId = '44444444-4444-4444-8444-444444444444';
const original = '55555555-5555-4555-8555-555555555555';
const date = '2026-10-10T00:00:00.000Z';
const sha = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
const report = (uploaded = false, over: object = {}) => ({ id, patientId, type: 'structured', filename: 'synthetic.json', sizeBytes: 1, status: 'received', fileUploaded: uploaded,
  contentType: uploaded ? 'application/json' : null, sha256: uploaded ? sha : null, createdAt: date, updatedAt: date, ...over });
const attempt = (state: string) => ({ attemptId, revision, state, expiresAt: new Date(Date.now() + 300000).toISOString() });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function file(name = 'synthetic.json', bytes = 'x') {
  const result = new File([bytes], name);
  Object.defineProperty(result, 'arrayBuffer', { value: async () => new TextEncoder().encode(bytes).buffer });
  return result;
}
let values: ProductUploadValues;
let owner: RecoverySession;
const submitReport = (input: ProductUploadValues, api: ApiFetch, progress: UploadProgress, signal?: AbortSignal) => rawSubmitReport(input, api, progress, signal, owner);
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('window', { sessionStorage: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) } });
  owner = startRecoverySession('a'.repeat(64));
  values = { patientId, reportType: 'structured', file: file(), syntheticConfirmed: true };
});
afterEach(() => { clearRecovery(); endRecoverySession(owner); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** An upload that registers, declares and then loses the reply to the transfer: the state a reload leaves behind. */
async function interrupt(progress: UploadProgress = {}) {
  const api = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
    .mockResolvedValueOnce(response(attempt('declared'))).mockRejectedValueOnce(new Error('the page was reloaded'));
  await expect(submitReport(values, api, progress)).rejects.toThrow('interrupted');
  return progress;
}
/** The page after the reload: a new progress built from what the tab kept. */
const reloaded = () => restoreProgress(readRecovery(owner)!, owner);

describe('what the browser keeps', () => {
  it('keeps the report, the registration key, the declaration, the attempt and the file facts: no patient, no bytes, no token', async () => {
    const first = await interrupt();
    const raw = memory.get('telesphoros.upload-recovery.v2')!;
    const saved = JSON.parse(raw);
    expect(saved).toMatchObject({ v: 2, scope: owner.scope, requestId: first.requestId, reportId: id, file: { reportType: 'structured', sizeBytes: 1, sha256: sha },
      declaration: { revision: original, contentType: 'application/json', sha256: sha }, attempt: { attemptId, revision, state: 'declared' } });
    expect(Object.keys(saved).sort()).toEqual(['attempt', 'declaration', 'file', 'reportId', 'requestId', 'savedAt', 'scope', 'v']);
    expect(saved.file).not.toHaveProperty('name');
    expect(raw).not.toContain('synthetic.json');
    expect(raw).not.toContain(patientId);
    expect(raw).not.toMatch(/Bearer|eyJ|patientId|uploadUrl|signature/i);
  });

  it('removes a record saved with a file name before the name was dropped', () => {
    memory.set('telesphoros.upload-recovery.v2', JSON.stringify({ v: 2, scope: owner.scope, requestId: id, reportId: id,
      file: { reportType: 'structured', name: 'synthetic.json', sizeBytes: 1, sha256: sha }, savedAt: new Date().toISOString() }));
    expect(readRecovery(owner)).toBeUndefined();
    expect(memory.has('telesphoros.upload-recovery.v2')).toBe(false);
  });

  it('keeps nothing before the report exists, and refuses a damaged or extended record (removing it)', async () => {
    const lost = vi.fn().mockRejectedValue(new Error('lost'));
    await expect(submitReport(values, lost, {})).rejects.toThrow('interrupted');
    expect(memory.size).toBe(0);
    for (const bad of ['not json', '{}', JSON.stringify({ v: 2, scope: owner.scope, requestId: id, reportId: id, file: { reportType: 'vcf', name: 'a.vcf', sizeBytes: 1, sha256: sha }, savedAt: date, patientId })]) {
      memory.set('telesphoros.upload-recovery.v2', bad);
      expect(readRecovery(owner)).toBeUndefined();
      expect(memory.has('telesphoros.upload-recovery.v2')).toBe(false);
    }
  });

  it('works without storage: nothing is kept and the upload still finishes', async () => {
    vi.stubGlobal('window', { get sessionStorage(): never { throw new Error('blocked'); } });
    const api = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
      .mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
    await expect(submitReport(values, api, {})).resolves.toEqual({ reference: id });
    expect(readRecovery(owner)).toBeUndefined();
  });

  it('is cleared when the upload is verified, and the local experiment never writes it', async () => {
    const ok = () => vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
      .mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
    await submitReport(values, ok(), {});
    expect(readRecovery(owner)).toBeUndefined();
    const { submitOwnedReport } = await import('./ownedStorageApi');
    const dev = ok(); dev.mockReset().mockRejectedValue(new Error('lost'));
    await expect(submitOwnedReport(values, dev, {}, undefined, { remember: false })).rejects.toThrow();
    const partial = vi.fn().mockResolvedValueOnce(response(report())).mockRejectedValue(new Error('lost'));
    await expect(submitOwnedReport(values, partial, {}, undefined, { remember: false })).rejects.toThrow();
    expect(readRecovery(owner)).toBeUndefined();
  });
});

describe('after a reload', () => {
  it('finishes the same upload: no second registration, the original declaration is replayed, and the record is cleared', async () => {
    await interrupt();
    const after = reloaded();
    const retry = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
    await expect(submitReport(values, retry, after)).resolves.toEqual({ reference: id });
    expect(retry.mock.calls.map(call => `${call[1]?.method ?? 'GET'} ${call[0]}`)).toEqual([
      `GET /api/v1/reports/${id}`, `POST /api/v1/reports/${id}/upload-attempts`, `PUT /api/v1/reports/${id}/upload-attempts/${attemptId}/bytes`, `GET /api/v1/reports/${id}`]);
    expect(JSON.parse(retry.mock.calls[1]![1].body)).toMatchObject({ revision: original, sha256: sha }); // the original declaration, byte for byte its request id too
    expect(readRecovery(owner)).toBeUndefined();
  });

  it('does not send the bytes again when the server already stored them (reload after a lost commit reply)', async () => {
    await interrupt();
    const retry = vi.fn().mockResolvedValueOnce(response(report(true)));
    await expect(submitReport(values, retry, reloaded())).resolves.toEqual({ reference: id });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(readRecovery(owner)).toBeUndefined();
  });

  it('resumes a stored but uncommitted attempt without resending', async () => {
    await interrupt();
    const retry = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(attempt('stored'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
    await expect(submitReport(values, retry, reloaded())).resolves.toEqual({ reference: id });
    expect(retry.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(false);
    expect(retry.mock.calls.some(call => String(call[0]).endsWith('/resume'))).toBe(true);
  });

  it('refuses another patient for the interrupted report, naming why, and sends nothing more', async () => {
    await interrupt();
    const retry = vi.fn().mockResolvedValueOnce(response(report()));
    await expect(submitReport({ ...values, patientId: otherPatient }, retry, reloaded())).rejects.toThrow('another patient');
    expect(retry).toHaveBeenCalledTimes(1);
    expect(readRecovery(owner)).toBeDefined(); // still there to finish or cancel
  });

  it('refuses a different file while an attempt is pending, and keeps the record', async () => {
    await interrupt();
    const other = vi.fn();
    await expect(submitReport({ ...values, file: file('other.json', 'yy') }, other, reloaded())).rejects.toThrow('interrupted upload of another file');
    expect(other).not.toHaveBeenCalled();
    expect(readRecovery(owner)).toBeDefined();
  });

  it('starts fresh when the interrupted upload had not declared anything (a different file is a new upload)', async () => {
    const api = vi.fn().mockResolvedValueOnce(response(report())).mockRejectedValueOnce(new Error('lost'));
    await expect(submitReport(values, api, {})).rejects.toThrow('interrupted');
    expect(readRecovery(owner)).toMatchObject({ reportId: id });
    expect(readRecovery(owner)!.declaration).toBeUndefined();
    const previousKey = readRecovery(owner)!.requestId;
    const fresh = vi.fn().mockResolvedValueOnce(response(report(false, { filename: 'other.json', sizeBytes: 2, id: original })));
    await expect(submitReport({ ...values, file: file('other.json', 'yy') }, fresh, reloaded())).rejects.toThrow(); // stops at the second call: nothing mocked
    expect(JSON.parse(fresh.mock.calls[0]![1].body)).toMatchObject({ filename: 'other.json' }); // registered anew
    expect(JSON.parse(fresh.mock.calls[0]![1].body).requestId).not.toBe(previousKey); // a new registration key, not the interrupted one's
  });

  it('starts a new upload when the restored report is gone (404), instead of failing forever', async () => {
    await interrupt();
    const after = reloaded();
    const retry = vi.fn().mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response(report(false, { id: original })))
      .mockResolvedValueOnce(response({ revision, fileUploaded: false })).mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('committed')))
      .mockResolvedValueOnce(response(report(true, { id: original })));
    await expect(submitReport(values, retry, after)).resolves.toEqual({ reference: original });
    expect(retry.mock.calls[1]![0]).toBe('/api/v1/reports'); // registered again
    expect(readRecovery(owner)).toBeUndefined();
  });

  it('shows any other server refusal of the restored upload and keeps the record', async () => {
    await interrupt();
    await expect(submitReport(values, vi.fn().mockResolvedValue(response({}, 500)), reloaded())).rejects.toThrow(SubmitError);
    expect(readRecovery(owner)).toMatchObject({ reportId: id });
  });
});

describe('cancelling after a reload', () => {
  it('asks the server to cancel the saved attempt and forgets it only when the server acknowledges', async () => {
    await interrupt();
    const api = vi.fn().mockResolvedValueOnce(response(attempt('cancelling')));
    await expect(cancelOwnedUpload(api, reloaded())).rejects.toThrow('pending');
    expect(api.mock.calls[0]![0]).toBe(`/api/v1/reports/${id}/upload-attempts/${attemptId}/cancel`);
    expect(api.mock.calls[0]![1].headers['X-Upload-Revision']).toBe(revision);
    expect(readRecovery(owner)).toMatchObject({ attempt: { state: 'cancelling' } }); // the state the server reported is kept
    const done = vi.fn().mockResolvedValueOnce(response(attempt('cancelled')));
    await expect(cancelOwnedUpload(done, reloaded())).resolves.toBeUndefined();
    expect(readRecovery(owner)).toBeUndefined();
  });

  it('keeps the record when the cancellation never reached the server, so it can be tried again', async () => {
    await interrupt();
    await expect(cancelOwnedUpload(vi.fn().mockRejectedValue(new Error('offline')), reloaded())).rejects.toThrow('offline');
    expect(readRecovery(owner)).toMatchObject({ reportId: id, attempt: { state: 'declared' } });
    await expect(cancelOwnedUpload(vi.fn().mockResolvedValueOnce(response({}, 500)), reloaded())).rejects.toBeInstanceOf(SubmitError);
    expect(readRecovery(owner)).toMatchObject({ reportId: id });
  });

  it('has nothing to cancel on the server when nothing was declared, and just forgets the record', async () => {
    const api = vi.fn().mockResolvedValueOnce(response(report())).mockRejectedValueOnce(new Error('lost'));
    await expect(submitReport(values, api, {})).rejects.toThrow('interrupted');
    const none = vi.fn();
    await cancelOwnedUpload(none, reloaded());
    expect(none).not.toHaveBeenCalled();
    expect(readRecovery(owner)).toBeUndefined();
  });
});

describe('the record API', () => {
  it('clearRecovery and rememberUpload tolerate missing data', () => {
    rememberUpload({});
    expect(memory.size).toBe(0);
    expect(() => clearRecovery()).not.toThrow();
  });
});

describe('verified ownership, lifetime and late work', () => {
  const seed = () => {
    const progress: UploadProgress = { requestId: original, reportId: id, facts: { reportType: 'structured', name: 'SYNTHETIC-private.json', sizeBytes: 1, sha256: sha } };
    bindRecovery(progress, owner); rememberUpload(progress); return progress;
  };
  it('a new verified person or tenant cannot read or revive the previous session record', () => {
    const oldProgress = seed(); const oldOwner = owner;
    expect(readRecovery()).toBeUndefined();
    endRecoverySession(oldOwner); owner = startRecoverySession('b'.repeat(64));
    expect(readRecovery(owner)).toBeUndefined();
    rememberUpload(oldProgress);
    expect(memory.has('telesphoros.upload-recovery.v2')).toBe(false);
  });
  it('same-person reauthentication keeps recovery and its original timestamp, but retires old writers and clearers', () => {
    const oldProgress = seed(); const before = readRecovery(owner)!;
    endRecoverySession(owner); owner = startRecoverySession('a'.repeat(64));
    const newProgress = restoreProgress(readRecovery(owner)!, owner);
    forgetUpload(oldProgress); rememberUpload(oldProgress);
    expect(readRecovery(owner)).toEqual(before);
    rememberUpload(newProgress);
    expect(readRecovery(owner)!.savedAt).toBe(before.savedAt);
  });
  it('retries do not extend the one-hour deadline; storage expires even without another read', () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-14T12:00:00Z');
    const progress = seed(); const first = readRecovery(owner)!;
    vi.advanceTimersByTime(RECOVERY_LIFETIME_MS - 1);
    rememberUpload(progress);
    expect(readRecovery(owner)!.savedAt).toBe(first.savedAt);
    vi.advanceTimersByTime(1);
    expect(memory.has('telesphoros.upload-recovery.v2')).toBe(false);
    rememberUpload(progress);
    expect(readRecovery(owner)).toBeUndefined();
  });
  it.each(['2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z'])('refuses stale or future-dated metadata (%s)', savedAt => {
    seed(); const raw = JSON.parse(memory.get('telesphoros.upload-recovery.v2')!);
    memory.set('telesphoros.upload-recovery.v2', JSON.stringify({ ...raw, savedAt }));
    expect(readRecovery(owner)).toBeUndefined();
    expect(memory.has('telesphoros.upload-recovery.v2')).toBe(false);
  });
  it('a delayed response cannot save metadata, advance the transfer or clear a newer caller record', async () => {
    let arrived!: () => void; const reached = new Promise<void>(resolve => { arrived = resolve; });
    let reply!: (r: Response) => void;
    const api = vi.fn().mockImplementationOnce(() => { arrived(); return new Promise<Response>(resolve => { reply = resolve; }); });
    const pending = rawSubmitReport(values, api, {}, undefined, owner);
    const refused = expect(pending).rejects.toThrow('session ended');
    await reached;
    endRecoverySession(owner); owner = startRecoverySession('b'.repeat(64));
    const current = seed(); const kept = readRecovery(owner)!;
    reply(response(report())); await refused;
    expect(api).toHaveBeenCalledTimes(1);
    expect(readRecovery(owner)).toEqual(kept);
    forgetUpload(current); expect(readRecovery(owner)).toBeUndefined();
  });
  it('retiring the session while a reply body is pending prevents progress advancement', async () => {
    let reading!: () => void; const reached = new Promise<void>(resolve => { reading = resolve; });
    let finish!: (value: unknown) => void;
    const reply = response(report());
    reply.json = () => { reading(); return new Promise(resolve => { finish = resolve; }); };
    const api = vi.fn().mockResolvedValueOnce(reply);
    const progress: UploadProgress = {};
    const pending = rawSubmitReport(values, api, progress, undefined, owner);
    const refused = expect(pending).rejects.toThrow('session ended');
    await reached; endRecoverySession(owner); owner = startRecoverySession('b'.repeat(64));
    finish(report()); await refused;
    expect(progress.reportId).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(1);
    expect(readRecovery(owner)).toBeUndefined();
  });
  it('retiring the session during file hashing prevents even the first API call', async () => {
    let hashing!: () => void; const reached = new Promise<void>(resolve => { hashing = resolve; });
    let finish!: (v: ArrayBuffer) => void;
    const delayed = new File(['x'], 'synthetic.json');
    Object.defineProperty(delayed, 'arrayBuffer', { value: () => { hashing(); return new Promise<ArrayBuffer>(resolve => { finish = resolve; }); } });
    const api = vi.fn();
    const pending = rawSubmitReport({ ...values, file: delayed }, api, {}, undefined, owner);
    const refused = expect(pending).rejects.toThrow('session ended');
    await reached; endRecoverySession(owner); owner = startRecoverySession('b'.repeat(64));
    finish(new TextEncoder().encode('x').buffer); await refused;
    expect(api).not.toHaveBeenCalled();
    expect(readRecovery(owner)).toBeUndefined();
  });
});


it('memory-only fallback can finish an upload without persistence and still retires a delayed body', async () => {
  owner = startRecoverySession();
  const ok = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response({ revision: original, fileUploaded: false }))
    .mockResolvedValueOnce(response(attempt('declared'))).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
  await expect(submitReport(values, ok, {})).resolves.toEqual({ reference: id });
  expect(memory.size).toBe(0);
  let reading!: () => void; const reached = new Promise<void>(resolve => { reading = resolve; });
  let finish!: (value: unknown) => void;
  const reply = response(report()); reply.json = () => { reading(); return new Promise(resolve => { finish = resolve; }); };
  const api = vi.fn().mockResolvedValueOnce(reply); const progress: UploadProgress = {};
  const pending = submitReport(values, api, progress); const refused = expect(pending).rejects.toThrow('session ended');
  await reached; endRecoverySession(owner); finish(report()); await refused;
  expect(api).toHaveBeenCalledTimes(1);
  expect(progress.reportId).toBeUndefined();
  expect(memory.size).toBe(0);
});

describe('late responses racing newer recovery', () => {
  const lifetimes = ['page', 'session'] as const;
  function retire(lifetime: typeof lifetimes[number], progress: UploadProgress) {
    if (lifetime === 'page') retireOwnedUpload(progress);
    else { endRecoverySession(owner); owner = startRecoverySession('b'.repeat(64)); }
  }
  function saveNewerRecovery() {
    const newer = { requestId: otherPatient, reportId: attemptId,
      facts: { reportType: 'structured' as const, name: 'synthetic-newer.json', sizeBytes: 2, sha256: sha } };
    bindRecovery(newer, owner);
    rememberUpload(newer);
    return readRecovery(owner)!;
  }

  it.each((['resume', 'verification'] as const).flatMap(stage => lifetimes.map(lifetime => ({ stage, lifetime }))))(
    'a delayed $stage body cannot change progress or newer recovery after $lifetime retirement', async ({ stage, lifetime }) => {
      const progress: UploadProgress = {};
      const pendingIndex = stage === 'resume' ? 3 : 4;
      const bodies = [report(), { revision: original, fileUploaded: false }, attempt(stage === 'resume' ? 'stored' : 'declared'), attempt('committed'), report(true)];
      let reading!: () => void;
      const reached = new Promise<void>(resolve => { reading = resolve; });
      let finish!: (value: unknown) => void;
      let calls = 0;
      const api = vi.fn(async () => {
        const index = calls++;
        const reply = response(bodies[index]);
        if (index === pendingIndex) reply.json = () => { reading(); return new Promise(resolve => { finish = resolve; }); };
        return reply;
      });
      const pending = submitReport(values, api, progress);
      const refused = expect(pending).rejects.toThrow(lifetime === 'page' ? 'Upload page ended' : 'Upload session ended');
      await reached;
      const before = JSON.stringify(progress);
      retire(lifetime, progress);
      const kept = saveNewerRecovery();
      expect(kept.file.sizeBytes).toBe(2);
      finish(bodies[pendingIndex]);
      await refused;
      expect(JSON.stringify(progress)).toBe(before);
      expect(api).toHaveBeenCalledTimes(pendingIndex + 1);
      expect(readRecovery(owner)).toEqual(kept);
    },
  );

  it.each(lifetimes)('a stale restored 404 cannot reset keys or clear newer recovery after %s retirement', async lifetime => {
    await interrupt();
    const progress = reloaded();
    let arrived!: () => void;
    const reached = new Promise<void>(resolve => { arrived = resolve; });
    let finish!: (reply: Response) => void;
    const api = vi.fn(() => { arrived(); return new Promise<Response>(resolve => { finish = resolve; }); });
    const pending = submitReport(values, api, progress);
    const refused = expect(pending).rejects.toThrow(lifetime === 'page' ? 'Upload page ended' : 'Upload session ended');
    await reached;
    const before = JSON.stringify(progress);
    retire(lifetime, progress);
    const kept = saveNewerRecovery();
    expect(kept.file.sizeBytes).toBe(2);
    finish(response({}, 404));
    await refused;
    expect(JSON.stringify(progress)).toBe(before);
    expect(api).toHaveBeenCalledTimes(1);
    expect(readRecovery(owner)).toEqual(kept);
  });
});


describe('recovery-to-download', () => {
  function downloadEnvironment() {
    const storage = window.sessionStorage;
    vi.stubGlobal('window', { sessionStorage: storage, location: { hostname: '127.0.0.1' } });
    const BaseURL = URL;
    const createObjectURL = vi.fn(() => 'blob:synthetic-review');
    vi.stubGlobal('URL', class extends BaseURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal('Blob', NodeBlob);
    const click = vi.fn();
    vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click, remove: vi.fn() }), body: { append: vi.fn() } });
    vi.stubEnv('VITE_REPORT_STORAGE_ORIGINS', 'https://storage.example.test');
    const retrieve = vi.fn().mockResolvedValue(new Response('x'));
    vi.stubGlobal('fetch', retrieve);
    return { click, createObjectURL, retrieve };
  }
  function downloadLink(over: object = {}) {
    return { url: 'https://storage.example.test/file?versionId=synthetic-version', expiresAt: new Date(Date.now() + 60000).toISOString(), ...over };
  }
  function saveNewerRecoveryForDownload() {
    const newer = { requestId: otherPatient, reportId: attemptId,
      facts: { reportType: 'structured' as const, name: 'synthetic-review-newer.json', sizeBytes: 2, sha256: sha } };
    bindRecovery(newer, owner); rememberUpload(newer);
    const kept = readRecovery(owner)!;
    expect(kept.file.sizeBytes).toBe(2);
    return kept;
  }
  it.each(['stored', 'unresolved', 'committed'])('recovered %s attempt clears only its recovery and downloads verified bytes', async state => {
    await interrupt(); const progress = reloaded();
    const env = downloadEnvironment();
    const bodies = [report(), attempt(state), ...(state === 'committed' ? [] : [attempt('committed')]), report(true), downloadLink()];
    const api = vi.fn(); for (const body of bodies) api.mockResolvedValueOnce(response(body));
    await expect(submitReport(values, api, progress)).resolves.toEqual({ reference: id });
    expect(readRecovery(owner)).toBeUndefined();
    await downloadReport(api, id, 'synthetic.json', 1, sha);
    expect(api.mock.calls.filter(call => call[0] === '/api/v1/reports')).toHaveLength(0);
    expect(api).toHaveBeenLastCalledWith('/api/v1/reports/' + id + '/download-url', expect.any(Object));
    expect(env.retrieve).toHaveBeenCalledTimes(1);
    expect(env.retrieve).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' }));
    expect(env.retrieve.mock.calls[0]![0].searchParams.get('versionId')).toBe('synthetic-version');
    expect(env.click).toHaveBeenCalledTimes(1); expect(readRecovery(owner)).toBeUndefined();
  });
  it.each(['origin', 'expiry', 'checksum', 'size'])('a recovered-report download %s failure cannot erase newer recovery or emit a file', async fault => {
    await interrupt(); const progress = reloaded(); const env = downloadEnvironment();
    const resume = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true)));
    await submitReport(values, resume, progress);
    const kept = saveNewerRecoveryForDownload();
    const link = downloadLink(fault === 'origin' ? { url: 'https://storage.example.test.evil.invalid/file' } : fault === 'expiry' ? { expiresAt: new Date(Date.now() - 1).toISOString() } : {});
    const api = vi.fn().mockResolvedValue(response(link));
    if (fault === 'checksum') env.retrieve.mockResolvedValue(new Response('y'));
    if (fault === 'size') env.retrieve.mockResolvedValue(new Response('xx'));
    await expect(downloadReport(api, id, 'synthetic.json', 1, sha)).rejects.toThrow('unavailable');
    expect(env.click).not.toHaveBeenCalled(); expect(env.createObjectURL).not.toHaveBeenCalled();
    expect(env.retrieve).toHaveBeenCalledTimes(fault === 'origin' || fault === 'expiry' ? 0 : 1);
    expect(readRecovery(owner)).toEqual(kept);
  });
  it.each((['resume', 'verification'] as const).flatMap(stage => (['page', 'session'] as const).map(lifetime => ({ stage, lifetime }))))(
    'retiring $lifetime during recovered $stage body prevents downstream download and preserves newer recovery', async ({ stage, lifetime }) => {
      await interrupt(); const progress = reloaded(); const env = downloadEnvironment();
      const bodies = [report(), attempt('stored'), attempt('committed'), report(true)];
      const pendingIndex = stage === 'resume' ? 2 : 3;
      let arrived!: () => void; const reached = new Promise<void>(resolve => { arrived = resolve; });
      let finish!: (body: unknown) => void;
      let calls = 0;
      const api = vi.fn(async () => {
        const index = calls++; const reply = response(bodies[index]);
        if (index === pendingIndex) reply.json = () => { arrived(); return new Promise(resolve => { finish = resolve; }); };
        return reply;
      });
      const pending = submitReport(values, api, progress).then(result => downloadReport(api, result.reference, 'synthetic.json', 1, sha));
      const refused = expect(pending).rejects.toThrow(lifetime === 'page' ? 'Upload page ended' : 'Upload session ended');
      await reached; const before = JSON.stringify(progress);
      if (lifetime === 'page') retireOwnedUpload(progress); else { endRecoverySession(owner); owner = startRecoverySession('b'.repeat(64)); }
      const kept = saveNewerRecoveryForDownload();
      finish(bodies[pendingIndex]); await refused;
      expect(JSON.stringify(progress)).toBe(before); expect(api).toHaveBeenCalledTimes(pendingIndex + 1);
      expect(env.retrieve).not.toHaveBeenCalled(); expect(env.click).not.toHaveBeenCalled();
      expect(readRecovery(owner)).toEqual(kept);
    },
  );
  it('memory-only fallback can reconcile a same-page lost reply and download without recovery storage', async () => {
    endRecoverySession(owner); owner = startRecoverySession();
    const progress = await interrupt(); const env = downloadEnvironment();
    const api = vi.fn().mockResolvedValueOnce(response(report())).mockResolvedValueOnce(response(attempt('committed'))).mockResolvedValueOnce(response(report(true))).mockResolvedValueOnce(response(downloadLink()));
    await submitReport(values, api, progress); await downloadReport(api, id, 'synthetic.json', 1, sha);
    expect(memory.size).toBe(0); expect(env.retrieve).toHaveBeenCalledTimes(1); expect(env.click).toHaveBeenCalledTimes(1);
  });
});
