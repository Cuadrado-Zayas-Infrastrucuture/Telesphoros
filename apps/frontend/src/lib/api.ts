import { paginatedSchema, patientCreateSchema, patientDtoSchema } from '@telesphoros/shared-types';
import { SessionEndedError, NotSignedInError } from '@/auth/AuthProvider';
import { productUploadSchema, type ProductUploadValues } from './productUploadSchema';

import { submitOwnedReport } from './ownedStorageApi';
import type { OwnedProgress } from './uploadProgress';
import type { RecoverySession } from './uploadRecovery';

export class SubmitError extends Error {
  /** The HTTP status that caused it, when one did (the recovery of a reloaded upload tells a missing report from other failures). */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export interface UploadProgress extends OwnedProgress {
  identity?: string;
  requestId?: string;
  reportId?: string;
}

/** Explicit configuration of the object-storage origins a signed DOWNLOAD link may point at (uploads no longer touch storage from the browser); never derive a trusted origin from an API response. */
export function reportStorageOrigins(): string[] {
  const setting = import.meta.env.VITE_REPORT_STORAGE_ORIGINS;
  if (typeof setting !== 'string' || !setting.trim()) throw new SubmitError('File storage is not configured. Contact the administrator.');
  const origins = setting.split(',').map((value) => value.trim());
  try {
    for (const value of origins) {
      const url = new URL(value);
      const local = import.meta.env.MODE !== 'production' && window.location.hostname === '127.0.0.1' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
      if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !local)) throw new Error();
    }
  } catch {
    throw new SubmitError('File storage configuration is invalid. Contact the administrator.');
  }
  return origins;
}

export function refusal(status: number): SubmitError {
  if (status === 409) return new SubmitError('This upload conflicts with a stored report. Check the selected patient and file before starting a new upload.', status);
  if (status === 403) return new SubmitError('You do not have permission to upload this report.', status);
  if (status === 404) return new SubmitError('The selected patient or report is no longer available.', status);
  if (status === 429) return new SubmitError('Too many requests. Wait a moment, then retry; your entries are kept.', status);
  return new SubmitError('The upload could not be verified. Your entries are kept; please retry.', status);
}

/** `order: 'newest'` asks for newest first (the panel); the default, and every other caller, keeps the API's oldest-first order. */
export async function listPatients(apiFetch: ApiFetch, page: number, signal?: AbortSignal, order?: 'newest') {
  try {
    const response = await apiFetch(`/api/v1/patients?page=${page}&pageSize=20${order === 'newest' ? '&order=desc' : ''}`, { signal });
    if (!response.ok) throw refusal(response.status);
    const result = paginatedSchema(patientDtoSchema).parse(await response.json());
    if (result.meta.page !== page || result.meta.pageSize !== 20 || result.data.length > 20) throw new Error();
    return result;
  } catch (error) {
    if (signal?.aborted || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('Patients could not be loaded. Please retry.');
  }
}

function patientRefusal(status: number): SubmitError {
  if (status === 409) return new SubmitError('A patient with that label already exists. Choose it from the list, or use a different label.', status);
  if (status === 403) return new SubmitError('Your role cannot add patients.', status);
  if (status === 400 || status === 422) return new SubmitError('That label was not accepted. Use letters, numbers and hyphens only.', status);
  if (status === 429) return new SubmitError('Too many requests. Wait a moment, then retry.', status);
  return new SubmitError('The patient could not be added. Please retry.', status);
}

/**
 * Adds a synthetic patient, identified by its label alone (no name or date of birth exists in this model). The same requestId with the same label replays
 * the patient the first request created, so a retry after a lost response never makes a second one; use a new requestId for a different label.
 */
export async function createPatient(apiFetch: ApiFetch, label: string, requestId: string, signal?: AbortSignal) {
  const body = patientCreateSchema.parse({ label, requestId });
  try {
    const response = await apiFetch('/api/v1/patients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw patientRefusal(response.status);
    return patientDtoSchema.parse(await response.json());
  } catch (error) {
    if (signal?.aborted || error instanceof SubmitError || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    // Never display raw transport errors or response payloads.
    throw new SubmitError('The patient could not be added. Check your connection, then retry.');
  }
}

/**
 * The one way a report file is uploaded (M2.2b): the validated server intake. Declare an attempt, send the bytes through the API, and the server checks
 * their structure, size and checksum before anything reaches storage. Scoped, time-bounded reload recovery holds no token or file bytes.
 */
export async function submitReport(
  values: ProductUploadValues,
  apiFetch: ApiFetch,
  progress: UploadProgress,
  signal?: AbortSignal,
  recoverySession?: RecoverySession,
): Promise<{ reference: string }> {
  try {
    productUploadSchema.parse(values);
    return await submitOwnedReport(values, apiFetch, progress, signal, { recoverySession });
  } catch (error) {
    if (error instanceof SubmitError || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    // Never display raw transport errors, validation payloads, signed URLs or service responses.
    throw new SubmitError('The upload was interrupted. Your entries are kept; please retry.');
  }
}
