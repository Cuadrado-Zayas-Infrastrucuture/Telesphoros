import {
  DEMOGRAPHICS_REFUSAL_REASONS,
  demographicsCompletenessSchema,
  patientDemographicsDtoSchema,
  patientDemographicsInputSchema,
  patientDtoSchema,
  type DemographicsCompleteness,
  type PatientDemographicsDto,
  type PatientDemographicsInput,
  type PatientDto,
} from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError } from '@/auth/AuthProvider';
import { SubmitError, type ApiFetch } from './api';

/**
 * Spec 025 PD-c: the browser side of a patient's demographics. Every message here is fixed text: an identity value (a name, a date of birth) never reaches
 * an error, a log line, a URL or the page title (D7). The values travel only in the request body and the response the page shows.
 */

/** What reading a patient's demographics can come back as. `none` and `erased` are answers, not failures. */
export type DemographicsRead = { kind: 'found'; value: PatientDemographicsDto } | { kind: 'none' } | { kind: 'erased' };

async function reasonOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const details = (body as { error?: { details?: { reason?: unknown }[] } })?.error?.details;
    const reason = Array.isArray(details) ? details[0]?.reason : undefined;
    return typeof reason === 'string' ? reason : undefined;
  } catch {
    return undefined;
  }
}

function passThrough(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || error instanceof SubmitError || error instanceof SessionEndedError || error instanceof NotSignedInError;
}

/** One patient's label and dates (`GET /patients/:id`). A single patient's response carries no demographics; the demographics route does. */
export async function getPatient(apiFetch: ApiFetch, id: string, signal?: AbortSignal): Promise<PatientDto> {
  try {
    const response = await apiFetch(`/api/v1/patients/${encodeURIComponent(id)}`, { signal });
    if (response.status === 404) throw new SubmitError('This patient is not available.', 404);
    if (response.status === 403) throw new SubmitError('Your role cannot see this patient.', 403);
    if (!response.ok) throw new SubmitError('The patient could not be loaded. Please retry.', response.status);
    return patientDtoSchema.parse(await response.json());
  } catch (error) {
    if (passThrough(error, signal)) throw error;
    throw new SubmitError('The patient could not be loaded. Please retry.');
  }
}

/** The current demographics, or version `version`. 404 `no-demographics` is `none`; 410 `identity-erased` is `erased`. */
export async function getDemographics(apiFetch: ApiFetch, id: string, version?: number, signal?: AbortSignal): Promise<DemographicsRead> {
  try {
    const query = version === undefined ? '' : `?version=${version}`;
    const response = await apiFetch(`/api/v1/patients/${encodeURIComponent(id)}/demographics${query}`, { signal });
    if (response.ok) return { kind: 'found', value: patientDemographicsDtoSchema.parse(await response.json()) };
    const reason = await reasonOf(response);
    if (response.status === 410 && reason === DEMOGRAPHICS_REFUSAL_REASONS.identityErased) return { kind: 'erased' };
    // The API gives a missing VERSION the same reason as no demographics at all, so a 404 for a requested version always means that version.
    if (response.status === 404 && version !== undefined) throw new SubmitError('That version does not exist.', 404);
    if (response.status === 404 && reason === DEMOGRAPHICS_REFUSAL_REASONS.noDemographics) return { kind: 'none' };
    if (response.status === 404) throw new SubmitError('This patient is not available.', 404);
    if (response.status === 403) throw new SubmitError('Your role cannot read demographics.', 403);
    throw new SubmitError('The demographics could not be loaded. Please retry.', response.status);
  } catch (error) {
    if (passThrough(error, signal)) throw error;
    throw new SubmitError('The demographics could not be loaded. Please retry.');
  }
}

/**
 * Records a new version: the first, or a correction (a correction adds a version and never overwrites). The same `requestId` with the same fields replays
 * the version the first request made, so a retry after a lost response never adds a second one.
 */
export async function recordDemographics(
  apiFetch: ApiFetch,
  id: string,
  input: PatientDemographicsInput,
  requestId: string,
  signal?: AbortSignal,
): Promise<PatientDemographicsDto> {
  const body = patientDemographicsInputSchema.parse({ ...input, requestId });
  try {
    const response = await apiFetch(`/api/v1/patients/${encodeURIComponent(id)}/demographics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok) return patientDemographicsDtoSchema.parse(await response.json());
    const reason = await reasonOf(response);
    if (response.status === 410) throw new SubmitError("This patient's identity was erased. No new version can be recorded.", 410);
    if (response.status === 409 && reason === DEMOGRAPHICS_REFUSAL_REASONS.requestIdReused) throw new SubmitError('This save was already used for other values. Save again.', 409);
    if (response.status === 403) throw new SubmitError('Your role cannot record demographics.', 403);
    if (response.status === 400 || response.status === 422) throw new SubmitError('Those demographics were not accepted. Check each field.', response.status);
    if (response.status === 429) throw new SubmitError('Too many requests. Wait a moment, then retry.', 429);
    if (response.status === 503) throw new SubmitError('Demographics cannot be saved right now. Your entries are kept; retry in a moment.', 503);
    throw new SubmitError('The demographics could not be saved. Your entries are kept; please retry.', response.status);
  } catch (error) {
    if (passThrough(error, signal)) throw error;
    throw new SubmitError('The demographics could not be saved. Check your connection, then retry.');
  }
}

/** How many of the organization's patients have complete demographics, with the denominator (spec 025 T304). Counts only; the panel shows a line, never a name. */
export async function getCompleteness(apiFetch: ApiFetch, signal?: AbortSignal): Promise<DemographicsCompleteness> {
  try {
    const response = await apiFetch('/api/v1/patients/demographics-completeness', { signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined); // an unread error body would leave the request open in the browser
      throw new Error();
    }
    return demographicsCompletenessSchema.parse(await response.json());
  } catch (error) {
    if (passThrough(error, signal)) throw error;
    throw new SubmitError('The demographics counts could not be loaded.');
  }
}
