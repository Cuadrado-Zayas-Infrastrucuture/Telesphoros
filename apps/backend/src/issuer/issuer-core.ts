import { createHash, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { InvalidTokenError, NoTenantError, type TokenVerifier } from '../auth/token-verifier';
import { pgClientConfig } from '../db/tls';
import {
  CAPABILITY_TOKEN_PATTERN,
  CapabilityIssueError,
  type CapabilityIssueRequest,
  CapabilityIssuerPort,
  type IssuedCapability,
  type IssuedJobCapability,
  JOB_PURPOSE,
  JobCapabilityIssuer,
  type JobCapabilityRequest,
  REQUEST_PURPOSE,
} from './capability-issuer.port';

/** What the issuer asks of the database: `tenant_capability_issue_current` (migration 0031), with the token already hashed. It names no membership version: the database reads the current one. */
export interface IssueCall {
  tenant: string;
  sub: string;
  purpose: string;
  tokenHash: Buffer;
  requestId: string;
}

/** Issued: an expiry and the membership version the database stamped. Refused: a closed refusal code. */
export interface IssueOutcome {
  expiresAt: Date | null;
  refusal: string | null;
  membershipVersion: number | null;
}

export interface CapabilityIssueStore {
  /** Either an expiry and a version (issued) or a closed refusal code (refused). A failure throws. */
  issue(call: IssueCall): Promise<IssueOutcome>;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The session issuer's core (DATA-01 FR-004). It verifies the access token with the verifier it is given (production: `CognitoTokenVerifier`, unchanged),
 * generates 32 random bytes, hands the database only their sha256, and returns the raw token once. It reads no tenant data: the issuer login's only
 * privilege is EXECUTE on the issue functions, which read the organization and the person's CURRENT membership version under their own authority.
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
        tenant: identity.tenantId,
        sub: identity.sub,
        purpose: REQUEST_PURPOSE,
        // The database hashes the TEXT it is later given in app.capability, so the hash is of the text.
        tokenHash: createHash('sha256').update(token, 'utf8').digest(),
        requestId: request.requestId,
      });
    } catch (error) {
      this.logger.warn(`Capability not issued: unavailable (${(error as Error).name})`);
      throw new CapabilityIssueError('unavailable');
    }
    if (outcome.refusal !== null) throw this.refuse('refused', request, outcome.refusal);
    // An issuance without an expiry, or without a usable version, is not one: the API binds its commit-time check to this version.
    if (!outcome.expiresAt || !Number.isSafeInteger(outcome.membershipVersion) || outcome.membershipVersion! < 1) throw this.refuse('unavailable', request);
    return { token, expiresAt: outcome.expiresAt, membershipVersion: outcome.membershipVersion! };
  }

  private refuse(reason: CapabilityIssueError['reason'], request: CapabilityIssueRequest, detail?: string): CapabilityIssueError {
    // Reason codes and the request id only: never a token, a claim or a message from below.
    const id = SAFE_REQUEST_ID.test(request.requestId) ? request.requestId : '-';
    this.logger.warn(`Capability not issued: ${reason}${detail ? ` (${detail})` : ''} request=${id}`);
    return new CapabilityIssueError(reason, detail);
  }
}

/** What the job route asks of the database: `issuer_nonce_claim` (migration 0057) and `tenant_capability_issue_for_job` (0056). */
export interface JobCapabilityStore {
  /** True the first time a caller presents a nonce, on any issuer task; false for a copy. */
  claimNonce(caller: string, nonce: string): Promise<boolean>;
  issueForJob(call: { jobId: string; workerId: string; tokenHash: Buffer }): Promise<IssueOutcome & { tenantId: string | null; sub: string | null }>;
}

/**
 * Spec 012 slice 2: the issuer side of a job capability. The server has checked the worker's signature; this claims the nonce, generates the token, hands
 * the database only its sha256, and returns the token once with the organization and person the database named. Like IssuerCore, it writes the one
 * `Capability not issued: <reason>` line per failure that issuer.tf's metric filters count.
 */
export class JobIssuerCore extends JobCapabilityIssuer {
  private readonly logger = new Logger('SessionIssuer');

  constructor(
    private readonly store: JobCapabilityStore,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {
    super();
  }

  async issueForJob(job: JobCapabilityRequest): Promise<IssuedJobCapability> {
    let claimed: boolean;
    try {
      claimed = await this.store.claimNonce(job.caller, job.nonce);
    } catch (error) {
      this.logger.warn(`Capability not issued: unavailable (${(error as Error).name})`);
      throw new CapabilityIssueError('unavailable');
    }
    if (!claimed) throw this.refuse('replayed', job);
    const token = this.random(32).toString('base64url');
    if (!CAPABILITY_TOKEN_PATTERN.test(token)) throw this.refuse('unavailable', job);
    let outcome;
    try {
      outcome = await this.store.issueForJob({ jobId: job.jobId, workerId: job.workerId, tokenHash: createHash('sha256').update(token, 'utf8').digest() });
    } catch (error) {
      this.logger.warn(`Capability not issued: unavailable (${(error as Error).name})`);
      throw new CapabilityIssueError('unavailable');
    }
    if (outcome.refusal !== null) throw this.refuse('refused', job, outcome.refusal);
    if (!outcome.expiresAt || !Number.isSafeInteger(outcome.membershipVersion) || outcome.membershipVersion! < 1 || !outcome.tenantId || !outcome.sub)
      throw this.refuse('unavailable', job);
    return { token, expiresAt: outcome.expiresAt, membershipVersion: outcome.membershipVersion!, tenantId: outcome.tenantId, sub: outcome.sub };
  }

  private refuse(reason: CapabilityIssueError['reason'], job: JobCapabilityRequest, detail?: string): CapabilityIssueError {
    const id = SAFE_REQUEST_ID.test(job.requestId) ? job.requestId : '-';
    this.logger.warn(`Capability not issued: ${reason}${detail ? ` (${detail})` : ''} purpose=${JOB_PURPOSE} request=${id}`);
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
export class PgCapabilityIssueStore implements CapabilityIssueStore, JobCapabilityStore {
  private readonly logger = new Logger('SessionIssuer');
  private readonly pool: Pool;

  constructor(options: PgCapabilityIssueStoreOptions) {
    this.pool = new Pool({
      ...pgClientConfig(options.url, options.ssl),
      max: options.max ?? 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 5_000,
      query_timeout: 7_000, // also bound a half-open connection that cannot deliver PostgreSQL's timeout response
      idle_in_transaction_session_timeout: 10_000,
      application_name: 'telesphoros-session-issuer',
    });
    this.pool.on('error', (error) => this.logger.error(`Idle database client error: ${error.name}`));
  }

  async issue(call: IssueCall): Promise<IssueOutcome> {
    const { rows } = await this.pool.query<{ expires_at: Date | null; refusal: string | null; membership_version: string | null }>(
      'SELECT expires_at, refusal, membership_version FROM tenant_capability_issue_current($1, $2, $3, $4, $5)',
      [call.tenant, call.sub, call.purpose, call.tokenHash, call.requestId],
    );
    const row = rows[0];
    if (!row) throw new Error('The issue function returned no row');
    // bigint arrives as text; a version beyond the safe range cannot be a real one and is refused by the core.
    return { expiresAt: row.expires_at, refusal: row.refusal, membershipVersion: row.membership_version === null ? null : Number(row.membership_version) };
  }

  async claimNonce(caller: string, nonce: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ claimed: boolean }>('SELECT issuer_nonce_claim($1, $2) AS claimed', [caller, nonce]);
    return rows[0]?.claimed === true;
  }

  async issueForJob(call: { jobId: string; workerId: string; tokenHash: Buffer }): Promise<IssueOutcome & { tenantId: string | null; sub: string | null }> {
    const { rows } = await this.pool.query<{ expires_at: Date | null; refusal: string | null; membership_version: string | null; tenant_id: string | null; sub: string | null }>(
      'SELECT expires_at, refusal, membership_version, tenant_id, sub FROM tenant_capability_issue_for_job($1, $2, $3)',
      [call.jobId, call.workerId, call.tokenHash],
    );
    const row = rows[0];
    if (!row) throw new Error('The job issue function returned no row');
    return {
      expiresAt: row.expires_at,
      refusal: row.refusal,
      membershipVersion: row.membership_version === null ? null : Number(row.membership_version),
      tenantId: row.tenant_id,
      sub: row.sub,
    };
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
