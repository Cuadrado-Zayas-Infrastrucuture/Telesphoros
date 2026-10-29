import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { CAPABILITY_TOKEN_PATTERN, CapabilityIssueError, type IssuedJobCapability } from './capability-issuer.port';
import { checkIssuerBaseUrl, ISSUER_CLIENT_TIMEOUT_MS, MIN_RETRY_REMAINING_MS, readCappedBody, type IssuerClientDetail } from './issuer-http-client';
import { signWorkerRequest } from './worker-signature';

/**
 * Spec 012 slice 3: the evaluation worker's client for `POST /v1/job-capabilities` (slice 2). Each call signs a fresh request (plan D1) and is answered
 * with a capability for ONE transaction of the job (plan D2), naming the organization and the person the database issued it for.
 *
 * Like the API's client (issuer-http-client.ts), it may load the issuer's port and nothing of the issuer's own implementation
 * (job-capability-client-separation.spec.ts), and it never writes a token, key, signature, body, address or URL to a log or an error. A refusal is
 * `refused` with the database's closed code; anything else that is not a clean answer is `unavailable`, `unauthenticated` or `replayed`.
 */
export const JOB_CAPABILITIES_PATH = '/v1/job-capabilities';
const DEFAULT_RETRY_PAUSE_MS = 100;
const SERVER_REQUEST_TIMEOUT_MS = 10_000;
const SAFE_DETAIL = /^[a-z0-9-]{1,64}$/;

/** What the worker asks for: the job it holds, under the worker id it claimed it with. */
export interface JobCapabilityAsk {
  jobId: string;
  workerId: string;
}

/** The worker's view of the issuer. Tests substitute it; the evaluation worker uses `HttpJobCapabilityClient`. */
export interface JobCapabilityClient {
  issue(ask: JobCapabilityAsk): Promise<IssuedJobCapability>;
}

const issuedBody = z.strictObject({
  token: z.string().regex(CAPABILITY_TOKEN_PATTERN),
  expiresAt: z.iso.datetime(),
  membershipVersion: z.int().min(1),
  tenantId: z.string().min(1).max(128), // a tenant id is text (`tenants.id`), compared with the job's own below

  sub: z.string().min(1).max(256),
});
const errorBody = z.strictObject({ error: z.string(), detail: z.string().optional() });

/** Status to the error fields the job route may answer with (issuer-server.ts). A pair outside it is not the issuer speaking. */
const ERRORS: Record<number, readonly string[]> = {
  400: ['invalid-request'],
  401: ['unauthenticated', 'replayed'],
  403: ['refused'],
};

export interface HttpJobCapabilityClientOptions {
  /** The issuer's address: absolute, no credentials, no path, query or fragment. */
  baseUrl: string;
  /** The key the issuer holds as ISSUER_WORKER_KEY. */
  key: Buffer;
  timeoutMs?: number;
  /** Tests only. */
  retryPauseMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type Attempt = { kind: 'issued'; capability: IssuedJobCapability } | { kind: 'failed'; error: CapabilityIssueError; retry: boolean };

const unavailable = (detail: IssuerClientDetail | 'not-served', retry = false): Attempt => ({ kind: 'failed', error: new CapabilityIssueError('unavailable', detail), retry });

export class HttpJobCapabilityClient implements JobCapabilityClient {
  private readonly logger = new Logger('JobCapabilityClient');
  private readonly endpoint: string;
  private readonly key: Buffer;
  private readonly timeoutMs: number;
  private readonly retryPauseMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: HttpJobCapabilityClientOptions) {
    const problem = checkIssuerBaseUrl(options.baseUrl);
    if (problem) throw new Error(`Invalid issuer URL: ${problem}`);
    const timeoutMs = options.timeoutMs ?? ISSUER_CLIENT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= SERVER_REQUEST_TIMEOUT_MS)
      throw new Error("Invalid issuer client timeout: must be above 0 and below the issuer's own request timeout");
    this.endpoint = new URL(JOB_CAPABILITIES_PATH, options.baseUrl).toString();
    this.key = Buffer.from(options.key);
    this.timeoutMs = timeoutMs;
    this.retryPauseMs = options.retryPauseMs ?? DEFAULT_RETRY_PAUSE_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async issue(ask: JobCapabilityAsk): Promise<IssuedJobCapability> {
    const started = Date.now();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const first = await this.attempt(ask, deadline);
    if (first.kind === 'issued') return first.capability;
    // The same retry rule as the API's client: once, for a failed connection or a 503, never for a 4xx, a timeout or an unreadable 200. The retry is a
    // NEW signed request (a new nonce), because the issuer accepts each nonce once.
    if (first.retry && this.timeoutMs - (Date.now() - started) >= MIN_RETRY_REMAINING_MS) {
      this.logger.warn(`Job capability call retried: ${first.error.detail ?? 'unknown'}`);
      await new Promise((resolve) => setTimeout(resolve, this.retryPauseMs));
      const second = await this.attempt(ask, deadline);
      if (second.kind === 'issued') return second.capability;
      throw second.error;
    }
    throw first.error;
  }

  private async attempt(ask: JobCapabilityAsk, signal: AbortSignal): Promise<Attempt> {
    // The database records the capability against the job (FR-003); the job id is also the correlation id on the issuer's log line.
    const body = Buffer.from(JSON.stringify({ jobId: ask.jobId, workerId: ask.workerId, requestId: ask.jobId }));
    const headers = signWorkerRequest({ key: this.key, method: 'POST', path: JOB_CAPABILITIES_PATH, body, timestamp: this.now() });
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal, redirect: 'manual' });
    } catch {
      return signal.aborted ? unavailable('timeout') : unavailable('network', true);
    }

    const text = await readCappedBody(response, signal);
    if (text === 'timeout') return unavailable('timeout');
    if (text === 'too-large') return unavailable('response-too-large');
    if (text === 'gone') return unavailable('bad-response');

    if (response.status === 200) {
      const parsed = issuedBody.safeParse(parseJson(text));
      if (!parsed.success) return unavailable('bad-response');
      const { token, expiresAt, membershipVersion, tenantId, sub } = parsed.data;
      return { kind: 'issued', capability: { token, expiresAt: new Date(expiresAt), membershipVersion, tenantId, sub } };
    }
    if (response.status === 503) return unavailable('server', true);
    // An issuer started without ISSUER_WORKER_KEY does not serve the route: a deployment fault, not an answer about the job.
    if (response.status === 404) return unavailable('not-served');
    const allowed = ERRORS[response.status];
    if (!allowed) return unavailable('bad-status');
    const parsed = errorBody.safeParse(parseJson(text));
    if (!parsed.success || !allowed.includes(parsed.data.error)) return unavailable('bad-response');
    switch (parsed.data.error) {
      case 'unauthenticated':
        return { kind: 'failed', error: new CapabilityIssueError('unauthenticated'), retry: false };
      case 'replayed':
        return { kind: 'failed', error: new CapabilityIssueError('replayed'), retry: false };
      case 'invalid-request':
        return { kind: 'failed', error: new CapabilityIssueError('invalid-request'), retry: false };
      case 'refused': {
        const detail = parsed.data.detail !== undefined && SAFE_DETAIL.test(parsed.data.detail) ? parsed.data.detail : undefined;
        return { kind: 'failed', error: new CapabilityIssueError('refused', detail), retry: false };
      }
      default:
        return unavailable('bad-response'); // unreachable: `allowed` holds only the four above
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
