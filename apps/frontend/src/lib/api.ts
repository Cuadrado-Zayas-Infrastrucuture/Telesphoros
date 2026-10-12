import {
  paginatedSchema, patientDtoSchema, reportCreateSchema, reportDtoSchema,
  reportUploadUrlResponseSchema, type ReportDto,
} from '@telesphoros/shared-types';
import { SessionEndedError, NotSignedInError } from '@/auth/AuthProvider';
import { productUploadSchema, type ProductUploadValues } from './productUploadSchema';

import { ownedStorageMode } from './storageMode';
import { submitOwnedReport } from './ownedStorageApi';
import type { OwnedProgress } from './ownedStorageApi';

export class SubmitError extends Error {}
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export interface UploadProgress extends OwnedProgress { identity?: string; requestId?: string; reportId?: string }

/** Explicit configuration; never derive a trusted origin from an API upload response. */
export function reportStorageOrigins(): string[] {
  const setting = import.meta.env.VITE_REPORT_STORAGE_ORIGINS;
  if (typeof setting !== 'string' || !setting.trim()) throw new SubmitError('File storage is not configured. Contact the administrator.');
  const origins = setting.split(',').map(value => value.trim());
  try {
    for (const value of origins) {
      const url = new URL(value);
      const local = import.meta.env.MODE !== 'production' && window.location.hostname === '127.0.0.1'
        && url.protocol === 'http:' && url.hostname === '127.0.0.1';
      if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !local)) throw new Error();
    }
  } catch { throw new SubmitError('File storage configuration is invalid. Contact the administrator.'); }
  return origins;
}

function refusal(status: number): SubmitError {
  if (status === 409) return new SubmitError('This upload conflicts with a stored report. Check the selected patient and file before starting a new upload.');
  if (status === 403) return new SubmitError('You do not have permission to upload this report.');
  if (status === 404) return new SubmitError('The selected patient or report is no longer available.');
  if (status === 429) return new SubmitError('Too many requests. Wait a moment, then retry; your entries are kept.');
  return new SubmitError('The upload could not be verified. Your entries are kept; please retry.');
}

export async function listPatients(apiFetch: ApiFetch, page: number, signal?: AbortSignal) {
  try {
    const response = await apiFetch(`/api/v1/patients?page=${page}&pageSize=20`, { signal });
    if (!response.ok) throw refusal(response.status);
    const result = paginatedSchema(patientDtoSchema).parse(await response.json());
    if (result.meta.page !== page || result.meta.pageSize !== 20 || result.data.length > 20) throw new Error();
    return result;
  } catch (error) {
    if (signal?.aborted || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('Patients could not be loaded. Please retry.');
  }
}

/** Retry state lives in the mounted form only, never browser storage or a URL. */
export async function submitReport(values: ProductUploadValues, apiFetch: ApiFetch, progress: UploadProgress, signal?: AbortSignal): Promise<{ reference: string }> {
  try {
    productUploadSchema.parse(values);
    if (ownedStorageMode()) return await submitOwnedReport(values, apiFetch, progress, signal);
    const origins = reportStorageOrigins();
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await values.file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    const contentType = values.reportType === 'structured' ? 'application/json' : 'text/x-vcf';
    const identity = JSON.stringify([values.patientId.toLowerCase(), values.reportType, values.file.name, values.file.size, sha256]);
    if (progress.identity !== identity || !progress.requestId) {
      progress.identity = identity;
      progress.requestId = crypto.randomUUID();
      delete progress.reportId;
    }
    async function request(path: string, body?: unknown) {
      const response = await apiFetch(`/api/v1${path}`, body === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw refusal(response.status);
      return response.json();
    }
    function report(body: unknown): ReportDto {
      const result = reportDtoSchema.parse(body);
      if (result.patientId.toLowerCase() !== values.patientId.toLowerCase() || result.type !== values.reportType
        || result.filename !== values.file.name || result.sizeBytes !== values.file.size
        || (progress.reportId && result.id !== progress.reportId)) {
        throw new SubmitError('The stored report does not match this upload. Check the patient and file.');
      }
      return result;
    }
    function verified(result: ReportDto) {
      if (!result.fileUploaded || result.sha256 !== sha256 || result.contentType !== contentType) {
        throw new SubmitError('The server did not verify this file. Your entries are kept; please retry.');
      }
      return { reference: result.id };
    }
    const existing = progress.reportId
      ? report(await request(`/reports/${progress.reportId}`))
      : report(await request('/reports', reportCreateSchema.parse({ patientId: values.patientId, type: values.reportType,
        filename: values.file.name, sizeBytes: values.file.size, requestId: progress.requestId })));
    progress.reportId = existing.id;
    if (existing.fileUploaded) return verified(existing);
    const target = reportUploadUrlResponseSchema.parse(await request(`/reports/${existing.id}/upload-url`, { contentType, sha256 }));
    const url = new URL(target.uploadUrl);
    const headers = Object.entries(target.headers);
    if (!origins.includes(url.origin) || url.username || url.password || url.hash || Date.parse(target.expiresAt) <= Date.now()
      || headers.length !== 1 || headers[0]![0].toLowerCase() !== 'content-type' || headers[0]![1] !== contentType) {
      throw new SubmitError('The upload destination could not be verified. No file was sent.');
    }
    const uploaded = await fetch(url, { method: 'PUT', headers: target.headers, body: values.file,
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!uploaded.ok) throw new SubmitError('File transfer failed. Your entries are kept; please retry.');
    // Supplying an empty object selects POST; completion has no input fields.
    return verified(report(await request(`/reports/${existing.id}/complete`, {})));
  } catch (error) {
    if (error instanceof SubmitError || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    // Never display raw transport errors, validation payloads, signed URLs or service responses.
    throw new SubmitError('The upload was interrupted. Your entries are kept; please retry.');
  }
}
