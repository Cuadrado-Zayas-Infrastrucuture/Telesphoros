/** A capability is 32 random bytes as unpadded base64url: 43 URL-safe characters. The database accepts up to 128; the API sets and accepts exactly this shape. */
export const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The purpose of the per-request capability (DATA-01 decision D1: one per request, 60 s, the lifetime the database stamps). */
export const REQUEST_PURPOSE = 'request';

export interface CapabilityIssueRequest {
  /** The caller's Cognito access token, which the issuer verifies for itself. Never logged, never stored. */
  accessToken: string;
  /** The request's correlation id, written to the issuance log so an issuance can be matched to the request. */
  requestId: string;
}

export interface IssuedCapability {
  /** The raw token. It exists here and in the request's memory only; the database keeps its sha256. */
  token: string;
  expiresAt: Date;
  /**
   * The version of the person's membership the DATABASE read when it issued (migration 0030), stamped on the capability. The caller does not supply one:
   * it asks for the capability first and learns the version from the answer, so no lookup has to run before the capability exists.
   */
  membershipVersion: number;
}

export type CapabilityIssueFailure = 'invalid-token' | 'no-tenant' | 'invalid-request' | 'refused' | 'unavailable';

/** Why a capability was not issued. The message never carries a token, a database message or an address; `detail` is the database's closed refusal code. */
export class CapabilityIssueError extends Error {
  constructor(
    readonly reason: CapabilityIssueFailure,
    readonly detail?: string,
  ) {
    super(reason === 'invalid-token' ? 'Invalid token' : `Capability not issued: ${reason}`);
  }
}

/**
 * How the API asks the session issuer for a capability. The transport between the two (docs/design/plans/tenant-capability-issuer-transport.md) is not
 * built yet: the issuer core (issuer-core.ts) is one implementation, and a client for whatever transport is chosen would be another.
 *
 * `undefined` means "this deployment issues none". It is the production default until an issuer is configured, and in `guc` mode it changes nothing.
 * A refusal or failure throws `CapabilityIssueError`.
 */
export abstract class CapabilityIssuerPort {
  abstract issue(request: CapabilityIssueRequest): Promise<IssuedCapability | undefined>;
}

/** The default: no issuer, no capability. */
export class NullCapabilityIssuer extends CapabilityIssuerPort {
  async issue(): Promise<IssuedCapability | undefined> {
    return undefined;
  }
}
