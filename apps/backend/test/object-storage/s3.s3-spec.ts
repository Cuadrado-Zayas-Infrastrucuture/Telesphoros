import { createHash, randomBytes } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { MAX_REPORT_BYTES } from '@telesphoros/shared-types';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';

// Runs against an S3-compatible server (MinIO or an emulator), selected by TEST_S3_ENDPOINT.
// NOTE: emulators do not verify AWS signatures, so these tests prove URL SHAPE and byte handling,
// not that real S3 rejects a tampered signature. That enforcement is S3's own.
const endpoint = process.env.TEST_S3_ENDPOINT!;
const bucket = `adapter-${randomBytes(5).toString('hex')}`;
let client: S3Client;
let storage: S3ObjectStorage;

beforeAll(async () => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  storage = new S3ObjectStorage(client, bucket);
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function upload(key: string, bytes: Buffer, contentType: string) {
  await storage.putObject(key, bytes, contentType);
}

describe('S3ObjectStorage', () => {
  it('inspects an uploaded object: size, content type and a SHA-256 computed by streaming', async () => {
    const bytes = randomBytes(3 * 1024 * 1024); // multi-chunk
    await upload('reports/t/1/a', bytes, 'text/x-vcf');
    expect(await storage.inspect('reports/t/1/a')).toEqual({ sizeBytes: bytes.length, contentType: 'text/x-vcf', sha256: sha(bytes) });
  });

  it('returns undefined for an object that does not exist', async () => {
    expect(await storage.inspect('reports/t/1/missing')).toBeUndefined();
  });

  it('stops reading an oversized object instead of pulling it all in', async () => {
    const huge = randomBytes(MAX_REPORT_BYTES + 1024 * 1024);
    await upload('reports/t/1/huge', huge, 'text/plain');
    const inspected = await storage.inspect('reports/t/1/huge');
    expect(inspected!.sizeBytes).toBeGreaterThan(MAX_REPORT_BYTES);
    expect(inspected!.sizeBytes).toBeLessThan(huge.length); // it bailed out early
  });
});
