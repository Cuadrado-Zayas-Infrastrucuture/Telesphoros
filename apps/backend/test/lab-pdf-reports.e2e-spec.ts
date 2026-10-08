import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { InMemoryObjectStorage } from '../src/object-storage/in-memory-object-storage';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { captureFor, type SeededReport } from './helpers/ledger-fixtures';
import { bearer, signToken } from './helpers/tokens';

// lab-pdf reports on the EXISTING report routes (slice 5B-3.2a). The pipeline endpoints themselves arrive in 3.2b.
// The lab-pdf type needs the PostgreSQL store when the switch is on, so the enabled half runs in the database tiers only.

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const PDF = Buffer.from('%PDF-1.4\nsynthetic test file, not a real lab report\n%%EOF\n');
const PDF2 = Buffer.from('%PDF-1.4\nsynthetic test file, DIFFERENT BYTES  here\n%%EOF\n');
const PDF_TYPE = 'application/pdf';
const tenantToken = (sub: string, roles: string[], tenant = 'tenant-lab') => signToken({ sub, roles, tenant });

function api(app: NestExpressApplication) {
  return request(app.getHttpServer());
}
async function newPatient(app: NestExpressApplication, token: string) {
  return (await api(app).post('/api/v1/patients').set(bearer(token)).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body.id as string;
}
const createReport = (app: NestExpressApplication, token: string, patientId: string, over: object = {}) =>
  api(app).post('/api/v1/reports').set(bearer(token)).send({ patientId, type: 'lab-pdf', filename: 'sample.pdf', sizeBytes: PDF.length, ...over });

describe('lab-pdf reports: the pipeline switch is OFF (the default)', () => {
  let app: NestExpressApplication;
  let storageCalls: string[];
  beforeAll(async () => {
    app = await createTestApp();
    storageCalls = [];
    const storage = app.get(ObjectStorage);
    for (const method of ['createUploadTarget', 'inspect', 'getObject', 'putObject', 'createDownloadUrl'] as const) {
      const original = (storage[method] as (...args: unknown[]) => unknown).bind(storage);
      (storage as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        storageCalls.push(method);
        return original(...args);
      };
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('answers 503 PIPELINE_DISABLED to a signed-in clinician creating a lab-pdf, with no Retry-After, and writes nothing', async () => {
    const token = await tenantToken('clin-1', ['clinician']);
    const patientId = await newPatient(app, token);
    const res = await createReport(app, token, patientId).expect(503);
    expect(res.body.error).toMatchObject({ code: 'PIPELINE_DISABLED' });
    expect(res.headers['retry-after']).toBeUndefined();
    expect((await api(app).get('/api/v1/reports').set(bearer(token)).expect(200)).body.data).toEqual([]);
    expect(storageCalls).toEqual([]);
  });

  it('tells nothing to someone who is not allowed in: 401 without a token, 403 without a writing role (never 503)', async () => {
    const patientId = await newPatient(app, await tenantToken('clin-1', ['clinician']));
    await api(app).post('/api/v1/reports').send({ patientId, type: 'lab-pdf', filename: 'a.pdf', sizeBytes: 5 }).expect(401);
    for (const roles of [['reader'], ['reviewer'], []]) {
      const res = await createReport(app, await tenantToken('someone', roles), patientId).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it.each([
    [['reader'], 403],
    [['reviewer'], 403],
    [['clinician'], 201],
    [['admin'], 201],
    [['clinician', 'reviewer'], 201],
    [['admin', 'reviewer'], 201],
  ] as const)('with the roles %j, creating a (vcf) report answers %i: the whole set of roles counts, and reviewer alone never writes', async (roles, status) => {
    const writer = await tenantToken('clin-1', ['clinician']);
    const patientId = await newPatient(app, writer);
    const token = await tenantToken(`person-${roles.join('-')}`, [...roles]);
    await createReport(app, token, patientId, { type: 'vcf', filename: 'a.vcf' }).expect(status);
  });

  it('reports every role a person holds, reviewer included', async () => {
    const me = await api(app).get('/api/v1/me').set(bearer(await tenantToken('rev', ['clinician', 'reviewer']))).expect(200);
    expect(me.body.roles).toEqual(['clinician', 'reviewer']);
  });

  it('leaves vcf and structured reports exactly as they were', async () => {
    const token = await tenantToken('clin-1', ['clinician']);
    const patientId = await newPatient(app, token);
    await createReport(app, token, patientId, { type: 'vcf', filename: 'a.vcf' }).expect(201);
    await createReport(app, token, patientId, { type: 'structured', filename: 'a.json' }).expect(201);
  });

  it('keeps a file name and its type together on create (a .pdf is never a "vcf", a lab-pdf is never a .vcf)', async () => {
    const token = await tenantToken('clin-1', ['clinician']);
    const patientId = await newPatient(app, token);
    for (const bad of [{ type: 'vcf', filename: 'a.pdf' }, { type: 'structured', filename: 'a.pdf' }, { type: 'lab-pdf', filename: 'a.vcf' }]) {
      const res = await createReport(app, token, patientId, bad).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('refuses to turn an existing report into a lab-pdf while off, and nothing touched storage', async () => {
    const token = await tenantToken('clin-1', ['clinician']);
    const patientId = await newPatient(app, token);
    const id = (await createReport(app, token, patientId, { type: 'vcf', filename: 'a.vcf' }).expect(201)).body.id;
    const res = await api(app).patch(`/api/v1/reports/${id}`).set(bearer(token)).send({ type: 'lab-pdf', filename: 'a.pdf' }).expect(503);
    expect(res.body.error.code).toBe('PIPELINE_DISABLED');
    expect((await api(app).get(`/api/v1/reports/${id}`).set(bearer(token))).body).toMatchObject({ type: 'vcf', filename: 'a.vcf' });
    expect(storageCalls).toEqual([]);
  });
});

(usingPostgres() ? describe : describe.skip)('lab-pdf reports: the pipeline switch is ON', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  const uploadUrl = (token: string, id: string, body: object = { contentType: PDF_TYPE, sha256: sha(PDF) }) =>
    api(app).post(`/api/v1/reports/${id}/upload-url`).set(bearer(token)).send(body);
  const complete = (token: string, id: string) => api(app).post(`/api/v1/reports/${id}/complete`).set(bearer(token));
  const row = (id: string) => withAdmin(db.adminUrl, async (c) => (await c.query(`SELECT * FROM reports WHERE id = $1`, [id])).rows[0]);

  /** What the browser does: PUT the bytes straight to the URL with the headers it was given. Returns the version the store reported. */
  async function put(target: { uploadUrl: string; headers: Record<string, string> }, bytes: Buffer): Promise<string | undefined> {
    if (target.uploadUrl.startsWith('memory://')) {
      return (app.get(ObjectStorage) as InMemoryObjectStorage).put(target.uploadUrl.replace('memory://reports/', ''), bytes, target.headers['Content-Type']!);
    }
    const res = await fetch(target.uploadUrl, { method: 'PUT', headers: target.headers, body: bytes });
    expect(res.ok).toBe(true);
    return res.headers.get('x-amz-version-id') ?? undefined;
  }

  it('creates a lab-pdf, uploads it, and pins the exact version that was verified, with who asked and who completed', async () => {
    const alice = await tenantToken('alice', ['clinician']);
    const bob = await tenantToken('bob', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const target = (await uploadUrl(alice, id).expect(200)).body;
    const v1 = await put(target, PDF);
    const done = await complete(bob, id).expect(200);
    expect(done.body).toMatchObject({ type: 'lab-pdf', fileUploaded: true, sha256: sha(PDF), contentType: PDF_TYPE });
    expect(JSON.stringify(done.body)).not.toMatch(/alice|bob|object_?version|upload_?requested|uploaded_?by/); // internals never leave the API
    expect(await row(id)).toMatchObject({ created_by: 'alice', upload_requested_by: 'alice', uploaded_by: 'bob', object_version: v1 });
    expect(v1).toEqual(expect.any(String));
  });

  it('keeps the FIRST requester, and a repeated complete changes nobody\'s identity', async () => {
    const alice = await tenantToken('alice', ['clinician']);
    const bob = await tenantToken('bob', ['clinician']);
    const carol = await tenantToken('carol', ['admin']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    await uploadUrl(bob, id).expect(200); // bob asks first
    const target = (await uploadUrl(alice, id).expect(200)).body; // alice asks again
    await put(target, PDF);
    await complete(carol, id).expect(200);
    await complete(bob, id).expect(200); // a repeat
    expect(await row(id)).toMatchObject({ created_by: 'alice', upload_requested_by: 'bob', uploaded_by: 'carol' });
  });

  it('refuses a second upload URL once uploaded, and an overwrite through the old URL does not move the pin', async () => {
    const alice = await tenantToken('alice', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const target = (await uploadUrl(alice, id).expect(200)).body;
    const v1 = (await put(target, PDF))!;
    await complete(alice, id).expect(200);
    await uploadUrl(alice, id).expect(409);

    const v2 = await put(target, PDF2); // the still-valid upload link writes new bytes to the same key
    expect(v2).not.toBe(v1);
    const stored = await row(id);
    expect(stored.object_version).toBe(v1);
    const storage = app.get(ObjectStorage);
    expect((await storage.inspect(stored.storage_key, { version: stored.object_version }))!.sha256).toBe(sha(PDF)); // the pinned version still holds the verified bytes
    expect((await storage.inspect(stored.storage_key))!.sha256).toBe(sha(PDF2)); // while the "latest" is now different
    await complete(alice, id).expect(200); // a repeated complete does not re-verify or re-pin
    expect((await row(id)).object_version).toBe(v1);
  });

  it('rejects bytes that do not match the declared checksum, even when the key now holds something else', async () => {
    const alice = await tenantToken('alice', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    await put((await uploadUrl(alice, id).expect(200)).body, PDF2); // declared PDF, sent PDF2: the same size
    const res = await complete(alice, id).expect(409);
    expect(res.body.error.message).toMatch(/checksum/i); // same length (58 bytes), so only the hash can tell them apart
    expect((await row(id)).uploaded_at).toBeNull();
  });

  it('refuses a lab-pdf upload that has no storage version (an unversioned bucket), and says why', async () => {
    const storage = app.get(ObjectStorage);
    if (!(storage instanceof InMemoryObjectStorage)) return; // the S3 tier runs on a versioned bucket; the rule is proven in-memory and by the contract tests
    const alice = await tenantToken('alice', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const target = (await uploadUrl(alice, id).expect(200)).body;
    storage.versioned = false;
    try {
      await put(target, PDF);
      const res = await complete(alice, id).expect(409);
      expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: [{ reason: 'source-unpinned' }] });
      expect((await row(id)).uploaded_at).toBeNull();
    } finally {
      storage.versioned = true;
    }
  });

  it('a report with a capture can no longer change type or be deleted (409, not 500), and its status can still change', async () => {
    const alice = await tenantToken('alice', ['clinician'], 'tenant-cap');
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    await put((await uploadUrl(alice, id).expect(200)).body, PDF);
    await complete(alice, id).expect(200);
    const stored = await row(id);
    const seeded: SeededReport = { tenantId: 'tenant-cap', uploader: 'alice', patientId, reportId: id, pdfSha256: stored.sha256, objectVersion: stored.object_version, storageKey: stored.storage_key };
    await app.get(LedgerRecordsRepository).insertCapture('tenant-cap', 'cap-person', captureFor(seeded));

    const patch = await api(app).patch(`/api/v1/reports/${id}`).set(bearer(alice)).send({ type: 'vcf', filename: 'a.vcf' }).expect(409);
    expect(patch.body.error.code).toBe('CONFLICT');
    await api(app).delete(`/api/v1/reports/${id}`).set(bearer(alice)).expect(409);
    expect((await row(id)).deleted_at).toBeNull();
    // Control: a report WITHOUT a capture can still be deleted.
    const free = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    await api(app).delete(`/api/v1/reports/${free}`).set(bearer(alice)).expect(204);
  });

  it('switching the pipeline off later stops uploading and completing a lab-pdf (503), while reading it and deleting it still work', async () => {
    const alice = await tenantToken('alice', ['clinician'], 'tenant-off');
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const target = (await uploadUrl(alice, id).expect(200)).body;
    await put(target, PDF);

    const off = await createTestApp({ postgresUrl: db.appUrl }); // the same database, the switch back to its default
    try {
      const get = (path: string) => request(off.getHttpServer()).get(`/api/v1/${path}`).set(bearer(alice));
      const post = (path: string, body: object = {}) => request(off.getHttpServer()).post(`/api/v1/${path}`).set(bearer(alice)).send(body);
      expect((await post(`reports/${id}/upload-url`, { contentType: PDF_TYPE, sha256: sha(PDF) }).expect(503)).body.error.code).toBe('PIPELINE_DISABLED');
      expect((await post(`reports/${id}/complete`).expect(503)).body.error.code).toBe('PIPELINE_DISABLED');
      expect((await row(id)).uploaded_at).toBeNull(); // nothing was verified or pinned while off
      await get(`reports/${id}`).expect(200);
    } finally {
      await off.close();
    }
    await complete(alice, id).expect(200); // control: back on, the same request works
  });

  it('stays isolated by tenant', async () => {
    const alice = await tenantToken('alice', ['clinician'], 'tenant-one');
    const mallory = await tenantToken('mallory', ['clinician'], 'tenant-two');
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    await uploadUrl(mallory, id).expect(404);
    await complete(mallory, id).expect(404);
  });
});
