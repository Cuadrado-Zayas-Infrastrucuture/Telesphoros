import { Injectable, Logger } from '@nestjs/common';
import { bindRequestCapability, capabilityAbsentReason, currentRequestCapability, noteCapabilityAbsent } from '../auth/authority-context';
import { CapabilityIssueError, type CapabilityIssueRequest, CapabilityIssuerPort } from './capability-issuer.port';

/**
 * How long the guard waits for the port. A port that never answers must not hold every request open. Provisional: decision D4 sets the real budget from
 * a staging measurement; until then this only bounds the wait, and an overrun is recorded like any other failure.
 */
export const CAPABILITY_ISSUE_TIMEOUT_MS = 3000;

/**
 * What the guard learns from asking. `bound`: the request holds a capability and this is the membership version it was issued at. `absent`: it has none, and
 * why. `refusal` is the database's closed code when the issuer REFUSED (the refusal is then in the issuance log, which is what decision D1=(i) relies on).
 */
export type CapabilityOutcome =
  | { status: 'bound'; membershipVersion: number }
  | { status: 'absent'; reason: string; refusal?: string };

/**
 * The API's side of FR-011: obtain ONE capability for the request and keep it in the request's slot, beside its authority, so every `withTenant` call in
 * the request reuses it. Called once by AuthGuard, BEFORE the membership is read: the issuer reads the current membership version itself and returns it, so
 * the lookup that follows is an ordinary transaction under the capability and is counted like every other.
 *
 * The binding mode is `guc`, so a request that cannot get a capability goes on exactly as it does today. What it records is the REASON, which the
 * database layer counts. Turning a missing capability into a 503 is slice 5's switch, not this one's.
 */
@Injectable()
export class RequestCapabilities {
  private readonly logger = new Logger('RequestCapabilities');

  /** A property, not a constructor parameter: Nest would try to inject a number. Tests shorten it. */
  timeoutMs: number = CAPABILITY_ISSUE_TIMEOUT_MS;

  constructor(private readonly issuer: CapabilityIssuerPort) {}

  async obtain(request: CapabilityIssueRequest): Promise<CapabilityOutcome> {
    const have = currentRequestCapability();
    if (have) return { status: 'bound', membershipVersion: have.membershipVersion };
    const absent = capabilityAbsentReason();
    if (absent) return { status: 'absent', reason: absent }; // once per request, whether it worked or not
    try {
      const issued = await this.withinBudget(this.issuer.issue(request));
      if (!issued) {
        noteCapabilityAbsent('not-configured');
        return { status: 'absent', reason: 'not-configured' };
      }
      bindRequestCapability(issued);
      return { status: 'bound', membershipVersion: issued.membershipVersion };
    } catch (error) {
      const reason = error instanceof CapabilityIssueError ? error.reason : 'unavailable';
      const refusal = error instanceof CapabilityIssueError && error.reason === 'refused' ? error.detail : undefined;
      // The code only: an error from below can carry a token, an address or a message that must not reach a log.
      this.logger.warn(`No capability for this request: ${reason}${error instanceof CapabilityIssueError && error.detail ? ` (${error.detail})` : ''}`);
      noteCapabilityAbsent(`issuer-${reason}`);
      return { status: 'absent', reason: `issuer-${reason}`, ...(refusal ? { refusal } : {}) };
    }
  }

  private async withinBudget<T>(pending: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const overrun = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CapabilityIssueError('unavailable', 'timeout')), this.timeoutMs);
    });
    // If the budget wins, the port's late answer (or late failure) must neither be unhandled nor be used.
    pending.catch(() => undefined);
    try {
      return await Promise.race([pending, overrun]);
    } finally {
      clearTimeout(timer);
    }
  }
}
