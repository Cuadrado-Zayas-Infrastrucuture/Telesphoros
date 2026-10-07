import { createHash, randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { reportDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { InMemoryObjectStorage } from '../src/object-storage/in-memory-object-storage';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { createTestApp, usingS3 } from './helpers/app';
import { bearer, clinicianA, clinicianB, readerA } from './helpers/tokens';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const VCF = Buffer.from('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\n1\t100\t.\tA\tG\n');
const VCF_TYPE = 'text/x-vcf';

async function newReport(token: string, sizeBytes = VCF.length) {
  const patientId = (await api().post('/api/v1/patients').set(bearer(token)).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body.id;
  return (await api().post('/api/v1/reports').set(bearer(token)).send({ patientId, type: 'vcf', filename: 'sample.vcf', sizeBytes }).expect(201)).body.id as string;
}
const uploadUrl = (token: string, id: string, body: object = { contentType: VCF_TYPE, sha256: sha(VCF) }) =>
  api().post(`/api/v1/reports/${id}/upload-url`).set(bearer(token)).send(body);
const complete = (token: string, id: string) => api().post(`/api/v1/reports/${id}/complete`).set(bearer(token));

/** What the browser does: PUT the bytes straight to the URL with the headers it was given. */
async function putFile(target: { uploadUrl: string; headers: Record<string, string> }, bytes: Buffer) {
  if (target.uploadUrl.startsWith('memory://')) {
    const key = target.uploadUrl.replace('memory://reports/', '');
    (app.get(ObjectStorage) as InMemoryObjectStorage).put(key, bytes, target.headers['Content-Type']!);
    return;
  }
  const res = await fetch(target.uploadUrl, { method: 'PUT', headers: target.headers, body: bytes });
  expect(res.ok).toBe(true);
}

describe('report upload: the happy path', () => {
  it('registers, gets a URL, uploads directly, and the server verifies and marks it uploaded', async () => {
    const a = await clinicianA();
    const id = await newReport(a);

    const before = await api().get(`/api/v1/reports/${id}`).set(bearer(a)).expect(200);
    expect(before.body.fileUploaded).toBe(false);

    const url = await uploadUrl(a, id).expect(200);
    expect(url.body.method).toBe('PUT');
    expect(url.body.headers['Content-Type']).toBe(VCF_TYPE);
    const expires = Date.parse(url.body.expiresAt) - Date.now();
    expect(expires).toBeGreaterThan(0);
    expect(expires).toBeLessThanOrEqual(300_000);

    await putFile(url.body, VCF);
    const done = await complete(a, id).expect(200);
    expect(reportDtoSchema.safeParse(done.body).success).toBe(true);
    expect(done.body).toMatchObject({ fileUploaded: true, sha256: sha(VCF), contentType: VCF_TYPE, status: 'received' });

    // The public shape never reveals where the file lives or who owns it.
    expect(Object.keys(done.body).sort()).toEqual(
      ['contentType', 'createdAt', 'fileUploaded', 'filename', 'id', 'patientId', 'sha256', 'sizeBytes', 'status', 'type', 'updatedAt'],
    );
    expect(JSON.stringify(done.body)).not.toMatch(/owner|user-a|reports\//);
  });

  it('is idempotent: completing twice is fine, but a second upload URL is refused', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    await putFile((await uploadUrl(a, id).expect(200)).body, VCF);
    await complete(a, id).expect(200);
    await complete(a, id).expect(200);
    const again = await uploadUrl(a, id).expect(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('allows asking for the URL again before the upload happens', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    await uploadUrl(a, id).expect(200);
    await putFile((await uploadUrl(a, id).expect(200)).body, VCF);
    await complete(a, id).expect(200);
  });

  (usingS3() ? it : it.skip)('stores exactly one object under reports/<owner hash>/<report id>/ with no raw owner id in the key', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    await putFile((await uploadUrl(a, id).expect(200)).body, VCF);
    await complete(a, id).expect(200);
    const listing = await new S3Client({ region: 'us-east-1', endpoint: process.env.TEST_S3_ENDPOINT, forcePathStyle: true }).send(
      new ListObjectsV2Command({ Bucket: (app.get(ObjectStorage) as unknown as { bucket: string }).bucket, Prefix: 'reports/' }),
    );
    const keys = (listing.Contents ?? []).map((o) => o.Key!).filter((k) => k.includes(`/${id}/`));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^reports/[0-9a-f]{32}/${id}/[0-9a-f-]{36}$`));
    expect(keys[0]).not.toContain('user-a');
  });
});

describe('report upload: the server does not take the client’s word', () => {
  it('rejects completion before any URL was requested, and before any bytes arrived', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    expect((await complete(a, id).expect(409)).body.error.message).toMatch(/upload URL/i);
    await uploadUrl(a, id).expect(200);
    expect((await complete(a, id).expect(409)).body.error.message).toMatch(/not been uploaded/i);
  });

  it('rejects a file whose checksum differs from the declared one (same size, different bytes)', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    const tampered = Buffer.from(VCF);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0xff;
    await putFile((await uploadUrl(a, id).expect(200)).body, tampered);
    const res = await complete(a, id).expect(409);
    expect(res.body.error.message).toMatch(/checksum/i);
    expect((await api().get(`/api/v1/reports/${id}`).set(bearer(a))).body.fileUploaded).toBe(false);
  });

  it('rejects a file whose size differs from the declared one', async () => {
    const a = await clinicianA();
    const id = await newReport(a, VCF.length + 50);
    await putFile((await uploadUrl(a, id).expect(200)).body, VCF);
    expect((await complete(a, id).expect(409)).body.error.message).toMatch(/size/i);
  });
});

describe('report upload: validation, roles and ownership', () => {
  it('rejects a content type that does not suit the report type, a bad checksum, and unknown fields', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    const wrongType = await uploadUrl(a, id, { contentType: 'application/json', sha256: sha(VCF) }).expect(400);
    expect(wrongType.body.error.details[0].field).toBe('contentType');
    await uploadUrl(a, id, { contentType: VCF_TYPE, sha256: sha(VCF).toUpperCase() }).expect(400);
    await uploadUrl(a, id, { contentType: VCF_TYPE, sha256: 'abc' }).expect(400);
    await uploadUrl(a, id, { contentType: VCF_TYPE, sha256: sha(VCF), storageKey: 'reports/x' }).expect(400);
    await uploadUrl(a, id, {}).expect(400);
  });

  it('forbids a reader, and hides another user’s report (404) on both endpoints', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    expect((await uploadUrl(await readerA(), id).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await complete(await readerA(), id).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await uploadUrl(await clinicianB(), id).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await complete(await clinicianB(), id).expect(404)).body.error.code).toBe('NOT_FOUND');
    await api().post(`/api/v1/reports/${randomUUID()}/upload-url`).set(bearer(a)).send({ contentType: VCF_TYPE, sha256: sha(VCF) }).expect(404);
    await api().post('/api/v1/reports/not-a-uuid/complete').set(bearer(a)).expect(400);
  });

  it('requires authentication', async () => {
    await api().post(`/api/v1/reports/${randomUUID()}/upload-url`).send({}).expect(401);
    await api().post(`/api/v1/reports/${randomUUID()}/complete`).expect(401);
  });
});
