import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Synthetic permission boundary, NOT proof of AWS IAM or signature verification. */
export async function recoveryGateway(upstream: string, allowedBuckets: string[], recoveryBucket: string) {
  const target = new URL(upstream);
  if (target.hostname !== '127.0.0.1') throw new Error('Recovery gateway requires loopback storage.');
  const requests: { bucket: string; method: string; reader: boolean; object: boolean; pinned: boolean; status: number }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const bucket = url.pathname.split('/')[1];
    const caller = /Credential=([^/,\s=]+)\//.exec(String(req.headers.authorization ?? ''))?.[1] ?? url.searchParams.get('X-Amz-Credential')?.split('/')[0];
    const reader = caller === 'SYNRECOVERYREADER';
    const record = (status: number) =>
      requests.push({ bucket, method: req.method ?? '', reader, object: url.pathname.split('/').filter(Boolean).length > 1, pinned: url.searchParams.has('versionId'), status });
    const allowed = reader
      ? req.method === 'GET' && allowedBuckets.includes(bucket)
      : caller === 'SYNRECOVERYAPP'
        ? req.method === 'GET' && bucket === recoveryBucket
        : caller === 'SYNRECOVERYLOADER' && ['GET', 'PUT'].includes(req.method ?? '') && bucket === recoveryBucket;
    if (!allowed) {
      record(403);
      req.resume();
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>AccessDenied</Code><Message>Synthetic recovery boundary refused.</Message></Error>');
      return;
    }
    const forward = request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (response) => {
      record(response.statusCode ?? 502);
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    forward.setTimeout(30_000, () => forward.destroy());
    forward.on('error', () => {
      if (!res.headersSent) {
        record(502);
        res.writeHead(502);
      }
      res.end();
    });
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
