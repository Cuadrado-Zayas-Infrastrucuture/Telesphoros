import * as http from 'node:http';
import { type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Audit item 26 feared that the SDK's default retry, after a lost reply to an upload, would send the upload again and get 412 from `If-None-Match: *`,
 * leaving an orphan. Measured here against a local server that receives the whole body and then drops the connection (so the reply is lost): the SDK
 * does NOT resend a streamed body (the upload path, `putStream`), and does resend a buffered one (`putObject`, which has no precondition and writes the
 * same bytes again). So the application client keeps the SDK's default `maxAttempts`. This test pins what was measured: if an SDK upgrade starts
 * resending streams, it fails and the audit's concern has to be looked at again.
 */
function lostReplyServer() {
  const seen: Array<{ bytes: number; ifNoneMatch: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    req.on('end', () => {
      seen.push({ bytes, ifNoneMatch: req.headers['if-none-match'] as string | undefined });
      if (seen.length === 1) {
        req.socket.destroy(); // the object arrived; the reply never does
        return;
      }
      res.statusCode = 200;
      res.setHeader('ETag', '"synthetic"');
      res.end();
    });
  });
  return { server, seen };
}

async function put(body: () => Readable | Buffer, ifNoneMatch: boolean): Promise<{ seen: Array<{ bytes: number; ifNoneMatch: string | undefined }>; outcome: 'ok' | 'error' }> {
  const { server, seen } = lostReplyServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new S3Client({
    region: 'us-east-2', endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, forcePathStyle: true,
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, retryMode: 'standard',
  });
  try {
    await client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: body(), ContentLength: 1000, ...(ifNoneMatch ? { IfNoneMatch: '*' } : {}) }), { abortSignal: AbortSignal.timeout(8000) });
    return { seen, outcome: 'ok' };
  } catch {
    return { seen, outcome: 'error' };
  } finally {
    server.closeAllConnections();
    server.close();
    client.destroy();
  }
}

describe('the SDK after a reply to an upload is lost (default retry settings)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does not send a streamed upload (If-None-Match: *) a second time', async () => {
    const result = await put(() => Readable.from([Buffer.alloc(1000)]), true);
    expect(result.seen).toHaveLength(1);
    expect(result.outcome).toBe('error');
  }, 15_000);

  it('does send a buffered upload again, with the same bytes (control: retry is on, and the body can be replayed)', async () => {
    const result = await put(() => Buffer.alloc(1000), false);
    expect(result.seen.map((s) => s.bytes)).toEqual([1000, 1000]);
    expect(result.outcome).toBe('ok');
  }, 15_000);
});
