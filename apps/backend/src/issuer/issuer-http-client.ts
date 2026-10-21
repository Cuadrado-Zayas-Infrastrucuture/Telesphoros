import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { CAPABILITY_TOKEN_PATTERN, CapabilityIssueError, type CapabilityIssueRequest, CapabilityIssuerPort, type IssuedCapability } from './capability-issuer.port';

/**
 * The API's client for the session issuer (DATA-01 PR B): `CapabilityIssuerPort` over HTTP, to the wire issuer-server.ts speaks: `{accessToken, requestId}` in, `{token, expiresAt, membershipVersion}` out. The transport is ECS
 * Service Connect (docs/design/plans/tenant-capability-issuer-transport.md): the API calls `http://session-issuer:8082`, the proxy carries it, and the
 * only caller check is the issuer's security group. There is no shared secret here.
 *
 * This file may import the port and nothing else of the issuer (issuer-http-client-separation.spec.ts): the API must not be able to reach the issuer's store,
 * its settings, its server or its database login. Node's own `fetch`, no dependency.
 *
 * Everything that is not a clean answer is `unavailable`, with a closed `detail` the caller may log. No token, claim, response body, address or URL is
 * ever written to a log or an error, and the alarm phrase issuer.tf counts is written by the issuer only, so a failure is not counted twice.
 */

/**
 * The whole call, retry included. Provisional, like the guard's wait that it sits under (CAPABILITY_ISSUE_TIMEOUT_MS = 3000): decision D4 sets the real
 * p95 budget from a staging measurement. It is far below the server's own 10 s request timeout, so the client gives up first.
 */
export const ISSUER_CLIENT_TIMEOUT_MS = 2500;
/** A real answer is about 100 bytes (a 43-character token and a timestamp). Anything near this is not the issuer. */
export const MAX_ISSUER_RESPONSE_BYTES = 4096;
/** A retry needs room for a whole answer; with less than this left it would only run into the deadline. */
export const MIN_RETRY_REMAINING_MS = 500;
const DEFAULT_RETRY_PAUSE_MS = 100;
const SERVER_REQUEST_TIMEOUT_MS = 10_000;
const SAFE_DETAIL = /^[a-z0-9-]{1,64}$/;

/** Why the call produced nothing. The caller logs this and nothing else about the failure. */
export type IssuerClientDetail = 'timeout' | 'network' | 'response-too-large' | 'bad-response' | 'bad-status' | 'server';

/**
 * The same rule as `issuerUrlProblem` in config/env.ts, which cannot be imported here (this module may reach the port only) and cannot import this (it
 * is loaded on its own). A test pins the two to the same table. The message names the setting and the rule, never the value.
 */
export function checkIssuerBaseUrl(value: string): string | undefined {
  if (value !== value.trim() || /[\s?#]/.test(value)) return 'must be an absolute http(s) URL with no spaces, query or fragment';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute http(s) URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https';
  if (!url.hostname) return 'must name a host';
  if (url.username || url.password) return 'must not carry credentials';
  if (url.pathname !== '/') return 'must not have a path';
  return undefined;
}

// `membershipVersion` is the version the DATABASE read when it issued (migration 0031); the request carries none. An answer without it is not an issuance.
const issuedBody = z.strictObject({ token: z.string().regex(CAPABILITY_TOKEN_PATTERN), expiresAt: z.iso.datetime(), membershipVersion: z.int().min(1) });
const errorBody = z.strictObject({ error: z.string(), detail: z.string().optional() });

/**
 * Status to the error fields that status may carry, from issuer-server.ts's table. A pair outside it is not the issuer speaking. 503 is not in the table
 * on purpose: the issuer's own 503 and the Service Connect proxy's 503 (no healthy task yet) both mean "try once more", whatever the body says.
 */
const ERRORS: Record<number, readonly string[]> = {
  400: ['invalid-request'],
  401: ['invalid-token'],
  403: ['no-tenant', 'refused'],
};

export interface HttpCapabilityIssuerOptions {
  /** `http://session-issuer:8082`: absolute, no credentials, no path, query or fragment. */
  baseUrl: string;
  /** The whole call, retry included. */
  timeoutMs?: number;
  /** Tests only. */
  retryPauseMs?: number;
  fetchImpl?: typeof fetch;
}

type Attempt =
  | { kind: 'issued'; capability: IssuedCapability }
  | { kind: 'failed'; error: CapabilityIssueError; retry: boolean };

const unavailable = (detail: IssuerClientDetail, retry = false): Attempt => ({ kind: 'failed', error: new CapabilityIssueError('unavailable', detail), retry });

export class HttpCapabilityIssuer extends CapabilityIssuerPort {
  private readonly logger = new Logger('IssuerClient');
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly retryPauseMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpCapabilityIssuerOptions) {
    super();
    const problem = checkIssuerBaseUrl(options.baseUrl);
    if (problem) throw new Error(`Invalid issuer URL: ${problem}`);
    const timeoutMs = options.timeoutMs ?? ISSUER_CLIENT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= SERVER_REQUEST_TIMEOUT_MS) throw new Error('Invalid issuer client timeout: must be above 0 and below the issuer\'s own request timeout');
    this.endpoint = new URL('/v1/capabilities', options.baseUrl).toString();
    this.timeoutMs = timeoutMs;
    this.retryPauseMs = options.retryPauseMs ?? DEFAULT_RETRY_PAUSE_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async issue(request: CapabilityIssueRequest): Promise<IssuedCapability> {
    const started = Date.now();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const first = await this.attempt(request, deadline);
    if (first.kind === 'issued') return first.capability;
    // One retry, for a connection that failed or an issuer that said 503, because those say nothing about the request and a second try can succeed. Never
    // for a 4xx (the answer is the same again, and a refusal must stay a refusal), never after a timeout (the deadline is spent), never after a 200 the
    // client could not read (the issuer HAS issued: a second ask would mint a second capability for nothing).
    if (first.retry && this.timeoutMs - (Date.now() - started) >= MIN_RETRY_REMAINING_MS) {
      this.logger.warn(`Issuer call retried: ${first.error.detail ?? 'unknown'}`);
      await new Promise((resolve) => setTimeout(resolve, this.retryPauseMs));
      const second = await this.attempt(request, deadline);
      if (second.kind === 'issued') return second.capability;
      throw second.error;
    }
    throw first.error;
  }

  private async attempt(request: CapabilityIssueRequest, signal: AbortSignal): Promise<Attempt> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: request.accessToken, requestId: request.requestId }),
        signal,
        redirect: 'manual', // a redirect must never carry the access token somewhere the configuration did not name
      });
    } catch {
      // The error from below is dropped on purpose: it can carry an address, and its message is not ours to log.
      return signal.aborted ? unavailable('timeout') : unavailable('network', true);
    }

    const text = await this.readCapped(response, signal);
    if (text === 'timeout') return unavailable('timeout');
    if (text === 'too-large') return unavailable('response-too-large');
    if (text === 'gone') return unavailable('bad-response');

    if (response.status === 200) {
      const parsed = issuedBody.safeParse(parseJson(text));
      if (!parsed.success) return unavailable('bad-response');
      return { kind: 'issued', capability: { token: parsed.data.token, expiresAt: new Date(parsed.data.expiresAt), membershipVersion: parsed.data.membershipVersion } };
    }

    if (response.status === 503) return unavailable('server', true);
    const allowed = ERRORS[response.status];
    if (!allowed) return unavailable('bad-status');
    const parsed = errorBody.safeParse(parseJson(text));
    if (!parsed.success || !allowed.includes(parsed.data.error)) return unavailable('bad-response');
    switch (parsed.data.error) {
      case 'invalid-token':
        return { kind: 'failed', error: new CapabilityIssueError('invalid-token'), retry: false };
      case 'no-tenant':
        return { kind: 'failed', error: new CapabilityIssueError('no-tenant'), retry: false };
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

  /** The body as text, read at most up to the cap. A longer body is cut as soon as it passes the cap; the deadline covers a body that stalls. */
  private async readCapped(response: Response, signal: AbortSignal): Promise<string | 'timeout' | 'too-large' | 'gone'> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ISSUER_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return 'too-large';
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ISSUER_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return 'too-large';
        }
        parts.push(value);
      }
    } catch {
      return signal.aborted ? 'timeout' : 'gone';
    }
    return Buffer.concat(parts).toString('utf8');
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
