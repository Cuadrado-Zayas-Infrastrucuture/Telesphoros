import {
  clinicianDecisionCreateSchema,
  clinicianDecisionDtoSchema,
  clinicianDecisionHistoryDtoSchema,
  evaluationSummaryDtoSchema,
  noteDtoSchema,
  paginatedSchema,
  type ClinicianDecisionCreate,
  type ClinicianDecisionHistoryDto,
  type CdrResponse,
} from '@telesphoros/shared-types';
import { SubmitError, type ApiFetch } from './api';

export const decisionLabels: Record<CdrResponse, string> = {
  accepted: 'Accepted',
  modified: 'Modified',
  rejected: 'Rejected',
  deferred: 'Deferred',
  'clarification-requested': 'Clarification requested',
};
export type DecisionLink = { id: string; label: string };
const path = (result: string) => `/api/v1/evaluation-results/${encodeURIComponent(result)}/clinician-decisions`;
export async function readPatientResults(apiFetch: ApiFetch, patient: string, page: number, signal: AbortSignal) {
  const response = await apiFetch(`/api/v1/evaluations?patientId=${encodeURIComponent(patient)}&page=${page}&pageSize=10`, { signal });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    throw new SubmitError(
      response.status === 503 && failure?.error?.code === 'PIPELINE_DISABLED'
        ? 'Stored results are unavailable while report processing is disabled.'
        : 'Stored results could not be loaded. Please retry.',
      response.status,
    );
  }
  const result = paginatedSchema(evaluationSummaryDtoSchema).parse(await response.json());
  if (result.meta.page !== page || result.meta.pageSize !== 10 || result.data.some((item) => item.patientId !== patient))
    throw new SubmitError('The stored results did not match this patient.');
  return result;
}
export async function readDecisionHistory(apiFetch: ApiFetch, result: string, evaluation: string, patient: string, signal: AbortSignal) {
  const response = await apiFetch(path(result), { signal });
  if (!response.ok) throw new SubmitError('Decision history could not be loaded. Please retry.', response.status);
  const history = clinicianDecisionHistoryDtoSchema.parse(await response.json());
  if (
    history.resultId !== result ||
    history.evaluationId !== evaluation ||
    history.patientId !== patient ||
    history.entries.some((entry) => entry.resultId !== result || entry.evaluationId !== evaluation || entry.patientId !== patient)
  )
    throw new SubmitError('Decision history did not match the selected result.');
  return history;
}
export async function readDecisionNote(apiFetch: ApiFetch, note: { id: string; bodySha256: string }, signal: AbortSignal) {
  const response = await apiFetch(`/api/v1/notes/${encodeURIComponent(note.id)}`, { signal });
  if (!response.ok) throw new SubmitError('Decision note could not be loaded.');
  const value = noteDtoSchema.parse(await response.json());
  if (value.id !== note.id || value.bodySha256 !== note.bodySha256) throw new SubmitError('Decision note did not match the record.');
  return value;
}
export class DecisionUnconfirmed extends Error {}
export async function saveDecision(apiFetch: ApiFetch, result: string, input: ClinicianDecisionCreate) {
  const checked = clinicianDecisionCreateSchema.safeParse(input);
  if (!checked.success) throw new SubmitError(checked.error.issues[0]?.message ?? 'Check the decision fields.');
  let response: Response;
  try {
    response = await apiFetch(path(result), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checked.data) });
  } catch {
    throw new DecisionUnconfirmed('Save was not confirmed. Your exact entry is kept for retry.');
  }
  if (response.status === 409) throw new SubmitError('The result or decision history changed. Your draft is kept. Cancel and reload before recording another decision.', 409);
  if (response.status === 403) throw new SubmitError('Your current role or authorship does not allow this entry. Your draft is kept.', 403);
  if (response.status === 400 || response.status === 404)
    throw new SubmitError('This entry was refused. Check the result and decision fields. Your draft is kept.', response.status);
  if (response.status !== 200 && response.status !== 201) throw new DecisionUnconfirmed('Save was not confirmed. Your exact entry is kept for retry.');
  try {
    const stored = clinicianDecisionDtoSchema.parse(await response.json());
    if (
      stored.resultId !== result ||
      stored.patientId !== input.patientId ||
      stored.evaluationId !== input.evaluationId ||
      stored.entryKind !== input.entryKind ||
      stored.previousEntryId !== input.previousEntryId ||
      stored.response !== input.response
    )
      throw new Error();
    return stored;
  } catch {
    throw new DecisionUnconfirmed('Save was not confirmed. Your exact entry is kept for retry.');
  }
}
/** Latest surviving documentation, including an amendment; the server's currentDecisionId is the original decision reference. */
export function currentDecisionEntry(history: ClinicianDecisionHistoryDto) {
  const entries = new Map(history.entries.map((entry) => [entry.id, entry]));
  let head = history.headEntryId ? entries.get(history.headEntryId) : undefined;
  const visited = new Set<string>();
  while (head && !visited.has(head.id)) {
    visited.add(head.id);
    if (head.entryKind !== 'entered-in-error') return head;
    const removed = head.previousEntryId ? entries.get(head.previousEntryId) : undefined;
    head = removed?.previousEntryId ? entries.get(removed.previousEntryId) : undefined;
  }
  return null;
}
