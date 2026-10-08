import { createHash, randomBytes } from 'node:crypto';
import { CreateBucketCommand, DeleteObjectCommand, PutBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';
import { describeStorageContract } from '../helpers/storage-contract';

// The S3 implementation against the S3-compatible server. The same contract the in-memory store keeps (test/helpers/storage-contract.ts),
// plus what only a real server can show: the signed link serves the named version, and the unversioned "null" is never accepted as a pin.
const endpoint = process.env.TEST_S3_ENDPOINT!;
const versionedBucket = `v-${randomBytes(5).toString('hex')}`;
const plainBucket = `p-${randomBytes(5).toString('hex')}`;
let client: S3Client;
let versioned: S3ObjectStorage;
let unversioned: S3ObjectStorage;

beforeAll(async () => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true });
  await client.send(new CreateBucketCommand({ Bucket: versionedBucket }));
  await client.send(new PutBucketVersioningCommand({ Bucket: versionedBucket, VersioningConfiguration: { Status: 'Enabled' } }));
  await client.send(new CreateBucketCommand({ Bucket: plainBucket }));
  versioned = new S3ObjectStorage(client, versionedBucket, 300);
  unversioned = new S3ObjectStorage(client, plainBucket, 300);
});

async function upload(storage: S3ObjectStorage, key: string, bytes: Buffer): Promise<string | undefined> {
  const target = await storage.createUploadTarget({ key, contentType: 'application/pdf', sizeBytes: bytes.length });
  const response = await fetch(target.url, { method: 'PUT', headers: target.headers, body: bytes });
  expect(response.ok).toBe(true);
  const id = response.headers.get('x-amz-version-id');
  return id && id !== 'null' ? id : undefined;
}

describeStorageContract('S3ObjectStorage', () => ({
  versioned,
  unversioned,
  upload: (storage, key, bytes) => upload(storage as S3ObjectStorage, key, bytes),
  deleteVersion: async (storage, key, version) => {
    await client.send(new DeleteObjectCommand({ Bucket: storage === unversioned ? plainBucket : versionedBucket, Key: key, VersionId: version }));
  },
}));

describe('S3ObjectStorage: the signed download link', () => {
  it('serves the named version after the key was overwritten, and fails once that version is gone (no fallback to V2)', async () => {
    const key = `reports/t/${randomBytes(4).toString('hex')}/link`;
    const v1Bytes = randomBytes(2048);
    const v2Bytes = randomBytes(2048);
    const v1 = (await upload(versioned, key, v1Bytes))!;
    await upload(versioned, key, v2Bytes);
    const link = await versioned.createDownloadUrl(key, v1, 120);
    expect(new URL(link).searchParams.get('versionId')).toBe(v1);
    expect(new URL(link).searchParams.get('X-Amz-Expires')).toBe('120');
    const ok = await fetch(link);
    expect(createHash('sha256').update(Buffer.from(await ok.arrayBuffer())).digest('hex')).toBe(createHash('sha256').update(v1Bytes).digest('hex'));

    await client.send(new DeleteObjectCommand({ Bucket: versionedBucket, Key: key, VersionId: v1 }));
    const gone = await fetch(await versioned.createDownloadUrl(key, v1, 120));
    expect(gone.status).toBe(404);
  });
});
