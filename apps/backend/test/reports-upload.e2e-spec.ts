import { createHash, randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { reportDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { createTestApp, usingS3 } from './helpers/app';
import { bearer, clinicianA, clinicianB, readerA } from './helpers/tokens';

// The only way a report file is stored: the validated intake (declare, send the bytes, the server validates and pins). Since M2.2b the direct-upload
// routes (`upload-url`, `complete`) no longer exist. Runs on memory, PostgreSQL and PostgreSQL plus S3.
let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp({ organizationIntake: true });
});
afterAll(async () => {
  await app?.close();
});

const api = () => request(app.getHttpServer());
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Ends in a digit so the tamper test below (flip the second-to-last byte) still sends well-formed JSON and is refused on its checksum.
const SAMPLE = Buffer.from('{"synthetic":true,"values":[1,2,3],"n":7}');
const SAMPLE_TYPE = 'application/json';

async function newReport(token: string, sizeBytes = SAMPLE.length) {
  const patientId = (
    await api()
      .post('/api/v1/patients')
      .set(bearer(token))
      .send({ label: `SYN-${randomUUID().slice(0, 8)}` })
      .expect(201)
  ).body.id;
  return (await api().post('/api/v1/reports').set(bearer(token)).send({ patientId, type: 'structured', filename: 'sample.json', sizeBytes }).expect(201)).body.id as string;
}
const stateOf = async (token: string, id: string) => (await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token)).expect(200)).body.revision as string;
const declareReq = async (token: string, id: string, body: object = { contentType: SAMPLE_TYPE, sha256: sha(SAMPLE) }) =>
  api()
    .post(`/api/v1/reports/${id}/upload-attempts`)
    .set(bearer(token))
    .send({ requestId: randomUUID(), revision: await stateOf(token, id), ...body });
const sendBytes = (token: string, id: string, a: { attemptId: string; revision: string }, bytes = SAMPLE) =>
  api()
    .put(`/api/v1/reports/${id}/upload-attempts/${a.attemptId}/bytes`)
    .set(bearer(token))
    .set('X-Upload-Revision', a.revision)
    .set('Content-Type', SAMPLE_TYPE)
    .send(bytes.toString('utf8'));
async function upload(token: string, id: string, bytes = SAMPLE, declared = bytes) {
  const a = (await (await declareReq(token, id, { contentType: SAMPLE_TYPE, sha256: sha(declared) })).body) as { attemptId: string; revision: string };
  return { a, res: await sendBytes(token, id, a, bytes) };
}

describe('report upload through the validated intake: the happy path', () => {
  it('registers, declares, sends the bytes, and the server validates, pins and marks it uploaded', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    expect((await api().get(`/api/v1/reports/${id}`).set(bearer(a)).expect(200)).body.fileUploaded).toBe(false);

    const { res } = await upload(a, id);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    const done = await api().get(`/api/v1/reports/${id}`).set(bearer(a)).expect(200);
    expect(reportDtoSchema.safeParse(done.body).success).toBe(true);
    expect(done.body).toMatchObject({ fileUploaded: true, sha256: sha(SAMPLE), contentType: SAMPLE_TYPE, status: 'received' });

    // The public shape never reveals where the file lives or who owns it.
    expect(Object.keys(done.body).sort()).toEqual([
      'contentType',
      'createdAt',
      'fileUploaded',
      'filename',
      'id',
      'patientId',
      'sha256',
      'sizeBytes',
      'status',
      'type',
      'updatedAt',
    ]);
    expect(JSON.stringify(done.body)).not.toMatch(/owner|tenant|created_?by|user-a|reports\//);
  });

  it('is idempotent: resuming a committed attempt is fine, a second attempt for an uploaded report is refused', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    const { a: attempt } = await upload(a, id);
    const resume = () => api().post(`/api/v1/reports/${id}/upload-attempts/${attempt.attemptId}/resume`).set(bearer(a)).set('X-Upload-Revision', attempt.revision);
    expect((await resume().expect(200)).body.state).toBe('committed');
    expect((await resume().expect(200)).body.state).toBe('committed');
    const again = await declareReq(a, id);
    expect(again.status).toBe(409);
  });

  (usingS3() ? it : it.skip)('stores exactly one object under reports/<tenant hash>/<report id>/intake/ with no raw tenant id in the key', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    await upload(a, id);
    const listing = await new S3Client({ region: 'us-east-1', endpoint: process.env.TEST_S3_ENDPOINT, forcePathStyle: true }).send(
      new ListObjectsV2Command({ Bucket: (app.get(ObjectStorage) as unknown as { bucket: string }).bucket, Prefix: 'reports/' }),
    );
    const keys = (listing.Contents ?? []).map((o) => o.Key!).filter((k) => k.includes(`/${id}/`));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^reports/[0-9a-f]{32}/${id}/intake/[0-9a-f-]{36}$`));
    expect(keys[0]).not.toContain('user-a');
  });
});

describe('report upload through the validated intake: the server does not take the client’s word', () => {
  it('rejects a file whose checksum differs from the declared one (same size, different bytes) and stores nothing', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    const tampered = Buffer.from(SAMPLE);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0x01;
    const { res } = await upload(a, id, tampered, SAMPLE);
    expect(res.status).toBe(400);
    expect((await api().get(`/api/v1/reports/${id}`).set(bearer(a))).body.fileUploaded).toBe(false);
  });

  it('rejects a file whose size differs from the declared one', async () => {
    const a = await clinicianA();
    const id = await newReport(a, SAMPLE.length + 50);
    const { res } = await upload(a, id);
    expect(res.status).toBe(400);
    expect((await api().get(`/api/v1/reports/${id}`).set(bearer(a))).body.fileUploaded).toBe(false);
  });

  it('control: the same file with the right declared size and checksum is accepted', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    expect((await upload(a, id)).res.status).toBe(200);
  });
});

describe('report upload through the validated intake: validation, roles and ownership', () => {
  it('rejects a content type that does not suit the report type, a bad checksum, and unknown fields', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    const wrongType = await declareReq(a, id, { contentType: 'application/pdf', sha256: sha(SAMPLE) });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.details[0].field).toBe('contentType');
    expect((await declareReq(a, id, { contentType: SAMPLE_TYPE, sha256: sha(SAMPLE).toUpperCase() })).status).toBe(400);
    expect((await declareReq(a, id, { contentType: SAMPLE_TYPE, sha256: 'abc' })).status).toBe(400);
    expect((await declareReq(a, id, { contentType: SAMPLE_TYPE, sha256: sha(SAMPLE), storageKey: 'reports/x' })).status).toBe(400);
    expect((await declareReq(a, id, { contentType: undefined, sha256: undefined })).status).toBe(400);
    expect((await declareReq(a, id)).status).toBe(201); // control
  });

  it('forbids a reader, and hides another organization’s report (404) on the intake routes', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    const body = { requestId: randomUUID(), revision: await stateOf(a, id), contentType: SAMPLE_TYPE, sha256: sha(SAMPLE) };
    const declare = (token: string, target = id) => api().post(`/api/v1/reports/${target}/upload-attempts`).set(bearer(token)).send(body);
    expect((await declare(await readerA())).status).toBe(403);
    expect((await declare(await clinicianB())).status).toBe(404);
    expect((await declare(a, randomUUID())).status).toBe(404);
    await api().post('/api/v1/reports/not-a-uuid/upload-attempts').set(bearer(a)).send(body).expect(400);
  });

  it('requires authentication', async () => {
    await api().post(`/api/v1/reports/${randomUUID()}/upload-attempts`).send({}).expect(401);
    await api().get(`/api/v1/reports/${randomUUID()}/upload-state`).expect(401);
  });
});

describe('the direct-upload routes are gone (M2.2b)', () => {
  it('answers 404 to the old upload-link and completion routes, signed in or not, for a real report or not', async () => {
    const a = await clinicianA();
    const id = await newReport(a);
    for (const token of [a, undefined]) {
      for (const [path, body] of [
        [`/api/v1/reports/${id}/upload-url`, { contentType: SAMPLE_TYPE, sha256: sha(SAMPLE) }],
        [`/api/v1/reports/${id}/complete`, {}],
      ] as const) {
        const req = api().post(path);
        const res = await (token ? req.set(bearer(token)) : req).send(body);
        expect(res.status).toBe(404);
      }
    }
    expect((await api().get(`/api/v1/reports/${id}`).set(bearer(a)).expect(200)).body.fileUploaded).toBe(false);
  });
});
