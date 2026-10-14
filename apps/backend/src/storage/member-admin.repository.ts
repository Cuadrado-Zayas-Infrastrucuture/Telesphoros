import type { Role } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';

/** The rules member administration enforces, by stable name. The database function or the in-memory store raises exactly these. */
export type MemberRule =
  | 'member-self'
  | 'member-not-found'
  | 'last-administrator'
  | 'not-administrator'
  | 'tenant-inactive'
  | 'invitation-limit'
  | 'invitation-pending'
  | 'invitation-not-found';

export class MemberAdminRuleError extends Error {
  constructor(readonly rule: MemberRule) {
    super(rule);
  }
}

export interface MemberView {
  sub: string;
  roles: Role[];
  changedAt: Date;
}

export interface InvitationView {
  id: string;
  emailHint: string;
  roles: Role[];
  status: 'pending' | 'fulfilled' | 'cancelled' | 'expired';
  expiresAt: Date;
  createdAt: Date;
}

export interface PageRequest {
  offset: number;
  limit: number;
}

/**
 * Member administration as an organization administrator does it. The rules (own organization only, never oneself, never the last administrator,
 * administrator and organization both active) are enforced here, in the store, so no route can bypass them: PostgreSQL enforces them in
 * SECURITY DEFINER functions the application role may execute (it has no write privilege on the tables), the in-memory store enforces the same
 * rules in code. Every method that changes something takes the acting principal; none of them takes an organization argument.
 */
export abstract class MemberAdminRepository {
  abstract listMembers(tenantId: string, page: PageRequest): Promise<{ items: MemberView[]; total: number }>;
  abstract changeRoles(actor: Principal, sub: string, roles: Role[]): Promise<void>;
  abstract removeMember(actor: Principal, sub: string): Promise<void>;
  abstract createInvitation(actor: Principal, invitation: { digest: Buffer; hint: string; roles: Role[] }): Promise<InvitationView>;
  abstract listInvitations(tenantId: string, page: PageRequest): Promise<{ items: InvitationView[]; total: number }>;
  abstract cancelInvitation(actor: Principal, id: string): Promise<void>;
}
