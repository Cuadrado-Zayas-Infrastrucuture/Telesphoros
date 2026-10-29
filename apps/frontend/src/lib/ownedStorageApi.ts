import { z } from 'zod';
import { fileLinkDtoSchema, paginatedSchema, reportCreateSchema, reportDtoSchema, reportListQuerySchema } from '@telesphoros/shared-types';
import { SessionEndedError, NotSignedInError } from '@/auth/AuthProvider';
import { SubmitError, refusal, reportStorageOrigins, type ApiFetch, type UploadProgress } from './api';
import type { ProductUploadValues } from './productUploadSchema';
import { attemptSchema, type FileFacts } from './uploadProgress';
import { bindRecovery, forgetUpload, rememberUpload, sameFile, uploadSessionCurrent, type RecoveryEntry, type RecoverySession } from './uploadRecovery';

export type { OwnedProgress } from './uploadProgress';

/** Progress objects whose uploads are remembered for recovery after a reload (the local experiment's are not). */
const remembered = new WeakSet<object>();
// A page may leave while its registration/body reply is still pending. This lifetime is separate from sign-in.
const lifetimes = new WeakMap<object, 'active' | 'retired'>();
const assertLiveUpload = (progress: UploadProgress) => {
  if (lifetimes.get(progress) === 'retired') throw new SessionEndedError('Upload page ended');
  if (!uploadSessionCurrent(progress)) throw new SessionEndedError('Upload session ended');
};
const beginUpload = (progress: UploadProgress) => {
  assertLiveUpload(progress);
  lifetimes.set(progress, 'active');
};
/** Retire pending work, retaining its saved recovery entry. Idle progress has no callbacks; StrictMode may replay its initial cleanup. */
export function retireOwnedUpload(progress: UploadProgress): void {
  if (lifetimes.has(progress)) lifetimes.set(progress, 'retired');
}
const liveUploadApi =
  (api: ApiFetch, progress: UploadProgress): ApiFetch =>
  async (path, init) => {
    assertLiveUpload(progress);
    const response = await api(path, init);
    assertLiveUpload(progress);
    return response;
  };
const save = (progress: UploadProgress) => {
  assertLiveUpload(progress);
  if (remembered.has(progress)) rememberUpload(progress);
};

/** A progress object restored from what the browser kept before a reload; the server confirms or refuses it on the first request. */
export function restoreProgress(entry: RecoveryEntry, session: RecoverySession): UploadProgress {
  const progress: UploadProgress = {
    requestId: entry.requestId,
    reportId: entry.reportId,
    facts: entry.file,
    restored: true,
    ...(entry.declaration ? { declaration: entry.declaration } : {}),
    ...(entry.attempt ? { attempt: entry.attempt } : {}),
  };
  remembered.add(progress);
  bindRecovery(progress, session, entry);
  return progress;
}
async function request(api: ApiFetch, path: string, body?: unknown, revision?: string) {
  const response = await api(`/api/v1${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(revision ? { 'X-Upload-Revision': revision } : {}) },
  });
  if (!response.ok) {
    if ([403, 404, 429].includes(response.status)) throw refusal(response.status); // permission, missing patient or report, rate limit: said plainly
    throw new SubmitError(
      response.status === 409
        ? 'The upload needs reconciliation or a new attempt. Retry or cancel before starting over.'
        : 'The file operation is unavailable. Your entries are kept; please retry.',
      response.status,
    );
  }
  return response.json();
}
function acceptAttempt(progress: UploadProgress, value: unknown) {
  assertLiveUpload(progress);
  const result = attemptSchema.parse(value);
  if (progress.attempt && (result.attemptId !== progress.attempt.attemptId || result.revision !== progress.attempt.revision)) throw new Error('Attempt changed');
  progress.attempt = result;
  save(progress);
  return result;
}
async function declare(api: ApiFetch, progress: UploadProgress) {
  return acceptAttempt(progress, await request(api, `/reports/${progress.reportId}/upload-attempts`, progress.declaration));
}
/** Cancel is acknowledged by the server; aborting a browser request alone is not cancellation. */
export async function cancelOwnedUpload(api: ApiFetch, progress: UploadProgress) {
  beginUpload(progress);
  api = liveUploadApi(api, progress);
  progress.cancelRequested = true;
  if (!progress.reportId || !progress.declaration) {
    if (remembered.has(progress)) forgetUpload(progress); // no attempt to cancel
    return;
  }
  const attempt = progress.attempt ?? (await declare(api, progress));
  const result = acceptAttempt(progress, await request(api, `/reports/${progress.reportId}/upload-attempts/${attempt.attemptId}/cancel`, {}, attempt.revision));
  if (!['cancelled', 'cleaned', 'committed'].includes(result.state)) throw new SubmitError('Cancellation is pending. Retry cancellation before starting over.');
  if (remembered.has(progress)) forgetUpload(progress); // acknowledged by the server
  if (result.state === 'committed') throw new SubmitError('The file was already stored. Check Reports before starting another upload.');
}
export async function submitOwnedReport(
  values: ProductUploadValues,
  api: ApiFetch,
  progress: UploadProgress,
  signal?: AbortSignal,
  options: { remember?: boolean; recoverySession?: RecoverySession } = {},
): Promise<{ reference: string }> {
  beginUpload(progress);
  api = liveUploadApi(api, progress);
  if (options.remember !== false && options.recoverySession) {
    bindRecovery(progress, options.recoverySession);
    remembered.add(progress);
  }
  signal?.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await values.file.arrayBuffer())), (b) => b.toString(16).padStart(2, '0')).join('');
  signal?.throwIfAborted();
  assertLiveUpload(progress);
  const contentType = values.reportType === 'lab-pdf' ? 'application/pdf' : 'application/json';
  const identity = JSON.stringify([values.patientId.toLowerCase(), values.reportType, values.file.name, values.file.size, sha256]);
  const facts: FileFacts = { reportType: values.reportType, name: values.file.name, sizeBytes: values.file.size, sha256 };
  // A progress that was restored after a reload has its facts and keys already; the first thing the person does is choose the patient and file again.
  const restoredFile = progress.restored && !progress.identity ? progress.facts : undefined;
  const sameUpload = restoredFile ? sameFile(restoredFile, facts) : progress.identity === identity;
  if ((progress.identity || restoredFile) && !sameUpload && progress.declaration && !['cancelled', 'cleaned', 'committed'].includes(progress.attempt?.state ?? '')) {
    throw new SubmitError(
      restoredFile
        ? 'An interrupted upload of another file is waiting. Choose that file to finish it, or cancel it first.'
        : 'Cancel the previous upload before changing the patient or file.',
    );
  }
  if (restoredFile && sameUpload) {
    progress.identity = identity; // the same file: carry on with the restored report, declaration and attempt
  } else if (progress.identity !== identity || !progress.requestId) {
    if (restoredFile) forgetUpload(progress); // the interrupted upload has nothing on the server to finish
    const cancelled = progress.cancelRequested;
    for (const key of Object.keys(progress)) delete progress[key as keyof UploadProgress];
    Object.assign(progress, { identity, requestId: crypto.randomUUID(), cancelRequested: cancelled, facts });
  }
  progress.facts = facts;
  function report(value: unknown) {
    assertLiveUpload(progress);
    const result = reportDtoSchema.parse(value);
    if (progress.restored && progress.reportId === result.id && result.patientId !== values.patientId)
      throw new SubmitError('The interrupted upload was for another patient. Choose that patient to finish it, or cancel it first.');
    if (
      result.patientId !== values.patientId ||
      result.type !== values.reportType ||
      result.filename !== values.file.name ||
      result.sizeBytes !== values.file.size ||
      (progress.reportId && result.id !== progress.reportId)
    )
      throw new Error('Report mismatch');
    return result;
  }
  const register = () =>
    request(
      api,
      '/reports',
      reportCreateSchema.parse({ patientId: values.patientId, type: values.reportType, filename: values.file.name, sizeBytes: values.file.size, requestId: progress.requestId }),
    );
  let existing: ReturnType<typeof report>;
  try {
    existing = report(await (progress.reportId ? request(api, `/reports/${progress.reportId}`) : register()));
  } catch (error) {
    assertLiveUpload(progress);
    if (!(progress.restored && error instanceof SubmitError && error.status === 404)) throw error;
    // The restored report is gone (deleted, or it was another person's): this is a new upload.
    forgetUpload(progress);
    for (const key of Object.keys(progress)) delete progress[key as keyof UploadProgress];
    Object.assign(progress, { identity, requestId: crypto.randomUUID(), facts });
    existing = report(await register());
  }
  progress.reportId = existing.id;
  save(progress);
  const verified = (value: unknown) => {
    const result = report(value);
    if (!result.fileUploaded || result.sha256 !== sha256 || result.contentType !== contentType) throw new Error('File not verified');
    if (remembered.has(progress)) forgetUpload(progress); // finished and verified
    return { reference: result.id };
  };
  if (existing.fileUploaded) return verified(existing);
  if (progress.cancelRequested || signal?.aborted) throw new SubmitError('Upload cancelled.');
  if (!progress.declaration) {
    const state = z.object({ revision: z.uuid(), fileUploaded: z.boolean() }).parse(await request(api, `/reports/${existing.id}/upload-state`));
    assertLiveUpload(progress);
    progress.declaration = { requestId: crypto.randomUUID(), revision: state.revision, contentType, sha256 };
    save(progress);
  }
  // Replaying the original declaration recovers a lost reply and returns the durable state.
  const attempt = await declare(api, progress);
  if (progress.cancelRequested || signal?.aborted) throw new SubmitError('Upload cancelled.');
  if (Date.parse(attempt.expiresAt) <= Date.now() && attempt.state !== 'committed') throw new SubmitError('This attempt expired. Cancel it before starting over.');
  const path = `/reports/${existing.id}/upload-attempts/${attempt.attemptId}`;
  if (attempt.state === 'declared') {
    const response = await api(`/api/v1${path}/bytes`, {
      method: 'PUT',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': contentType, 'X-Upload-Revision': attempt.revision },
      body: values.file,
      signal,
    });
    if (!response.ok) throw new SubmitError('The server refused or interrupted the file. Retry to check its state, or cancel before starting over.');
    acceptAttempt(progress, await response.json());
  } else if (attempt.state === 'stored' || attempt.state === 'unresolved') {
    acceptAttempt(progress, await request(api, `${path}/resume`, {}, attempt.revision));
  } else if (attempt.state !== 'committed') {
    throw new SubmitError('This attempt is not ready. Retry later, or cancel before starting over.');
  }
  if (!progress.attempt || progress.attempt.attemptId !== attempt.attemptId || progress.attempt.revision !== attempt.revision || progress.attempt.state !== 'committed')
    throw new Error('Commit not confirmed');
  return verified(await request(api, `/reports/${existing.id}`));
}

/** One bounded tenant-authorized page; the dashboard keeps filters out of browser history. */
export async function listReports(api: ApiFetch, page: number, signal?: AbortSignal, patientId?: string) {
  try {
    const query = reportListQuerySchema.parse({ page, pageSize: 20, ...(patientId ? { patientId } : {}) });
    if (!Number.isSafeInteger(query.page)) throw new Error();
    const params = new URLSearchParams({ page: String(query.page), pageSize: '20', ...(query.patientId ? { patientId: query.patientId } : {}) });
    const response = await api(`/api/v1/reports?${params}`, { signal });
    if (!response.ok) throw new Error();
    const result = paginatedSchema(reportDtoSchema).parse(await response.json());
    const { meta, data } = result;
    if (
      meta.page !== query.page ||
      meta.pageSize !== 20 ||
      data.length > 20 ||
      meta.totalPages !== Math.ceil(meta.total / 20) ||
      data.length > meta.total ||
      data.some((report) => query.patientId && report.patientId !== query.patientId)
    )
      throw new Error();
    return result;
  } catch (error) {
    if (signal?.aborted || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('Reports could not be loaded. Please retry.');
  }
}

export async function downloadReport(api: ApiFetch, id: string, filename: string, sizeBytes: number, sha256: string | null) {
  try {
    const origins = reportStorageOrigins();
    const link = fileLinkDtoSchema.parse(await request(api, `/reports/${id}/download-url`));
    const url = new URL(link.url);
    if (!origins.includes(url.origin) || url.username || url.password || url.hash || Date.parse(link.expiresAt) <= Date.now()) throw new Error();
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok || !response.body || sizeBytes > 10 * 1024 * 1024 || sizeBytes <= 0 || !sha256) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > sizeBytes) throw new Error();
        chunks.push(new Uint8Array(part.value));
      }
    } finally {
      await reader.cancel();
    }
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (b) => b.toString(16).padStart(2, '0')).join('');
    if (size !== sizeBytes || hash !== sha256) throw new Error();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(filename) ? filename : 'report.bin';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    if (error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('This file is unavailable or could not be verified. Refresh Reports and try again.');
  }
}
