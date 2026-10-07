import type { Role } from '@telesphoros/shared-types';

/** Roles that may create and change data. */
export const WRITER_ROLES: readonly Role[] = ['clinician', 'admin'];

const ORDER: Role[] = ['admin', 'clinician', 'reader'];

/** The most capable role, for display. */
export function primaryRole(roles: readonly Role[]): Role | undefined {
  return ORDER.find((role) => roles.includes(role));
}
