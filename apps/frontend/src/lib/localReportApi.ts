import { patientDtoSchema, reportCreateSchema } from '@telesphoros/shared-types';
import { SubmitError, type ApiFetch } from './api';
import { submitOwnedReport } from './ownedStorageApi';
import type { OwnedProgress } from './uploadProgress';
import type { UploadReportValues } from '@/lib/uploadReportSchema';

export function localStorageOrigin(): string {
  const value = import.meta.env.VITE_LOCAL_REVIEW_S3_ORIGIN || 'http://127.0.0.1:5555';
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== value) throw new Error('Storage configuration must be a local emulator origin.');
  return value;
}

export { SubmitError } from './api';
export type { ApiFetch } from './api';
export type UploadProgress = OwnedProgress & { identity?: string; requestId?: string; reportId?: string };

/** What the experiment remembers about its synthetic patient, kept beside the retry state (the intake resets its own state when the file or patient changes). */
const experiment = new WeakMap<object, { file: File; label: string; type: string; patientId?: string }>();

/** Local experiment only. Retry identifiers stay in component memory. Registers a synthetic patient by label, then uploads through the validated intake. */
export async function submitReport(values: Omit<UploadReportValues, 'reportType'> & { reportType: 'structured' | 'vcf' | 'lab-pdf' }, apiFetch: ApiFetch, progress: UploadProgress): Promise<{ reference: string }> {
  if (!values.syntheticConfirmed) throw new SubmitError('Confirm synthetic data before uploading.');
  if (!import.meta.env.DEV || window.location.hostname !== '127.0.0.1') throw new SubmitError('This upload experiment is local only.');
  let known = experiment.get(progress);
  if (!known || known.file !== values.file || known.label !== values.patientLabel || known.type !== values.reportType) {
    for (const key of Object.keys(progress)) delete progress[key as keyof UploadProgress];
    known = { file: values.file, label: values.patientLabel, type: values.reportType };
    experiment.set(progress, known);
  }
  reportCreateSchema.parse({ patientId: '11111111-1111-4111-8111-111111111111', type: values.reportType, filename: values.file.name, sizeBytes: values.file.size });
  if (!known.patientId) {
    const response = await apiFetch('/api/v1/patients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: values.patientLabel }) });
    if (!response.ok) throw new SubmitError(response.status === 409 ? 'A record conflicts with this request. Use a new synthetic label for a new upload.' : `Upload step failed (${response.status}). Your entries are kept.`);
    known.patientId = patientDtoSchema.parse(await response.json()).id;
  }
  return submitOwnedReport({ patientId: known.patientId, reportType: values.reportType, file: values.file, syntheticConfirmed: values.syntheticConfirmed }, apiFetch, progress, undefined, { remember: false });
}
