import type { Role } from '@telesphoros/shared-types';

/**
 * The authenticated caller.
 *  - `tenantId` is the organization every record is scoped to (what row-level security binds on).
 *  - `sub` is the individual: recorded as the actor on what they create, never used for scoping.
 */
export interface Principal {
  sub: string;
  tenantId: string;
  roles: Role[];
}
