import { ROLES, type Role } from '@telesphoros/shared-types';

/**
 * A person's standing in one organization, as the database records it. This (not the token) is the authority for what the person may do:
 * the identity provider proves who they are, this says whether they still belong and with which roles.
 */
export interface MembershipRecord {
  tenantId: string;
  sub: string;
  status: 'active' | 'removed';
  roles: Role[];
  /** Whole seconds since the epoch. A token issued at or before this instant is refused. 0 when no token was ever revoked. */
  tokensValidAfter: number;
  /** Increases on every change. A write is admitted under one version and refused at commit if the row has moved. */
  version: number;
}

export interface MembershipChange {
  tenantId: string;
  sub: string;
  /** Who made the change (an operator name). Recorded on the row; the append-only trail is the security-event store (M1.6). */
  by: string;
  reason?: string;
  /** Tests only: the revocation instant to record instead of "now" (so a token issued "before" and "after" can be minted without sleeping). */
  revokedAt?: Date;
}

export interface MembershipGrant extends MembershipChange {
  roles: Role[];
}

export type MembershipFailure = 'already-active' | 'not-active' | 'in-another-organization' | 'invalid';

/** The change was refused. The message is safe to print on the operator's terminal. */
export class MembershipAdminError extends Error {
  constructor(
    readonly failure: MembershipFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Everything the operator command may do. There is deliberately no HTTP route that does any of it: an API that could grant roles or
 * add people would be a privilege-escalation path. Implemented over PostgreSQL (the operator command, tests) and in memory (tier 1).
 */
export interface MembershipAdmin {
  /** Adds a person to an organization, or reinstates a removed one (their old tokens stay refused). */
  grant(input: MembershipGrant): Promise<MembershipRecord>;
  /** Replaces the roles of an active member. Takes effect on their very next request. */
  setRoles(input: MembershipGrant): Promise<MembershipRecord>;
  /** Removes an active member and refuses every token issued up to now. The row is kept. */
  remove(input: MembershipChange): Promise<MembershipRecord>;
  /** Refuses every token issued up to now without changing roles (the person signs in again). */
  revokeSessions(input: MembershipChange): Promise<MembershipRecord>;
  show(tenantId: string, sub: string): Promise<MembershipRecord | undefined>;
}

const KNOWN_ROLES: readonly string[] = ROLES;

/** Validates and de-duplicates a role list; throws MembershipAdminError('invalid') for anything the table would refuse. */
export function normalizeRoles(roles: readonly string[]): Role[] {
  const unique = [...new Set(roles)];
  const unknown = unique.filter((role) => !KNOWN_ROLES.includes(role));
  if (unknown.length > 0) throw new MembershipAdminError('invalid', `Unknown role: ${unknown.join(', ')}. Known roles: ${KNOWN_ROLES.join(', ')}.`);
  return unique as Role[];
}

const MAX_TEXT = 128;
export function checkChange(input: MembershipChange): void {
  const bad = (field: string) => new MembershipAdminError('invalid', `${field} must be 1 to ${MAX_TEXT} characters without control characters.`);
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  const control = /[\u0000-\u001f\u007f]/;
  for (const [field, value] of [['tenant', input.tenantId], ['sub', input.sub], ['by', input.by]] as const) {
    if (!value || value.length > MAX_TEXT || control.test(value)) throw bad(field);
  }
  if ((input.reason ?? '').length > 500) throw new MembershipAdminError('invalid', 'reason must be at most 500 characters.');
}
