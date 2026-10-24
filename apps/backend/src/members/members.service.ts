import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  buildMeta,
  type InvitationCreate,
  type InvitationDto,
  type MemberDto,
  type MemberRolesInput,
  type Paginated,
  type PaginationQuery,
} from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import { type InvitationView, MemberAdminRepository, MemberAdminRuleError, type MemberView } from '../storage/member-admin.repository';
import { InvitationDigest } from './invitation-digest';

const toMember = (m: MemberView): MemberDto => ({ sub: m.sub, roles: m.roles, changedAt: m.changedAt.toISOString() });
const toInvitation = (i: InvitationView): InvitationDto => ({ id: i.id, emailHint: i.emailHint, roles: i.roles, status: i.status, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() });

/** A rule the store raised, as the answer the caller gets. The store never says which part of an organization's membership it looked at. */
function refusal(error: unknown): never {
  if (!(error instanceof MemberAdminRuleError)) throw error;
  switch (error.rule) {
    case 'member-self':
      throw AppException.conflictBecause('member-self', 'You cannot change or remove yourself. Another administrator must do it.');
    case 'last-administrator':
      throw AppException.conflictBecause('last-administrator', 'The organization must keep at least one administrator.');
    case 'invitation-limit':
      throw AppException.conflictBecause('invitation-limit', 'Too many invitations are pending. Cancel some or wait for them to expire.');
    case 'request-id-reused':
      throw AppException.conflictBecause('request-id-reused', 'That request id was already used for a different invitation.');
    case 'invitation-pending':
      throw AppException.conflictBecause('invitation-pending', 'That person already has a pending invitation.');
    case 'member-not-found':
    case 'invitation-not-found':
      throw AppException.notFound();
    case 'not-administrator':
    case 'tenant-inactive':
      throw AppException.forbidden();
  }
}

/**
 * What an organization administrator may do about the people of their own organization. The routes are `@Roles('admin')`; the rules that matter
 * (own organization, never oneself, never the last administrator) live in the store and cannot be bypassed from here.
 */
@Injectable()
export class MembersService {
  private readonly digest: InvitationDigest;

  constructor(
    private readonly members: MemberAdminRepository,
    @Inject(ENV) env: Env,
  ) {
    this.digest = new InvitationDigest(env.INVITATION_DIGEST_KEY);
  }

  async list(principal: Principal, { page, pageSize }: PaginationQuery): Promise<Paginated<MemberDto>> {
    const { items, total } = await this.members.listMembers(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize });
    return { data: items.map(toMember), meta: buildMeta(page, pageSize, total) };
  }

  async changeRoles(principal: Principal, sub: string, input: MemberRolesInput): Promise<void> {
    await this.members.changeRoles(principal, sub, input.roles).catch(refusal);
  }

  async remove(principal: Principal, sub: string): Promise<void> {
    await this.members.removeMember(principal, sub).catch(refusal);
  }

  async invite(principal: Principal, input: InvitationCreate): Promise<InvitationDto> {
    const digest = this.digest.digest(input.email);
    // The fingerprint of the original request: the address's keyed digest and the roles (as a set, so their order does not matter), never the address.
    const request = input.requestId
      ? { id: input.requestId, hash: createHash('sha256').update(JSON.stringify([digest.toString('hex'), [...new Set(input.roles)].sort()])).digest('hex') }
      : undefined;
    const made = await this.members.createInvitation(principal, { digest, hint: this.digest.hint(input.email), roles: input.roles, ...(request ? { request } : {}) }).catch(refusal);
    return toInvitation(made);
  }

  async listInvitations(principal: Principal, { page, pageSize }: PaginationQuery): Promise<Paginated<InvitationDto>> {
    const { items, total } = await this.members.listInvitations(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize });
    return { data: items.map(toInvitation), meta: buildMeta(page, pageSize, total) };
  }

  async cancelInvitation(principal: Principal, id: string): Promise<void> {
    await this.members.cancelInvitation(principal, id).catch(refusal);
  }
}
