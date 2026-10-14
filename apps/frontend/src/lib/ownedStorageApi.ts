import { z } from 'zod';
import { fileLinkDtoSchema, paginatedSchema, reportCreateSchema, reportDtoSchema, reportListQuerySchema } from '@telesphoros/shared-types';
import { SessionEndedError, NotSignedInError } from '@/auth/AuthProvider';
import { SubmitError, refusal, reportStorageOrigins, type ApiFetch, type UploadProgress } from './api';
import type { ProductUploadValues } from './productUploadSchema';

const attemptSchema = z.strictObject({
  attemptId: z.uuid(), revision: z.uuid(), expiresAt: z.iso.datetime(),
  state: z.enum(['declared', 'intaking', 'stored', 'unresolved', 'cancelling', 'cancelled', 'committed', 'cleanup', 'cleaned']),
});
type Attempt = z.infer<typeof attemptSchema>;
type Declaration = { requestId: string; revision: string; contentType: string; sha256: string };
export interface OwnedProgress {
  declaration?: Declaration;
  attempt?: Attempt;
  cancelRequested?: boolean;
}
async function request(api: ApiFetch, path: string, body?: unknown, revision?: string) {
  const response = await api(`/api/v1${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(revision ? { 'X-Upload-Revision': revision } : {}) },
  });
  if (!response.ok) {
    if ([403, 404, 429].includes(response.status)) throw refusal(response.status); // permission, missing patient or report, rate limit: said plainly
    throw new SubmitError(response.status === 409
      ? 'The upload needs reconciliation or a new attempt. Retry or cancel before starting over.'
      : 'The file operation is unavailable. Your entries are kept; please retry.');
  }
  return response.json();
}
function acceptAttempt(progress: UploadProgress, value: unknown) {
  const result = attemptSchema.parse(value);
  if (progress.attempt && (result.attemptId !== progress.attempt.attemptId || result.revision !== progress.attempt.revision)) throw new Error('Attempt changed');
  progress.attempt = result;
  return result;
}
async function declare(api: ApiFetch, progress: UploadProgress) {
  return acceptAttempt(progress, await request(api, `/reports/${progress.reportId}/upload-attempts`, progress.declaration));
}
/** Cancel is acknowledged by the server; aborting a browser request alone is not cancellation. */
export async function cancelOwnedUpload(api: ApiFetch, progress: UploadProgress) {
  progress.cancelRequested = true;
  if (!progress.reportId || !progress.declaration) return;
  const attempt = progress.attempt ?? await declare(api, progress);
  const result = acceptAttempt(progress, await request(api, `/reports/${progress.reportId}/upload-attempts/${attempt.attemptId}/cancel`, {}, attempt.revision));
  if (!['cancelled', 'cleaned', 'committed'].includes(result.state)) throw new SubmitError('Cancellation is pending. Retry cancellation before starting over.');
  if (result.state === 'committed') throw new SubmitError('The file was already stored. Check Reports before starting another upload.');
}
export async function submitOwnedReport(values: ProductUploadValues, api: ApiFetch, progress: UploadProgress, signal?: AbortSignal): Promise<{ reference: string }> {
  signal?.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await values.file.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
  signal?.throwIfAborted();
  const contentType = values.reportType === 'lab-pdf' ? 'application/pdf' : values.reportType === 'structured' ? 'application/json' : 'text/x-vcf';
  const identity = JSON.stringify([values.patientId.toLowerCase(), values.reportType, values.file.name, values.file.size, sha256]);
  if (progress.identity && progress.identity !== identity && progress.declaration && !['cancelled', 'cleaned', 'committed'].includes(progress.attempt?.state ?? '')) {
    throw new SubmitError('Cancel the previous upload before changing the patient or file.');
  }
  if (progress.identity !== identity || !progress.requestId) {
    const cancelled = progress.cancelRequested;
    for (const key of Object.keys(progress)) delete progress[key as keyof UploadProgress];
    Object.assign(progress, { identity, requestId: crypto.randomUUID(), cancelRequested: cancelled });
  }
  function report(value: unknown) {
    const result = reportDtoSchema.parse(value);
    if (result.patientId !== values.patientId || result.type !== values.reportType || result.filename !== values.file.name || result.sizeBytes !== values.file.size || (progress.reportId && result.id !== progress.reportId)) throw new Error('Report mismatch');
    return result;
  }
  const existing = report(await request(api, progress.reportId ? `/reports/${progress.reportId}` : '/reports', progress.reportId ? undefined : reportCreateSchema.parse({ patientId: values.patientId, type: values.reportType, filename: values.file.name, sizeBytes: values.file.size, requestId: progress.requestId })));
  progress.reportId = existing.id;
  const verified = (value: unknown) => {
    const result = report(value);
    if (!result.fileUploaded || result.sha256 !== sha256 || result.contentType !== contentType) throw new Error('File not verified');
    return { reference: result.id };
  };
  if (existing.fileUploaded) return verified(existing);
  if (progress.cancelRequested || signal?.aborted) throw new SubmitError('Upload cancelled.');
  if (!progress.declaration) {
    const state = z.object({ revision: z.uuid(), fileUploaded: z.boolean() }).parse(await request(api, `/reports/${existing.id}/upload-state`));
    progress.declaration = { requestId: crypto.randomUUID(), revision: state.revision, contentType, sha256 };
  }
  // Replaying the original declaration recovers a lost reply and returns the durable state.
  const attempt = await declare(api, progress);
  if (progress.cancelRequested || signal?.aborted) throw new SubmitError('Upload cancelled.');
  if (Date.parse(attempt.expiresAt) <= Date.now() && attempt.state !== 'committed') throw new SubmitError('This attempt expired. Cancel it before starting over.');
  const path = `/reports/${existing.id}/upload-attempts/${attempt.attemptId}`;
  if (attempt.state === 'declared') {
    const response = await api(`/api/v1${path}/bytes`, { method: 'PUT', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': contentType, 'X-Upload-Revision': attempt.revision }, body: values.file, signal });
    if (!response.ok) throw new SubmitError('The server refused or interrupted the file. Retry to check its state, or cancel before starting over.');
    acceptAttempt(progress, await response.json());
  } else if (attempt.state === 'stored' || attempt.state === 'unresolved') {
    acceptAttempt(progress, await request(api, `${path}/resume`, {}, attempt.revision));
  } else if (attempt.state !== 'committed') {
    throw new SubmitError('This attempt is not ready. Retry later, or cancel before starting over.');
  }
  if (!progress.attempt || progress.attempt.attemptId !== attempt.attemptId || progress.attempt.revision !== attempt.revision || progress.attempt.state !== 'committed') throw new Error('Commit not confirmed');
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
    if (meta.page !== query.page || meta.pageSize !== 20 || data.length > 20
      || meta.totalPages !== Math.ceil(meta.total / 20) || data.length > meta.total
      || data.some(report => query.patientId && report.patientId !== query.patientId)) throw new Error();
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
    const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > sizeBytes) throw new Error(); chunks.push(new Uint8Array(part.value)); }
    } finally { await reader.cancel(); }
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
    if (size !== sizeBytes || hash !== sha256) throw new Error();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(filename) ? filename : 'report.bin';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    if (error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('This file is unavailable or could not be verified. Refresh Reports and try again.');
  }
}
