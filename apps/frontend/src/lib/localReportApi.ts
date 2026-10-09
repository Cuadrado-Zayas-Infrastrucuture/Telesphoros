import { patientDtoSchema, reportCreateSchema, reportDtoSchema, reportUploadUrlResponseSchema } from '@telesphoros/shared-types';
import type { UploadReportValues } from '@/lib/uploadReportSchema';

export function localStorageOrigin(): string {
  const value = import.meta.env.VITE_LOCAL_REVIEW_S3_ORIGIN || 'http://127.0.0.1:5555';
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== value) throw new Error('Storage configuration must be a local emulator origin.');
  return value;
}

export class SubmitError extends Error {}
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export interface UploadProgress { file?: File; label?: string; type?: string; patientId?: string; reportId?: string }

/** Local experiment only. Retry identifiers stay in component memory. */
export async function submitReport(values: Omit<UploadReportValues, 'reportType'> & { reportType: 'structured' | 'vcf' | 'lab-pdf' }, apiFetch: ApiFetch, progress: UploadProgress): Promise<{ reference: string }> {
  if (!values.syntheticConfirmed) throw new SubmitError('Confirm synthetic data before uploading.');
  if (!import.meta.env.DEV || window.location.hostname !== '127.0.0.1') throw new SubmitError('This upload experiment is local only.');
  if (progress.file !== values.file || progress.label !== values.patientLabel || progress.type !== values.reportType) {
    for (const key of Object.keys(progress)) delete progress[key as keyof UploadProgress];
    Object.assign(progress, { file: values.file, label: values.patientLabel, type: values.reportType });
  }
  reportCreateSchema.parse({ patientId: '11111111-1111-4111-8111-111111111111', type: values.reportType, filename: values.file.name, sizeBytes: values.file.size });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await values.file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
  const contentType = values.reportType === 'structured' ? 'application/json' : values.reportType === 'lab-pdf' ? 'application/pdf' : 'text/x-vcf';
  async function post(path: string, body?: unknown) {
    const response = await apiFetch(`/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new SubmitError(response.status === 409 ? 'A record conflicts with this request. Use a new synthetic label for a new upload.' : `Upload step failed (${response.status}). Your entries are kept.`);
    return response.json();
  }
  if (!progress.patientId) progress.patientId = patientDtoSchema.parse(await post('/patients', { label: values.patientLabel })).id;
  if (!progress.reportId) progress.reportId = reportDtoSchema.parse(await post('/reports', { patientId: progress.patientId, type: values.reportType, filename: values.file.name, sizeBytes: values.file.size })).id;
  const current = await apiFetch(`/api/v1/reports/${progress.reportId}`);
  if (!current.ok) throw new SubmitError('Cannot verify the report. Your entries are kept.');
  const existing = reportDtoSchema.parse(await current.json());
  if (existing.fileUploaded) {
    if (existing.sha256 !== sha256 || existing.contentType !== contentType || existing.sizeBytes !== values.file.size) throw new SubmitError('The stored report does not match this file.');
    return { reference: existing.id };
  }
  const target = reportUploadUrlResponseSchema.parse(await post(`/reports/${progress.reportId}/upload-url`, { contentType, sha256 }));
  const url = new URL(target.uploadUrl);
  if (url.origin !== localStorageOrigin()) throw new SubmitError('Upload destination is not the local emulator.');
  if (Object.keys(target.headers).some(key => key.toLowerCase() !== 'content-type')) throw new SubmitError('Unexpected upload headers.');
  // Never attach the API bearer token to object storage.
  const uploaded = await fetch(url, { method: 'PUT', headers: target.headers, body: values.file, credentials: 'omit', redirect: 'error' });
  if (!uploaded.ok) throw new SubmitError('File transfer failed. Your entries are kept.');
  const completed = reportDtoSchema.parse(await post(`/reports/${progress.reportId}/complete`));
  if (!completed.fileUploaded || completed.sha256 !== sha256 || completed.contentType !== contentType || completed.sizeBytes !== values.file.size) throw new SubmitError('The server did not verify this file.');
  return { reference: completed.id };
}
