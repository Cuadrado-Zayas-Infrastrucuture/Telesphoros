import { meProfileDtoSchema } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError } from '@/auth/AuthProvider';
// Type only: importing `./api` at run time pulls the upload and storage modules into the entry chunk (+29 kB gzip, over its budget).
import type { ApiFetch } from './api';

export type OrganizationProfile = { state: 'ready'; name: string } | { state: 'unavailable' };

export class OrganizationLoadError extends Error {}

/** The caller's own organization (`GET /me/profile`). An older backend answers 404: that is "not available here", not a failure. */
export async function loadOrganization(apiFetch: ApiFetch, signal?: AbortSignal): Promise<OrganizationProfile> {
  try {
    const response = await apiFetch('/api/v1/me/profile', { signal });
    if (response.status === 404) return { state: 'unavailable' };
    if (!response.ok) throw new Error();
    return { state: 'ready', name: meProfileDtoSchema.parse(await response.json()).organization.name };
  } catch (error) {
    if (signal?.aborted || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new OrganizationLoadError('The organization could not be loaded. Please retry.');
  }
}
