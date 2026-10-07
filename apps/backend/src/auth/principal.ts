import type { Role } from '@telesphoros/shared-types';

/** The authenticated caller. `sub` is the owner id every record is scoped to. */
export interface Principal {
  sub: string;
  roles: Role[];
}
