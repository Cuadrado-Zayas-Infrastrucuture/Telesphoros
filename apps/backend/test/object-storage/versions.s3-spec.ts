import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// What 3.2a relies on from the object store, proven against the S3-compatible server BEFORE any code is built on it (plan 12.1/12.4):
//   1. every write gets its own version id, including a second write through a still-valid upload link;
//   2. one GetObject response carries BOTH the bytes and the version id they came from;
//   3. naming a version returns exactly that version after the key has been overwritten, for streamed reads and for signed links;
//   4. a missing version FAILS; it never falls back to the latest;
//   5. an object written before versioning has no usable version id.
// Emulators do not verify signatures (see s3.s3-spec.ts); this proves version handling, not S3's signature enforcement.
const endpoint = process.env.TEST_S3_ENDPOINT!;
const versioned = `versioned-${randomBytes(5).toString('hex')}`;
const unversioned = `plain-${randomBytes(5).toString('hex')}`;
let client: S3Client;

beforeAll(async () => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true });
  await client.send(new CreateBucketCommand({ Bucket: versioned }));
  await client.send(new PutBucketVersioningCommand({ Bucket: versioned, VersioningConfiguration: { Status: 'Enabled' } }));
  await client.send(new CreateBucketCommand({ Bucket: unversioned }));
});

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function uploadUrl(bucket: string, key: string, size: number): Promise<string> {
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'application/pdf', ContentLength: size }), {
    expiresIn: 300,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
}
/** PUTs through a presigned URL exactly as a browser would, and returns the version id the server reported. */
async function put(url: string, bytes: Buffer): Promise<string | null> {
  const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
  expect(response.ok).toBe(true);
  return response.headers.get('x-amz-version-id');
}
/** One request, one response: the version id and the hash of the bytes of THAT response. */
async function read(bucket: string, key: string, versionId?: string): Promise<{ versionId: string | undefined; sha256: string; size: number }> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }));
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.Body as Readable) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { versionId: response.VersionId, sha256: hash.digest('hex'), size };
}

describe('object versions on a versioned bucket', () => {
  it('gives each write its own version id, even a second write through the same still-valid upload link', async () => {
    const key = `reports/t/${randomBytes(4).toString('hex')}/a`;
    const v1Bytes = randomBytes(2048);
    const v2Bytes = randomBytes(2048); // same length: a signed length does not stop an overwrite of the same size
    const url = await uploadUrl(versioned, key, v1Bytes.length);
    const v1 = await put(url, v1Bytes);
    const v2 = await put(url, v2Bytes);
    expect(v1).toEqual(expect.any(String));
    expect(v2).toEqual(expect.any(String));
    expect(v1).not.toBe(v2);
  });

  it('returns the version id and the bytes in the SAME response, and the id is the one the write reported', async () => {
    const key = `reports/t/${randomBytes(4).toString('hex')}/b`;
    const bytes = randomBytes(3 * 1024 * 1024); // several chunks
    const written = await put(await uploadUrl(versioned, key, bytes.length), bytes);
    const got = await read(versioned, key);
    expect(got.versionId).toBe(written);
    expect(got.sha256).toBe(sha(bytes));
  });

  it('serves exactly the named version after the key was overwritten (streamed read and signed link), and the unnamed read is the latest', async () => {
    const key = `reports/t/${randomBytes(4).toString('hex')}/c`;
    const v1Bytes = randomBytes(4096);
    const v2Bytes = randomBytes(4096);
    const url = await uploadUrl(versioned, key, v1Bytes.length);
    const v1 = (await put(url, v1Bytes))!;
    const v2 = (await put(url, v2Bytes))!;

    const named = await read(versioned, key, v1);
    expect(named).toEqual({ versionId: v1, sha256: sha(v1Bytes), size: v1Bytes.length });
    const latest = await read(versioned, key);
    expect(latest.versionId).toBe(v2); // the hazard: a read that does not name the version gets the overwrite
    expect(latest.sha256).toBe(sha(v2Bytes));

    const link = await getSignedUrl(client, new GetObjectCommand({ Bucket: versioned, Key: key, VersionId: v1 }), { expiresIn: 120 });
    expect(new URL(link).searchParams.get('versionId')).toBe(v1);
    const downloaded = Buffer.from(await (await fetch(link)).arrayBuffer());
    expect(sha(downloaded)).toBe(sha(v1Bytes));
  });

  it('fails for a version that is gone; neither the streamed read nor the signed link falls back to the latest', async () => {
    const key = `reports/t/${randomBytes(4).toString('hex')}/d`;
    const v1Bytes = randomBytes(1024);
    const v2Bytes = randomBytes(1024);
    const url = await uploadUrl(versioned, key, v1Bytes.length);
    const v1 = (await put(url, v1Bytes))!;
    await put(url, v2Bytes);
    await client.send(new DeleteObjectCommand({ Bucket: versioned, Key: key, VersionId: v1 })); // the break-glass act, done by the test

    await expect(read(versioned, key, v1)).rejects.toMatchObject({ $metadata: { httpStatusCode: expect.any(Number) } });
    const link = await getSignedUrl(client, new GetObjectCommand({ Bucket: versioned, Key: key, VersionId: v1 }), { expiresIn: 120 });
    const response = await fetch(link);
    expect(response.status).toBe(404);
    expect(sha(Buffer.from(await response.arrayBuffer()))).not.toBe(sha(v2Bytes));
    expect((await read(versioned, key)).sha256).toBe(sha(v2Bytes)); // control: the latest is still readable, so the failure above is specific to the version
  });

  it('fails for a version id that never existed', async () => {
    const key = `reports/t/${randomBytes(4).toString('hex')}/e`;
    const bytes = randomBytes(512);
    await put(await uploadUrl(versioned, key, bytes.length), bytes);
    await expect(read(versioned, key, 'no-such-version-id')).rejects.toBeDefined();
  });
});

describe('an object stored without versioning has no usable version id', () => {
  it('reports no version, or the literal "null"; either must be refused by the caller as unpinned', async () => {
    const key = `reports/t/${randomBytes(4).toString('hex')}/f`;
    const bytes = randomBytes(512);
    const written = await put(await uploadUrl(unversioned, key, bytes.length), bytes);
    const got = await read(unversioned, key);
    for (const id of [written, got.versionId]) expect(id === null || id === undefined || id === 'null').toBe(true);
  });
});
