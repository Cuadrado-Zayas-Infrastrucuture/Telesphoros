import {
  ACK_REFUSAL_REASONS,
  type ResultAcknowledgementCreateInput,
  type ResultAcknowledgementDto,
  resultAcknowledgementDtoSchema,
  type ResultAcknowledgementsDto,
  resultAcknowledgementsDtoSchema,
} from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError } from '@/auth/AuthProvider';
// Type only, as in usage.ts: importing `./api` at run time would pull upload code into this chunk.
import type { ApiFetch } from './api';

/** Spec 019 D02a: the two acknowledgement routes, for ReviewedControl. Nothing here ever reports a review as saved without the server's 201 or 200. */

export class AcknowledgementsLoadError extends Error {}

/** The server answered and refused: what was asked does not hold any more (409), or the caller may not (403). Nothing was stored. */
export class AcknowledgementRefusedError extends Error {
  constructor(
    readonly kind: 'basis-changed' | 'already-acknowledged' | 'conflict' | 'forbidden' | 'not-found',
    message: string,
  ) {
    super(message);
  }
}

/** No answer, or one that breaks the contract: the review may or may not be stored, so the same request is retried as it was. */
export class AcknowledgementUnconfirmedError extends Error {}

const path = (resultId: string) => `/api/v1/evaluation-results/${encodeURIComponent(resultId)}/acknowledgements`;
const pass = (error: unknown, signal?: AbortSignal) => signal?.aborted || error instanceof SessionEndedError || error instanceof NotSignedInError;

export async function loadAcknowledgements(apiFetch: ApiFetch, resultId: string, signal?: AbortSignal): Promise<ResultAcknowledgementsDto> {
  try {
    const response = await apiFetch(path(resultId), { signal });
    if (!response.ok) throw new Error();
    const body = resultAcknowledgementsDtoSchema.parse(await response.json());
    if (body.resultId !== resultId) throw new Error(); // an answer about another result is not this result's
    return body;
  } catch (error) {
    if (pass(error, signal)) throw error;
    throw new AcknowledgementsLoadError('Review status could not be loaded.');
  }
}

async function reasonOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { details?: { reason?: unknown }[] } };
    const reason = body.error?.details?.[0]?.reason;
    return typeof reason === 'string' ? reason : undefined;
  } catch {
    return undefined;
  }
}

export async function submitAcknowledgement(apiFetch: ApiFetch, body: ResultAcknowledgementCreateInput, signal?: AbortSignal): Promise<ResultAcknowledgementDto> {
  let response: Response;
  try {
    response = await apiFetch(path(body.resultId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (error) {
    if (pass(error, signal)) throw error;
    throw new AcknowledgementUnconfirmedError('The review was not confirmed. Check your connection, then retry.');
  }
  if (response.status === 409) {
    const reason = await reasonOf(response);
    if (reason === ACK_REFUSAL_REASONS.basisChanged) {
      throw new AcknowledgementRefusedError('basis-changed', 'This result changed after it was shown. Refresh to review it as it is now.');
    }
    if (reason === ACK_REFUSAL_REASONS.alreadyAcknowledged) throw new AcknowledgementRefusedError('already-acknowledged', 'You already recorded this review.');
    throw new AcknowledgementRefusedError('conflict', 'The review was not recorded. Refresh, then try again.');
  }
  if (response.status === 403) throw new AcknowledgementRefusedError('forbidden', 'Your role cannot record reviews.');
  if (response.status === 404) throw new AcknowledgementRefusedError('not-found', 'This result is no longer available.');
  // Any other refusal by the server (a 400, say) stored nothing either; a timeout, a rate limit or a server error may be retried as it was.
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    throw new AcknowledgementRefusedError('conflict', 'The review was not recorded. Refresh, then try again.');
  }
  if (response.status !== 201 && response.status !== 200) throw new AcknowledgementUnconfirmedError('The review was not confirmed. Retry to try again.');
  try {
    const stored = resultAcknowledgementDtoSchema.parse(await response.json());
    if (stored.resultId !== body.resultId || stored.kind !== body.kind) throw new Error();
    return stored;
  } catch (error) {
    if (pass(error, signal)) throw error;
    throw new AcknowledgementUnconfirmedError('The review was not confirmed. Retry to try again.');
  }
}
