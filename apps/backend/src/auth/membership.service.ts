import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { SecurityEvents } from '../security-events/security-events';
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
 *   the organization is suspended                      -> 403
 *   token issued at or before the revocation instant   -> 401  (the browser signs in again and gets a newer token)
 *   the lookup itself fails                            -> 503  (nothing is done; not 401, which would send the browser round a sign-in loop)
 */
export interface ResolveOptions {
  /**
   * True when the session issuer REFUSED this person's capability as not current ("membership-not-current" or "tenant-inactive"). The issuer's
   * `capability_issuance_log` row is then the record of the refusal (founder decision D1=(i), 2026-10-20), so the admission refusals below are not written
   * to `security_events` again. It is false when no issuer is configured or it failed: nothing else would record them. `token-revoked` is always
   * written (the issuer does not check it, and that person holds a valid capability), and so is `authority-changed` (written by the database layer).
   */
  admissionRefusalRecorded?: boolean;
}

@Injectable()
export class MembershipService {
  private readonly logger = new Logger('Membership');

  constructor(
    private readonly memberships: MembershipRepository,
    private readonly events: SecurityEvents,
  ) {}

  async resolve(identity: TokenIdentity, options: ResolveOptions = {}): Promise<ResolvedCaller> {
    const recordAdmissionRefusal = (reason: 'removed' | 'no-membership' | 'tenant-suspended') =>
      options.admissionRefusalRecorded ? Promise.resolve() : this.events.recordRefusal(identity.tenantId, identity.sub, reason);
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
      await recordAdmissionRefusal(membership ? 'removed' : 'no-membership');
      throw AppException.forbidden();
    }
    if (membership.tenantActive === false) {
      this.logger.warn({ event: 'membership-refused', reason: 'tenant-suspended', tenantId: identity.tenantId }, 'The organization is suspended');
      await recordAdmissionRefusal('tenant-suspended');
      throw AppException.forbidden();
    }
    if (identity.issuedAt <= membership.tokensValidAfter) {
      this.logger.warn({ event: 'membership-refused', reason: 'token-revoked', tenantId: identity.tenantId }, 'Token issued before the revocation instant');
      await this.events.recordRefusal(identity.tenantId, identity.sub, 'token-revoked');
      throw AppException.unauthorized();
    }
    return { principal: { sub: identity.sub, tenantId: identity.tenantId, roles: membership.roles }, version: membership.version };
  }
}
