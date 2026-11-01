import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStorage } from './s3-object-storage';

/** A controllable deadline against a real SDK socket, not a mocked send(). No cloud credentials or retries. */
it.each(['buffered write', 'streamed write', 'streamed read', 'versioning'] as const)('bounds a stalled %s even when a caller supplies a non-expiring signal', async (kind) => {
  let arrived!: () => void;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    req.on('end', () => {
      if (kind === 'streamed read') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-amz-version-id': 'synthetic-version' });
        res.write('{'); // headers arrive, but the response body never completes
      }
      arrived();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    maxAttempts: 1,
  });
  const deadline = new AbortController();
  const external = new AbortController();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  let watchdog: NodeJS.Timeout | undefined;
  const safety = new Promise<never>((_resolve, reject) => {
    watchdog = setTimeout(() => reject(new Error('Operation ignored its deadline')), 2000);
  });
  const storage = new S3ObjectStorage(client, 'synthetic');
  const operation =
    kind === 'buffered write'
      ? storage.putObject('key', Buffer.from('{}'), 'application/json')
      : kind === 'streamed write'
        ? storage.putStream('key', Readable.from(['{}']), 'application/json', 2, external.signal)
        : kind === 'streamed read'
          ? storage.inspect('key', { signal: external.signal })
          : storage.versioningEnabled();
  // Handle rejection immediately, including a connection failure before the fixture receives a request.
  const outcome = operation.then(
    () => 'resolved',
    (error: unknown) => error,
  );
  try {
    await Promise.race([received, safety]);
    deadline.abort();
    const error = await Promise.race([outcome, safety]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/abort|deadline/i);
    expect(external.signal.aborted).toBe(false);
    expect(requests).toBe(1);
  } finally {
    clearTimeout(watchdog);
    timeout.mockRestore();
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await outcome;
  }
});
