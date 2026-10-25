import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3ObjectInspector, bucketIsMissing } from './storage';

/** A client whose single GET fails the way the SDK reports an S3 error: a name and, on the metadata, an HTTP status. */
const failing = (name: string, httpStatusCode: number): S3Client =>
  ({
    send: async () => {
      throw Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
    },
  }) as unknown as S3Client;
const inspect = (client: S3Client) => new S3ObjectInspector(client, 'bucket').inspect('reports/k', 'v1', { maxBytes: 10 });

describe('S3ObjectInspector: what counts as a missing object', () => {
  it.each([
    ['NoSuchKey', 404],
    ['NoSuchVersion', 404],
  ])('%s is a finding about the object: missing', async (name, status) => {
    await expect(inspect(failing(name, status))).resolves.toBe('missing');
  });

  // A wrong or deleted bucket says nothing about any report. If it were recorded as "missing" it would write a permanent finding for every report checked.
  it('NoSuchBucket (HTTP 404) is a failure to read, not a missing object', async () => {
    await expect(inspect(failing('NoSuchBucket', 404))).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });

  it.each([
    ['AccessDenied', 403],
    ['SlowDown', 503],
    ['InternalError', 500],
  ])('%s is a failure to read', async (name, status) => {
    await expect(inspect(failing(name, status))).rejects.toMatchObject({ name });
  });

  it('a 404 whose name is not one of the two is not trusted to mean the object is missing', async () => {
    await expect(inspect(failing('NotFound', 404))).rejects.toMatchObject({ name: 'NotFound' });
    await expect(inspect(failing('Unknown', 404))).rejects.toMatchObject({ name: 'Unknown' });
  });

  it('reads an object: size, hash and type (control: the happy path still works)', async () => {
    const body = (async function* () {
      yield new Uint8Array([1, 2, 3]);
    })();
    const client = { send: async () => ({ Body: body, ContentType: 'application/pdf' }) } as unknown as S3Client;
    await expect(inspect(client)).resolves.toMatchObject({ sizeBytes: 3, contentType: 'application/pdf', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe('bucketIsMissing: the start-up check that REPORTS_BUCKET names a bucket', () => {
  const check = (client: S3Client, timeoutMs?: number) => bucketIsMissing(client, 'bucket', timeoutMs);

  it('says so only when S3 answers NoSuchBucket', async () => {
    await expect(check(failing('NoSuchBucket', 404))).resolves.toBe(true);
  });

  // The worker's role cannot list, so a key that is not there may come back as NoSuchKey or as AccessDenied: either way the bucket answered. An outage or a hang
  // says nothing about the bucket and must not stop a worker from starting.
  it.each([
    ['NoSuchKey', 404],
    ['AccessDenied', 403],
    ['SlowDown', 503],
    ['InternalError', 500],
  ])('%s does not stop the worker', async (name, status) => {
    await expect(check(failing(name, status))).resolves.toBe(false);
  });

  it('does not stop the worker when S3 cannot be reached, or does not answer in time', async () => {
    await expect(
      check({
        send: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error', code: 'ECONNREFUSED' });
        },
      } as unknown as S3Client),
    ).resolves.toBe(false);
    const hangs = {
      send: (_c: unknown, o?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => o?.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    } as unknown as S3Client;
    await expect(check(hangs, 20)).resolves.toBe(false);
  });

  it('is false when the key happens to exist (control: a successful read is not a missing bucket)', async () => {
    await expect(check({ send: async () => ({ Body: undefined }) } as unknown as S3Client)).resolves.toBe(false);
  });

  it('asks about a key under reports/, the only prefix the worker role may read', async () => {
    const seen: string[] = [];
    await check({
      send: async (command: { input: { Key: string } }) => {
        seen.push(command.input.Key);
        throw Object.assign(new Error('x'), { name: 'NoSuchKey' });
      },
    } as unknown as S3Client);
    expect(seen[0]).toMatch(/^reports\//);
  });
});
