import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ENV, type Env } from '../src/config/env';
import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { InMemoryObjectStorage } from '../src/object-storage/in-memory-object-storage';
import { ReportsRepository } from '../src/storage/reports.repository';
import { LAB_KNOWLEDGE, LAB_READER } from '../src/lab-reports/evaluations.service';
import { TextCaptureRunner } from '../src/lab-reports/runner/text-capture-runner';
import { createTestApp, usingS3 } from './helpers/app';
import { bearer, clinicianA, clinicianB, readerA, signToken } from './helpers/tokens';
const samples = [{ type: 'lab-pdf', mime: 'application/pdf', name: 'inert.pdf', bytes: Buffer.from('%PDF-1.7\nSynthetic opaque bytes\n%%EOF\n') }, { type: 'vcf', mime: 'text/x-vcf', name: 'inert.vcf', bytes: Buffer.from('##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n') }, { type: 'structured', mime: 'application/json', name: 'inert.json', bytes: Buffer.from('{"synthetic":true,"opaque":[1,2]}') }];
let app: NestExpressApplication;
let token: string;
const api = () => request(app.getHttpServer());
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
// Each case owns a fresh database and bucket, including intentional corruptions.
beforeEach(async () => { app = await createTestApp(); token = await clinicianA(); });
afterEach(async () => { await app.close(); });
async function registration(s = samples[0], bytes = s.bytes) { const patient = (await api().post('/api/v1/patients').set(bearer(token)).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body.id; return (await api().post('/api/v1/reports').set(bearer(token)).send({ patientId: patient, type: s.type, filename: s.name, sizeBytes: bytes.length }).expect(201)).body.id; }
async function declare(id: string, s = samples[0], bytes = s.bytes, requestId = randomUUID(), revision?: string) { revision ??= (await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token)).expect(200)).body.revision; return (await api().post(`/api/v1/reports/${id}/upload-attempts`).set(bearer(token)).send({ requestId, revision, contentType: s.mime, sha256: sha(bytes) }).expect(201)).body; }
function send(id: string, a: {
    attemptId: string;
    revision: string;
}, s = samples[0], bytes = s.bytes, t = token) { return api().put(`/api/v1/reports/${id}/upload-attempts/${a.attemptId}/bytes`).set(bearer(t)).set('X-Upload-Revision', a.revision).set('Content-Type', s.mime).send(s.mime === 'application/json' ? bytes.toString('utf8') : bytes); }
it.each(samples)('stores and retrieves exact $type bytes while clinical processing remains disabled', async (s) => {
    const id = await registration(s);
    const a = await declare(id, s);
    expect((await send(id, a, s).expect(200)).body.state).toBe('committed');
    const report = (await api().get(`/api/v1/reports/${id}`).set(bearer(token)).expect(200)).body;
    expect(report).toMatchObject({ fileUploaded: true, status: 'received', sha256: sha(s.bytes) });
    expect(report).not.toHaveProperty('storageKey');
    const link = await api().get(`/api/v1/reports/${id}/download-url`).set(bearer(token)).expect(200);
    expect(link.headers['cache-control']).toBe('private, no-store');
    if (usingS3()) {
        const r = await fetch(link.body.url);
        expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
        expect(r.headers.get('content-type')).toBe(s.mime);
        expect(sha(Buffer.from(await r.arrayBuffer()))).toBe(sha(s.bytes));
    }
    await api().post(`/api/v1/reports/${id}/capture`).set(bearer(token)).expect(503);
    for (const provider of [LAB_READER, LAB_KNOWLEDGE, TextCaptureRunner])
        expect(app.get(provider)).toBeUndefined();
    await api().post(`/api/v1/reports/${id}/upload-attempts/${a.attemptId}/resume`).set(bearer(token)).set('X-Upload-Revision', a.revision).expect(200);
});
it('refuses legacy write targets before storage while off', async () => { const id = await registration(); const storage = app.get(ObjectStorage); const target = jest.spyOn(storage, 'createUploadTarget'); const r = await api().post(`/api/v1/reports/${id}/upload-url`).set(bearer(token)).send({ contentType: samples[0].mime, sha256: sha(samples[0].bytes) }).expect(409); expect(r.body.error.details[0].reason).toBe('validated-intake-required'); expect(target).not.toHaveBeenCalled(); target.mockRestore(); });
it.each([{ ...samples[0], bytes: Buffer.from('<html>opaque</html>') }, { ...samples[1], bytes: Buffer.from('##fileformat=VCFv4.3\n#CHROM\tPOS\n') }, { ...samples[2], bytes: Buffer.from('{"x":}') }])('rejects malformed $type with zero S3 writes and cancels its lease', async (s) => {
    const id = await registration(s);
    const a = await declare(id, s);
    const storage = app.get(ObjectStorage);
    const put = jest.spyOn(storage, 'putStream');
    await send(id, a, s).expect(400);
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
    const row = await app.get(ReportsRepository).findAttempt({ tenantId: 'tenant-user-a', reportId: id, id: a.attemptId, principal: 'user-a', revision: a.revision });
    expect(row?.state).toBe('cleaned');
});
it('rejects stale/foreign revision, MIME/encoding mismatch, injected query, reader and foreign tenant', async () => { const id = await registration(); const a = await declare(id); await send(id, { ...a, revision: randomUUID() }).expect(404); await send(id, a, samples[0], samples[0].bytes, await readerA()).expect(403); await send(id, a, samples[0], samples[0].bytes, await clinicianB()).expect(404); await send(id, a).set('Content-Encoding', 'gzip').expect(400); await send(id, a).query({ ignored: 'x' }).expect(400); await api().get(`/api/v1/reports/${id}/download-url`).set(bearer(await readerA())).expect(403); });
it('declaration replay retains identity; a changed declaration invalidates the earlier revision', async () => { const id = await registration(); const requestId = randomUUID(); const rev = (await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token))).body.revision; const a = await declare(id, samples[0], samples[0].bytes, requestId, rev); const replay = await declare(id, samples[0], samples[0].bytes, requestId, rev); expect(replay.attemptId).toBe(a.attemptId); const b = await declare(id); expect(b.revision).not.toBe(a.revision); await send(id, a).expect(409); await send(id, b).expect(200); });
it('cancellation is idempotent and cannot cancel a committed pin', async () => { const id = await registration(); const a = await declare(id); const cancel = () => api().post(`/api/v1/reports/${id}/upload-attempts/${a.attemptId}/cancel`).set(bearer(token)).set('X-Upload-Revision', a.revision); expect((await cancel().expect(200)).body.state).toBe('cleaned'); expect((await cancel().expect(200)).body.state).toBe('cleaned'); await send(id, a).expect(409); const next = await declare(id); await send(id, next).expect(200); const r = await api().post(`/api/v1/reports/${id}/upload-attempts/${next.attemptId}/cancel`).set(bearer(token)).set('X-Upload-Revision', next.revision).expect(200); expect(r.body.state).toBe('committed'); });
it('freezes the verified type and preserves permissible name correction', async () => { const id = await registration(); const a = await declare(id); await send(id, a).expect(200); await api().patch(`/api/v1/reports/${id}`).set(bearer(token)).send({ type: 'structured', filename: 'changed.json' }).expect(409); await api().patch(`/api/v1/reports/${id}`).set(bearer(token)).send({ filename: 'corrected.pdf' }).expect(200); });
it('preserves the exact pin when a newer object exists, then refuses a missing pinned version', async () => {
    const id = await registration();
    const a = await declare(id);
    await send(id, a).expect(200);
    const row = (await app.get(ReportsRepository).findById('tenant-user-a', id))!;
    if (usingS3()) {
        const env = app.get<Env>(ENV);
        const client = new S3Client({ region: 'us-east-2', endpoint: env.S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test' } });
        try {
            await client.send(new PutObjectCommand({ Bucket: env.REPORTS_BUCKET, Key: row.storageKey!, Body: Buffer.from('NEW'), ContentType: 'application/json' }));
            await client.send(new DeleteObjectCommand({ Bucket: env.REPORTS_BUCKET, Key: row.storageKey! }));
            await api().get(`/api/v1/reports/${id}/download-url`).set(bearer(token)).expect(200);
            await client.send(new DeleteObjectCommand({ Bucket: env.REPORTS_BUCKET, Key: row.storageKey!, VersionId: row.objectVersion! }));
        }
        finally {
            client.destroy();
        }
    }
    else {
        const storage = app.get(ObjectStorage) as InMemoryObjectStorage;
        storage.put(row.storageKey!, Buffer.from('NEW'), samples[0].mime);
        await api().get(`/api/v1/reports/${id}/download-url`).set(bearer(token)).expect(200);
        storage.deleteVersion(row.storageKey!, row.objectVersion!);
    }
    await api().get(`/api/v1/reports/${id}/download-url`).set(bearer(token)).expect(409);
});
it('requires authentication before reading raw bytes', async () => { await api().put(`/api/v1/reports/${randomUUID()}/upload-attempts/${randomUUID()}/bytes`).set('Content-Type', 'application/pdf').send(samples[0].bytes).expect(401); });
it('allows reviewer file access but never intake', async () => { const reviewer = await signToken({ sub: 'reviewer-local', tenant: 'tenant-user-a', roles: ['reviewer'] }); const id = await registration(); const a = await declare(id); await send(id, a).expect(200); await api().get(`/api/v1/reports/${id}/download-url`).set(bearer(reviewer)).expect(200); await send(id, a, samples[0], samples[0].bytes, reviewer).expect(403); });
it.each(['short', 'oversize', 'checksum'])('rejects %s bytes before storage and releases the safely quiesced reservation', async (failure) => { const id = await registration(); const a = await declare(id); const storage = app.get(ObjectStorage); const put = jest.spyOn(storage, 'putStream'); const bytes = failure === 'short' ? samples[0].bytes.subarray(0, -1) : failure === 'oversize' ? Buffer.concat([samples[0].bytes, Buffer.from(' ')]) : Buffer.from(samples[0].bytes.toString().replace('Synthetic', 'synthetic')); await send(id, a, samples[0], bytes).expect(400); expect(put).not.toHaveBeenCalled(); put.mockRestore(); const run = (await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token)).expect(200)).body.run; expect(run.pendingBytes).toBe(0); });

it('replay rejects a changed original revision even with the same request/file identity',async()=>{const id=await registration();const original=(await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token)).expect(200)).body.revision;const requestId=randomUUID();const a=await declare(id,samples[0],samples[0].bytes,requestId,original);await api().post(`/api/v1/reports/${id}/upload-attempts`).set(bearer(token)).send({requestId,revision:a.revision,contentType:samples[0].mime,sha256:sha(samples[0].bytes)}).expect(409);const replay=await declare(id,samples[0],samples[0].bytes,requestId,original);expect(replay.attemptId).toBe(a.attemptId);await send(id,a).expect(200);});

it('refuses a raw MIME mismatch before leasing a writer or writing bytes',async()=>{const id=await registration();const a=await declare(id);const storage=app.get(ObjectStorage);const put=jest.spyOn(storage,'putStream');await send(id,a).set('Content-Type','application/json').expect(400);expect(put).not.toHaveBeenCalled();const row=await app.get(ReportsRepository).findAttempt({tenantId:'tenant-user-a',principal:'user-a',reportId:id,id:a.attemptId,revision:a.revision});expect(row).toMatchObject({state:'declared',writer:null});put.mockRestore();});
