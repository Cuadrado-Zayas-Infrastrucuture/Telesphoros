import { accessReviewPageSchema, type AccessReviewPage } from '@telesphoros/shared-types';
import type { ApiFetch } from './api';

/** Spec 046: an admin's filter. Exactly one of a patient id or a member, or neither for every read; dates are whole days in the browser's zone. */
export interface AccessReviewFilter {
  patientId?: string;
  member?: string;
  fromDate: string;
  toDate: string;
}

export type AccessReviewResult = { kind: 'page'; page: AccessReviewPage } | { kind: 'forbidden' } | { kind: 'invalid' } | { kind: 'failed' };

/** The query string for a filter and page: the end date is inclusive, so the window runs to the start of the next day. */
export function accessReviewQuery(filter: AccessReviewFilter, page = 1): string {
  const params = new URLSearchParams();
  if (filter.patientId) params.set('patientId', filter.patientId);
  if (filter.member) params.set('member', filter.member);
  const from = new Date(`${filter.fromDate}T00:00:00`);
  const to = new Date(`${filter.toDate}T00:00:00`);
  to.setDate(to.getDate() + 1);
  params.set('from', from.toISOString());
  params.set('to', to.toISOString());
  if (page > 1) params.set('page', String(page));
  return params.toString();
}

export async function readAccessReview(apiFetch: ApiFetch, filter: AccessReviewFilter, page: number, signal?: AbortSignal): Promise<AccessReviewResult> {
  let res: Response;
  try {
    res = await apiFetch(`/api/v1/access-review?${accessReviewQuery(filter, page)}`, { signal });
  } catch {
    return { kind: 'failed' };
  }
  if (res.status === 403) return { kind: 'forbidden' };
  if (res.status === 400) return { kind: 'invalid' };
  if (!res.ok) return { kind: 'failed' };
  const parsed = accessReviewPageSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? { kind: 'page', page: parsed.data } : { kind: 'failed' };
}

/** The CSV export, as a blob for the browser to save; null when it could not be had. */
export async function exportAccessReview(apiFetch: ApiFetch, filter: AccessReviewFilter): Promise<Blob | null> {
  try {
    const res = await apiFetch(`/api/v1/access-review/export?${accessReviewQuery(filter)}`);
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}
