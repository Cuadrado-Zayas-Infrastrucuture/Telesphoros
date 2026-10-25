import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for "the second provider": a small HTTP gateway in front of the S3 emulator. It exists because the
 * emulator accepts anything from anyone, while a real provider (a) knows who is calling and what each key may do,
 * (b) rejects things it does not implement. The gateway makes those behaviours testable here:
 *
 *   - per-key permissions (an upload-only key, a read-only key, an admin key), answered like a provider does: 403 AccessDenied
 *   - strict mode: refuses the checksum headers and streaming-chunked bodies that the AWS SDK adds by default and that
 *     several S3-compatible providers reject (HTTP 400)
 *   - a full record of every request (operation, caller key id, headers), to assert what did and did NOT reach the provider
 *   - failure injection: transient 503s, a different ETag style, a corrupted ETag
 *
 * It does not verify request signatures (the emulator does not either); it identifies the caller by access key id.
 */
export type Op = 'put' | 'get' | 'list' | 'delete' | 'head-bucket' | 'get-lock-config' | 'get-versioning' | 'other';

export interface Recorded {
  method: string;
  path: string;
  op: Op;
  accessKeyId: string;
  headers: IncomingHttpHeaders;
  status: number;
}

export interface GatewayOptions {
  /** access key id -> operations that key may perform */
  keys: Record<string, Op[]>;
  /** Reject checksum headers and aws-chunked bodies like a stricter provider. */
  strict?: boolean;
  /** Reject server-side-encryption headers naming KMS (most non-AWS providers have no KMS). */
  rejectKms?: boolean;
  /** Answer the first N object PUTs with 503. */
  failFirstPuts?: number;
  /** How PUT responses present the ETag: as the emulator does, unquoted upper-case, or something that is not an MD5. */
  etag?: 'as-is' | 'upper-unquoted' | 'not-md5' | 'wrong-md5';
}

export interface Gateway {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

function classify(method: string, url: URL): Op {
  const segments = url.pathname.split('/').filter(Boolean);
  const isObject = segments.length > 1;
  if (!isObject) {
    if (method === 'HEAD') return 'head-bucket';
    if (method === 'GET' && url.searchParams.has('object-lock')) return 'get-lock-config';
    if (method === 'GET' && url.searchParams.has('versioning')) return 'get-versioning';
    if (method === 'GET' && url.searchParams.get('list-type') === '2') return 'list';
    return 'other';
  }
  if (method === 'PUT' && !url.searchParams.has('retention') && !url.searchParams.has('legal-hold')) return 'put';
  if (method === 'GET' || method === 'HEAD') return 'get';
  if (method === 'DELETE') return 'delete';
  return 'other';
}

const accessKeyOf = (headers: IncomingHttpHeaders) => /Credential=([^/,\s]+)\//.exec(String(headers.authorization ?? ''))?.[1] ?? '';

function refuse(res: ServerResponse, status: number, code: string, message: string) {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
}

export async function startGateway(upstream: string, options: GatewayOptions): Promise<Gateway> {
  const upstreamUrl = new URL(upstream);
  const requests: Recorded[] = [];
  let putsSeen = 0;

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const op = classify(req.method ?? 'GET', url);
    const accessKeyId = accessKeyOf(req.headers);
    const record = (status: number) =>
      requests.push({ method: req.method ?? '', path: url.pathname + url.search, op, accessKeyId, headers: { ...req.headers, authorization: undefined }, status });
    const done = (status: number, code: string, message: string) => {
      record(status);
      req.resume(); // the body is not wanted; drain it
      refuse(res, status, code, message);
    };

    const allowed = options.keys[accessKeyId];
    if (!allowed) return done(403, 'InvalidAccessKeyId', 'The access key is not known.');
    if (!allowed.includes(op)) return done(403, 'AccessDenied', 'Access Denied');

    const h = req.headers;
    if (options.strict) {
      const offending = Object.keys(h).find((name) => name.startsWith('x-amz-checksum-') || name === 'x-amz-sdk-checksum-algorithm' || name === 'x-amz-trailer');
      if (offending) return done(400, 'InvalidRequest', `Unsupported header ${offending}`);
      if (String(h['content-encoding'] ?? '').includes('aws-chunked') || String(h['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) {
        return done(400, 'InvalidRequest', 'Streaming signed payloads are not supported');
      }
    }
    if (options.rejectKms && String(h['x-amz-server-side-encryption'] ?? '') === 'aws:kms') return done(501, 'NotImplemented', 'KMS encryption is not supported');
    if (op === 'put' && options.failFirstPuts !== undefined && putsSeen++ < options.failFirstPuts) return done(503, 'ServiceUnavailable', 'Please retry');

    const headers = { ...h, host: upstreamUrl.host };
    const forward = httpRequest({ host: upstreamUrl.hostname, port: upstreamUrl.port, method: req.method, path: req.url, headers }, (upRes) => {
      record(upRes.statusCode ?? 502);
      const outHeaders = { ...upRes.headers };
      if (op === 'put' && outHeaders.etag) {
        const bare = String(outHeaders.etag).replace(/"/g, '');
        if (options.etag === 'upper-unquoted') outHeaders.etag = bare.toUpperCase();
        if (options.etag === 'not-md5') outHeaders.etag = '"7d1a54127b222502f5b79b5fb0803061152a44f92b37e23c6527baf665d4da9a-1"';
        if (options.etag === 'wrong-md5') outHeaders.etag = `"${'0'.repeat(32)}"`;
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
    });
    forward.on('error', () => refuse(res, 502, 'BadGateway', 'upstream failed'));
    req.pipe(forward);
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
