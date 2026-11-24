import { genomicProfileDtoSchema, type GenomicProfileDto } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError } from '@/auth/AuthProvider';
import { SubmitError, type ApiFetch } from './api';

/** The profile, or the one answer that is not a failure: this environment does not serve it (503, both switches off). */
export type GenomicProfileRead = { kind: 'loaded'; profile: GenomicProfileDto } | { kind: 'unavailable' };

const FAILED = 'Could not read the genomic profile.';

/**
 * Spec 044 slice B: `GET /patients/:id/genomic-profile`, with `?rxcui=` for a drug checked before it is prescribed. Fixed errors only: no
 * value from the response reaches a message, a URL other than this one, or browser storage.
 */
export async function readGenomicProfile(apiFetch: ApiFetch, patient: string, rxcui?: string, signal?: AbortSignal): Promise<GenomicProfileRead> {
  try {
    const query = rxcui ? `?rxcui=${encodeURIComponent(rxcui)}` : '';
    const response = await apiFetch(`/api/v1/patients/${encodeURIComponent(patient)}/genomic-profile${query}`, { signal });
    if (response.status === 503) return { kind: 'unavailable' };
    if (!response.ok) throw new SubmitError(FAILED, response.status);
    const profile = genomicProfileDtoSchema.parse(await response.json());
    // A profile for another patient, or a check for another drug, is never shown as this one.
    if (profile.patientId.toLowerCase() !== patient.toLowerCase() || (rxcui !== undefined && profile.check?.rxcui !== rxcui)) throw new SubmitError(FAILED);
    return { kind: 'loaded', profile };
  } catch (error) {
    if (signal?.aborted || error instanceof SubmitError || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError(FAILED);
  }
}
