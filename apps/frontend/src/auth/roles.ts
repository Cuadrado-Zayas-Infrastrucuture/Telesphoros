import type { Role } from '@telesphoros/shared-types';

/** Roles that may create and change data. `admin` is administration only and is deliberately absent. */
export const WRITER_ROLES: readonly Role[] = ['clinician'];

/** Roles that may read clinical records (the same set the API enforces). `admin` is deliberately absent. */
export const CLINICAL_READ_ROLES: readonly Role[] = ['reader', 'clinician', 'reviewer'];

const ORDER: Role[] = ['admin', 'reviewer', 'clinician', 'reader'];

/** The most capable role, for DISPLAY ONLY. Permission checks use the whole set (`hasAnyRole`), never this. */
export function primaryRole(roles: readonly Role[]): Role | undefined {
  return ORDER.find((role) => roles.includes(role));
}
