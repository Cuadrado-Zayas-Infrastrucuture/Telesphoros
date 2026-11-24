import { ErrorCode, evaluationSummaryDtoSchema, paginatedSchema } from '@telesphoros/shared-types';
import { SubmitError, type ApiFetch } from './api';
import { getPatient } from './patientDemographics';

/** How many held results the home lists; the rest are counted (spec 049 section 3). */
export const HELD_SHOWN = 5;

export interface HeldRow {
  evaluationId: string;
  patientId: string;
  /** The patient's synthetic label, or null when it could not be read (the row then shows the identifier, as the Reports list does). */
  label: string | null;
  /** The hold in its fixed words (`hold.message`, then what a reviewer does about it), never text from a report. */
  hold: string;
}

/** `off`: the evaluations route is switched off in this environment (WL-7), a state and not a failure. */
export type HeldResults = { state: 'off' } | { state: 'listed'; total: number; rows: HeldRow[] };

/**
 * The worklist's held results (spec 049 W1 and W2): the current evaluations that are held, across the patients this organization holds,
 * in the order the server lists them. `total` is the server's own count (WL-4).
 */
export async function readHeldResults(apiFetch: ApiFetch, signal: AbortSignal): Promise<HeldResults> {
  const response = await apiFetch(`/api/v1/evaluations?current=true&disposition=held&page=1&pageSize=${HELD_SHOWN}`, { signal });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    if (response.status === 503 && failure?.error?.code === ErrorCode.PIPELINE_DISABLED) return { state: 'off' };
    throw new SubmitError('Held results could not be loaded.', response.status);
  }
  const page = paginatedSchema(evaluationSummaryDtoSchema).parse(await response.json());
  // An answer that is not what was asked for is shown as a failure, never as a list.
  if (page.meta.page !== 1 || page.data.length > HELD_SHOWN || page.data.some((evaluation) => evaluation.disposition !== 'held' || !evaluation.current))
    throw new SubmitError('Held results could not be loaded.');
  const patients = [...new Set(page.data.map((evaluation) => evaluation.patientId))];
  const labels = new Map(await Promise.all(patients.map(async (id) => [id, await getPatient(apiFetch, id, signal).then((patient) => patient.label, () => null)] as const)));
  return {
    state: 'listed',
    total: page.meta.total,
    rows: page.data.map((evaluation) => ({
      evaluationId: evaluation.id,
      patientId: evaluation.patientId,
      label: labels.get(evaluation.patientId) ?? null,
      hold: evaluation.hold ? `${evaluation.hold.message} ${evaluation.hold.reviewerAction}` : 'On hold.',
    })),
  };
}
