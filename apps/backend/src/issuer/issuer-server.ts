import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { CapabilityIssueError, type CapabilityIssueFailure, type CapabilityIssueRequest, type CapabilityIssuerPort } from './capability-issuer.port';

/**
 * The session issuer's HTTP face (DATA-01 PR A). Plain node:http, no framework, so there is no route table, body parser or error filter to configure
 * wrongly: two routes, one table.
 *
 *   POST /v1/capabilities   {accessToken, membershipVersion, requestId}  ->  200 {token, expiresAt}
 *   GET  /livez                                                          ->  200 (the container's health check)
 *   anything else                                                        ->  404
 *
 * The response never carries more than a closed code: the failure reason, and for a refusal the database's closed refusal code. It never echoes a token,
 * a claim, a database message or an address, and neither does the log. `IssuerCore` writes the `Capability not issued: <reason>` lines that issuer.tf's
 * metric filters count, once per failure; this file writes different phrases on purpose, so a failure is never counted twice.
 */
export const MAX_BODY_BYTES = 8 * 1024;
/** Real Cognito access tokens are about 1 to 1.3 KiB. */
const MAX_ACCESS_TOKEN_CHARS = 4096;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_DETAIL = /^[a-z0-9-]{1,64}$/;
const SAFE_NAME = /^[A-Za-z0-9_]{1,64}$/;

/** Failure reason to status. A closed table: a new reason in the port does not compile until it is given a status here. */
const STATUS: Record<CapabilityIssueFailure, number> = {
  'invalid-token': 401,
  'no-tenant': 403,
  'invalid-request': 400,
  refused: 403,
  unavailable: 503,
};

const body = z.strictObject({
  accessToken: z.string().min(1).max(MAX_ACCESS_TOKEN_CHARS),
  membershipVersion: z.int().min(1),
  requestId: z.string().regex(SAFE_REQUEST_ID),
});

export interface IssuerServerLimits {
  /** How long a client may take to send its request line and headers. */
  headersTimeoutMs: number;
  /** How long a client may take to send the whole request. */
  requestTimeoutMs: number;
  /** Open connections beyond this are dropped: the API sends few, and a flood fails closed. */
  maxConnections: number;
  /** Node enforces the two timeouts only when it checks, by default every 30 s. */
  checkIntervalMs: number;
}

export const DEFAULT_LIMITS: IssuerServerLimits = { headersTimeoutMs: 5000, requestTimeoutMs: 10_000, maxConnections: 128, checkIntervalMs: 1000 };

type Early = 'unsupported-media-type' | 'payload-too-large' | 'invalid-request';

export function createIssuerServer(issuer: CapabilityIssuerPort, limits: Partial<IssuerServerLimits> = {}): Server {
  const l = { ...DEFAULT_LIMITS, ...limits };
  const logger = new Logger('IssuerHttp');

  const reply = (res: ServerResponse, status: number, payload: unknown): void => {
    if (res.headersSent) return;
    // `Connection: close` on every answer: the proxy in front never reuses a connection this process is about to time out, and nothing is kept open for idle clients.
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
    res.end(JSON.stringify(payload));
  };

  /** A request refused before the port is asked: the body may be unread, so the connection is cut once the answer is out. */
  const reject = (req: IncomingMessage, res: ServerResponse, status: number, code: Early): void => {
    logger.warn(`Issuer request rejected: ${code} (${status})`);
    res.once('finish', () => req.destroy());
    reply(res, status, { error: code });
  };

  const readBody = (req: IncomingMessage): Promise<Buffer | 'too-large' | 'gone'> =>
    new Promise((resolve) => {
      const parts: Buffer[] = [];
      let size = 0;
      let settled = false;
      const done = (value: Buffer | 'too-large' | 'gone') => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          parts.length = 0;
          done('too-large');
          return;
        }
        parts.push(chunk);
      });
      req.on('end', () => done(Buffer.concat(parts)));
      req.on('error', () => done('gone'));
      req.on('close', () => done('gone'));
    });

  const issue = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return reject(req, res, 415, 'unsupported-media-type');
    const declared = Number(req.headers['content-length']);
    if (req.headers['content-length'] !== undefined && declared > MAX_BODY_BYTES) return reject(req, res, 413, 'payload-too-large');
    const raw = await readBody(req);
    if (raw === 'gone') return; // the caller left, or Node timed it out and already answered
    if (raw === 'too-large') return reject(req, res, 413, 'payload-too-large');
    let request: CapabilityIssueRequest;
    try {
      request = body.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      return reject(req, res, 400, 'invalid-request');
    }
    try {
      const issued = await issuer.issue(request);
      if (!issued) throw new CapabilityIssueError('unavailable'); // an issuer that issues nothing is not an issuer
      reply(res, 200, { token: issued.token, expiresAt: issued.expiresAt.toISOString() });
    } catch (error) {
      if (error instanceof CapabilityIssueError) {
        // IssuerCore has logged the reason. Only a closed code of the database's own is passed on.
        const detail = error.reason === 'refused' && error.detail && SAFE_DETAIL.test(error.detail) ? { detail: error.detail } : {};
        return reply(res, STATUS[error.reason], { error: error.reason, ...detail });
      }
      logger.warn(`Issuer request failed: unexpected (${error instanceof Error && SAFE_NAME.test(error.name) ? error.name : 'Error'})`);
      reply(res, 503, { error: 'unavailable' });
    }
  };

  const server = createServer(
    { headersTimeout: l.headersTimeoutMs, requestTimeout: l.requestTimeoutMs, connectionsCheckingInterval: l.checkIntervalMs, keepAliveTimeout: 5000, maxHeaderSize: 8192 },
    (req, res) => {
      if (req.method === 'GET' && req.url === '/livez') return reply(res, 200, { status: 'ok' });
      if (req.method === 'POST' && req.url === '/v1/capabilities') {
        issue(req, res).catch(() => {
          logger.warn('Issuer request failed: unexpected (Error)');
          reply(res, 503, { error: 'unavailable' });
        });
        return;
      }
      reply(res, 404, { error: 'not-found' });
    },
  );
  server.maxConnections = l.maxConnections;
  server.maxRequestsPerSocket = 1;
  return server;
}

/** Stops accepting, lets requests in flight finish, and after `graceMs` cuts whatever is left. Resolves once the server is closed. */
export function drainServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}
