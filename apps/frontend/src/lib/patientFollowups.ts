import { followupResponseSummarySchema, followupAssigneesSchema, followupDtoSchema, followupInputSchema, followupListSchema, type FollowupInput } from '@telesphoros/shared-types';
import { SubmitError, type ApiFetch } from './api';
import { SessionEndedError, NotSignedInError } from '@/auth/AuthProvider';
import type { FollowupInboxFilters } from '@telesphoros/shared-types';
export async function readFollowups(apiFetch: ApiFetch, patient?: string, page = 1, thread?: string, signal?: AbortSignal, filters?: FollowupInboxFilters) {
  const path = patient ? `/api/v1/patients/${encodeURIComponent(patient)}/followups` : '/api/v1/followups';
  const selection = !patient && filters ? `&assignment=${encodeURIComponent(filters.assignment)}&status=${encodeURIComponent(filters.status)}` : '';
  const response = await apiFetch(`${path}?page=${page}${thread ? `&threadId=${encodeURIComponent(thread)}` : ''}${selection}`, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SubmitError('Follow-ups could not be loaded. Please retry.', response.status);
  }
  return followupListSchema.parse(await response.json());
}
export async function readFollowupAssignees(apiFetch: ApiFetch, signal?: AbortSignal) {
  const response = await apiFetch('/api/v1/followups/assignees', { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SubmitError('Responsible clinicians could not be loaded. Please retry.', response.status);
  }
  return followupAssigneesSchema.parse(await response.json());
}
export async function recordFollowup(apiFetch: ApiFetch, patient: string, input: FollowupInput) {
  const checked = followupInputSchema.safeParse(input);
  if (!checked.success) throw new SubmitError(checked.error.issues[0]?.message ?? 'Check the follow-up fields.');
  try {
    const response = await apiFetch(`/api/v1/patients/${encodeURIComponent(patient)}/followups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checked.data),
    });
    if (response.ok) return followupDtoSchema.parse(await response.json());
    await response.body?.cancel();
    if (response.status === 409) throw new SubmitError('This follow-up changed. Your draft is kept. Cancel and reload before saving against the current record.', 409);
    if (response.status === 403) throw new SubmitError('Your role cannot record this follow-up.', 403);
    if (response.status === 400) throw new SubmitError('Check the assessment date, medication and responsible clinician. Your draft is kept.', 400);
    if (response.status === 503) throw new SubmitError('Follow-up recording is unavailable. Your draft is kept; retry later.', 503);
    throw new SubmitError('The follow-up could not be saved. Your draft is kept; please retry.', response.status);
  } catch (error) {
    if (error instanceof SubmitError || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new SubmitError('The follow-up could not be saved. Your draft is kept; check your connection and retry.');
  }
}
const changed = new EventTarget();
export function announceFollowupsChanged() {
  changed.dispatchEvent(new Event('changed'));
}
export function onFollowupsChanged(listener: () => void) {
  changed.addEventListener('changed', listener);
  return () => changed.removeEventListener('changed', listener);
}

export async function readFollowupResponseSummary(apiFetch: ApiFetch, signal?: AbortSignal) {
  const response = await apiFetch('/api/v1/followups/summary', { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SubmitError('Response summary could not be loaded.', response.status);
  }
  return followupResponseSummarySchema.parse(await response.json());
}
