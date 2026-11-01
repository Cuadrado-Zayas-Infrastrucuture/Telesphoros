import { patientMedicationDtoSchema, patientMedicationInputSchema, patientMedicationsDtoSchema, type PatientMedicationInput } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError } from '@/auth/AuthProvider';
import { SubmitError, type ApiFetch } from './api';

/** Fixed errors only: medication values never reach diagnostics, URLs or persistent browser storage. */
export async function readMedications(apiFetch: ApiFetch, patient: string, signal?: AbortSignal, entry?: string, version?: number) {
  try {
    const query = entry ? `?entryId=${encodeURIComponent(entry)}${version === undefined ? '' : `&version=${version}`}` : '';
    const response = await apiFetch(`/api/v1/patients/${encodeURIComponent(patient)}/medications${query}`, { signal });
    if (!response.ok) throw new SubmitError('Medications could not be loaded. Please retry.', response.status);
    return patientMedicationsDtoSchema.parse(await response.json()).items;
  } catch (error) {
    if (signal?.aborted || error instanceof SubmitError || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('Medications could not be loaded. Please retry.');
  }
}

export async function recordMedication(apiFetch: ApiFetch, patient: string, input: PatientMedicationInput) {
  // Validation exceptions are also replaced with fixed text, never field values.
  const checked = patientMedicationInputSchema.safeParse(input);
  if (!checked.success) throw new SubmitError('Check the drug, status, source and month fields.');
  try {
    const response = await apiFetch(`/api/v1/patients/${encodeURIComponent(patient)}/medications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checked.data),
    });
    if (response.ok) return patientMedicationDtoSchema.parse(await response.json());
    if (response.status === 409) {
      let reason: unknown;
      try {
        reason = (await response.json())?.error?.details?.[0]?.reason;
      } catch {
        /* fixed fallback below */
      }
      if (reason === 'drug-list-changed') throw new SubmitError('The drug list changed. Reload this page before saving.', 409);
      throw new SubmitError('This entry changed or this save was already used. Cancel and reload medications before correcting it.', 409);
    }
    if (response.status === 403) throw new SubmitError('Your role cannot record medications.', 403);
    if (response.status === 400 || response.status === 422) throw new SubmitError('Check the drug, status, source and month fields.', response.status);
    throw new SubmitError('The medication could not be saved. Your entries are kept; please retry.', response.status);
  } catch (error) {
    if (error instanceof SubmitError || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('The medication could not be saved. Check your connection, then retry.');
  }
}
