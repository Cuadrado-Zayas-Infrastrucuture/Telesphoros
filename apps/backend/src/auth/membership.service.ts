import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { MembershipRepository } from '../storage/membership.repository';
import type { Principal } from './principal';
import type { TokenIdentity } from './token-verifier';

export interface ResolvedCaller {
  principal: Principal;
  /** The version of the membership row the roles came from; a write is refused at commit if the row has moved on. */
  version: number;
}

/**
 * Turns a verified token into the caller's CURRENT authority. The token proves identity; the roles and whether the person still belongs
 * come from the database, read fresh on every protected request (no allow decision is cached).
 *
 *   no active membership in the token's organization   -> 403  (known person, not allowed in; same as an account with no organization)
 *   token issued at or before the revocation instant   -> 401  (the browser signs in again and gets a newer token)
 *   the lookup itself fails                            -> 503  (nothing is done; not 401, which would send the browser round a sign-in loop)
 */
@Injectable()
export class MembershipService {
  private readonly logger = new Logger('Membership');

  constructor(private readonly memberships: MembershipRepository) {}

  async resolve(identity: TokenIdentity): Promise<ResolvedCaller> {
    let membership;
    try {
      membership = await this.memberships.find(identity.tenantId, identity.sub);
    } catch (error) {
      // Operators need to know the authority store is the problem; callers learn only that the service is unavailable.
      this.logger.error({ event: 'membership-lookup-failed', tenantId: identity.tenantId, error: (error as Error).name }, 'Could not establish who the caller is allowed to be; refusing the request');
      throw AppException.unavailable('The service is temporarily unavailable. Nothing was done; try again shortly.');
    }
    if (!membership || membership.status !== 'active') {
      this.logger.warn({ event: 'membership-refused', reason: membership ? 'removed' : 'none', tenantId: identity.tenantId }, 'No active membership');
      throw AppException.forbidden();
    }
    if (identity.issuedAt <= membership.tokensValidAfter) {
      this.logger.warn({ event: 'membership-refused', reason: 'token-revoked', tenantId: identity.tenantId }, 'Token issued before the revocation instant');
      throw AppException.unauthorized();
    }
    return { principal: { sub: identity.sub, tenantId: identity.tenantId, roles: membership.roles }, version: membership.version };
  }
}
