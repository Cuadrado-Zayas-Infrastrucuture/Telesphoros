import { createHash, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { InvalidTokenError, NoTenantError, type TokenVerifier } from '../auth/token-verifier';
import { pgClientConfig } from '../db/tls';
import {
  CAPABILITY_TOKEN_PATTERN, CapabilityIssueError, type CapabilityIssueRequest, CapabilityIssuerPort, type IssuedCapability, REQUEST_PURPOSE,
} from './capability-issuer.port';

/** What the issuer asks of the database: `tenant_capability_issue` (migration 0028), with the token already hashed. */
export interface IssueCall {
  tenant: string;
  sub: string;
  membershipVersion: number;
  purpose: string;
  tokenHash: Buffer;
  requestId: string;
}

export interface CapabilityIssueStore {
  /** Either an expiry (issued) or a closed refusal code (refused). A failure throws. */
  issue(call: IssueCall): Promise<{ expiresAt: Date | null; refusal: string | null }>;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The session issuer's core (DATA-01 FR-004). It verifies the access token with the verifier it is given (production: `CognitoTokenVerifier`, unchanged),
 * generates 32 random bytes, hands the database only their sha256, and returns the raw token once. It reads no tenant data: the issuer login's only
 * privilege is EXECUTE on the issue function, which re-checks the organization and the membership version under its own authority.
 *
 * This class opens no port and listens for nothing. How the API reaches it is a separate decision (docs/design/plans/tenant-capability-issuer-transport.md).
 * Putting it IN the API process would hand the API the issuer's database credential and so defeat the point, so the API does not construct it.
 */
export class IssuerCore extends CapabilityIssuerPort {
  private readonly logger = new Logger('SessionIssuer');

  constructor(
    private readonly verifier: TokenVerifier,
    private readonly store: CapabilityIssueStore,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {
    super();
  }

  async issue(request: CapabilityIssueRequest): Promise<IssuedCapability> {
    if (!Number.isSafeInteger(request.membershipVersion) || request.membershipVersion < 1) throw this.refuse('invalid-request', request);
    let identity;
    try {
      identity = await this.verifier.verify(request.accessToken);
    } catch (error) {
      if (error instanceof NoTenantError) throw this.refuse('no-tenant', request);
      if (error instanceof InvalidTokenError) throw this.refuse('invalid-token', request);
      throw this.refuse('invalid-token', request); // anything else from a verifier is also a refusal; callers never learn why
    }
    const token = this.random(32).toString('base64url');
    if (!CAPABILITY_TOKEN_PATTERN.test(token)) throw this.refuse('unavailable', request);
    let outcome;
    try {
      outcome = await this.store.issue({
        tenant: identity.tenantId, sub: identity.sub, membershipVersion: request.membershipVersion, purpose: REQUEST_PURPOSE,
        // The database hashes the TEXT it is later given in app.capability, so the hash is of the text.
        tokenHash: createHash('sha256').update(token, 'utf8').digest(), requestId: request.requestId,
      });
    } catch (error) {
      this.logger.warn(`Capability not issued: unavailable (${(error as Error).name})`);
      throw new CapabilityIssueError('unavailable');
    }
    if (outcome.refusal !== null) throw this.refuse('refused', request, outcome.refusal);
    if (!outcome.expiresAt) throw this.refuse('unavailable', request);
    return { token, expiresAt: outcome.expiresAt };
  }

  private refuse(reason: CapabilityIssueError['reason'], request: CapabilityIssueRequest, detail?: string): CapabilityIssueError {
    // Reason codes and the request id only: never a token, a claim or a message from below.
    const id = SAFE_REQUEST_ID.test(request.requestId) ? request.requestId : '-';
    this.logger.warn(`Capability not issued: ${reason}${detail ? ` (${detail})` : ''} request=${id}`);
    return new CapabilityIssueError(reason, detail);
  }
}

export interface PgCapabilityIssueStoreOptions {
  /** Connection string for the ISSUER login (`telesphoros_session_issuer`), never the application's or the migrator's. */
  url: string;
  ssl: 'disable' | 'require';
  max?: number;
}

/** The issuer's database door, on its own small pool. */
export class PgCapabilityIssueStore implements CapabilityIssueStore {
  private readonly logger = new Logger('SessionIssuer');
  private readonly pool: Pool;

  constructor(options: PgCapabilityIssueStoreOptions) {
    this.pool = new Pool({
      ...pgClientConfig(options.url, options.ssl),
      max: options.max ?? 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 5_000,
      idle_in_transaction_session_timeout: 10_000,
      application_name: 'telesphoros-session-issuer',
    });
    this.pool.on('error', (error) => this.logger.error(`Idle database client error: ${error.name}`));
  }

  async issue(call: IssueCall): Promise<{ expiresAt: Date | null; refusal: string | null }> {
    const { rows } = await this.pool.query<{ expires_at: Date | null; refusal: string | null }>(
      'SELECT expires_at, refusal FROM tenant_capability_issue($1, $2, $3, $4, $5, $6)',
      [call.tenant, call.sub, call.membershipVersion, call.purpose, call.tokenHash, call.requestId],
    );
    const row = rows[0];
    if (!row) throw new Error('The issue function returned no row');
    return { expiresAt: row.expires_at, refusal: row.refusal };
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
