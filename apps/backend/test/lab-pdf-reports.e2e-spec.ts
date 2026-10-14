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
    for (const method of ['inspect', 'getObject', 'putObject', 'createDownloadUrl'] as const) {
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

  it('registers PDF metadata while processing is disabled without touching bytes', async () => {
    const token = await tenantToken('clin-1', ['clinician']);
    const patientId = await newPatient(app, token);
    const res = await createReport(app, token, patientId).expect(201);
    expect(res.body).toMatchObject({ type: 'lab-pdf',fileUploaded:false });
    expect(res.headers['retry-after']).toBeUndefined();
    expect((await api(app).get('/api/v1/reports').set(bearer(token)).expect(200)).body.data).toHaveLength(1);
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
    [['admin'], 403],
    [['clinician', 'reviewer'], 201],
    [['admin', 'reviewer'], 403],
    [['admin', 'clinician'], 201],
  ] as const)('with the roles %j, creating a (vcf) report answers %i: the whole set of roles counts, and neither reviewer nor admin alone ever writes', async (roles, status) => {
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

  it('allows an unuploaded report type correction while processing is off without touching storage', async () => {
    const token = await tenantToken('clin-1', ['clinician']);
    const patientId = await newPatient(app, token);
    const id = (await createReport(app, token, patientId, { type: 'vcf', filename: 'a.vcf' }).expect(201)).body.id;
    const res = await api(app).patch(`/api/v1/reports/${id}`).set(bearer(token)).send({ type: 'lab-pdf', filename: 'a.pdf' }).expect(200);
    expect(res.body.type).toBe('lab-pdf');
    expect((await api(app).get(`/api/v1/reports/${id}`).set(bearer(token))).body).toMatchObject({ type: 'lab-pdf', filename: 'a.pdf' });
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

  /** Declares an attempt for a lab PDF and returns what the bytes route needs (the declared hash is `declared`, default the bytes' own). */
  async function declare(token: string, id: string, bytes: Buffer = PDF, declared: Buffer = bytes, target = app) {
    const revision = (await api(target).get(`/api/v1/reports/${id}/upload-state`).set(bearer(token)).expect(200)).body.revision;
    const res = await api(target).post(`/api/v1/reports/${id}/upload-attempts`).set(bearer(token)).send({ requestId: randomUUID(), revision, contentType: PDF_TYPE, sha256: sha(declared) });
    return { res, attempt: res.body as { attemptId: string; revision: string } };
  }
  const send = (token: string, id: string, a: { attemptId: string; revision: string }, bytes: Buffer = PDF, target = app) =>
    api(target).put(`/api/v1/reports/${id}/upload-attempts/${a.attemptId}/bytes`).set(bearer(token)).set('X-Upload-Revision', a.revision).set('Content-Type', PDF_TYPE).send(bytes);
  const resume = (token: string, id: string, a: { attemptId: string; revision: string }, target = app) =>
    api(target).post(`/api/v1/reports/${id}/upload-attempts/${a.attemptId}/resume`).set(bearer(token)).set('X-Upload-Revision', a.revision);
  /** A finished upload through the intake, by one person. */
  async function uploaded(token: string, id: string, bytes: Buffer = PDF) {
    const { res, attempt } = await declare(token, id, bytes);
    expect(res.status).toBe(201);
    await send(token, id, attempt, bytes).expect(200);
    return attempt;
  }
  const row = (id: string) => withAdmin(db.adminUrl, async (c) => (await c.query(`SELECT * FROM reports WHERE id = $1`, [id])).rows[0]);


  it('creates a lab-pdf, uploads it through the intake, and pins the exact version that was verified, with the person who declared and sent it', async () => {
    const alice = await tenantToken('alice', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    await uploaded(alice, id);
    const done = await api(app).get(`/api/v1/reports/${id}`).set(bearer(alice)).expect(200);
    expect(done.body).toMatchObject({ type: 'lab-pdf', fileUploaded: true, sha256: sha(PDF), contentType: PDF_TYPE });
    expect(JSON.stringify(done.body)).not.toMatch(/alice|object_?version|upload_?requested|uploaded_?by/); // internals never leave the API
    const stored = await row(id);
    expect(stored).toMatchObject({ created_by: 'alice', upload_requested_by: 'alice', uploaded_by: 'alice' });
    expect(stored.object_version).toEqual(expect.any(String));
    expect(stored.object_version).not.toBe('null');
  });

  it('keeps the attempt with the person who declared it: another clinician cannot send its bytes, and repeating a resume changes nobody\'s identity', async () => {
    const alice = await tenantToken('alice', ['clinician']);
    const bob = await tenantToken('bob', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const { attempt } = await declare(alice, id);
    await send(bob, id, attempt).expect(404); // not bob's attempt
    expect((await row(id)).uploaded_at).toBeNull();
    await send(alice, id, attempt).expect(200);
    await resume(alice, id, attempt).expect(200);
    await resume(alice, id, attempt).expect(200);
    expect(await row(id)).toMatchObject({ created_by: 'alice', upload_requested_by: 'alice', uploaded_by: 'alice' });
  });

  it('refuses a second attempt once uploaded, and a later write to the same key does not move the pin', async () => {
    const alice = await tenantToken('alice', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const attempt = await uploaded(alice, id);
    const v1 = (await row(id)).object_version as string;
    expect((await declare(alice, id)).res.status).toBe(409);

    const stored = await row(id);
    const storage = app.get(ObjectStorage);
    const v2 = (await storage.putObject(stored.storage_key, PDF2, PDF_TYPE)).version; // someone with write access to the bucket writes new bytes to the same key
    expect(v2).not.toBe(v1);
    expect((await row(id)).object_version).toBe(v1);
    expect((await storage.inspect(stored.storage_key, { version: v1 }))!.sha256).toBe(sha(PDF)); // the pinned version still holds the verified bytes
    expect((await storage.inspect(stored.storage_key))!.sha256).toBe(sha(PDF2)); // while the "latest" is now different
    await resume(alice, id, attempt).expect(200); // a repeated resume does not re-verify or re-pin
    expect((await row(id)).object_version).toBe(v1);
  });

  it('rejects bytes that do not match the declared checksum (same size), stores nothing and pins nothing', async () => {
    const alice = await tenantToken('alice', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const { attempt } = await declare(alice, id, PDF2, PDF); // declared PDF, sent PDF2: the same length (58 bytes), so only the hash can tell them apart
    expect(PDF2.length).toBe(PDF.length);
    await send(alice, id, attempt, PDF2).expect(400);
    expect((await row(id)).uploaded_at).toBeNull();
  });

  it('refuses a lab-pdf upload that has no storage version (an unversioned bucket) and pins nothing', async () => {
    const storage = app.get(ObjectStorage);
    if (!(storage instanceof InMemoryObjectStorage)) return; // the S3 tier runs on a versioned bucket; the rule is proven in-memory and by the contract tests
    const alice = await tenantToken('alice', ['clinician']);
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const { attempt } = await declare(alice, id);
    storage.versioned = false;
    try {
      await send(alice, id, attempt).expect(409);
      expect((await row(id)).uploaded_at).toBeNull();
    } finally {
      storage.versioned = true;
    }
    await send(alice, id, attempt).expect(200); // control: with versions kept, the same attempt goes through
  });

  it('a report with a capture can no longer change type or be deleted (409, not 500), and its status can still change', async () => {
    const alice = await tenantToken('alice', ['clinician'], 'tenant-cap');
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    await uploaded(alice, id);
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

  it('switching the pipeline off later keeps the lab-PDF gate (503) on declaring, sending and resuming, while reading and deleting still work', async () => {
    const alice = await tenantToken('alice', ['clinician'], 'tenant-off');
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const { attempt } = await declare(alice, id);
    const other = (await createReport(app, alice, patientId).expect(201)).body.id as string;

    const off = await createTestApp({ postgresUrl: db.appUrl, organizationIntake: true }); // the same database, the switch back to its default
    try {
      const get = (path: string) => request(off.getHttpServer()).get(`/api/v1/${path}`).set(bearer(alice));
      expect((await declare(alice, other, PDF, PDF, off)).res.status).toBe(503);
      const refused = await send(alice, id, attempt, PDF, off);
      expect([refused.status, refused.body.error.code]).toEqual([503, 'PIPELINE_DISABLED']);
      expect((await resume(alice, id, attempt, off)).status).toBe(503);
      expect((await row(id)).uploaded_at).toBeNull(); // nothing was verified or pinned while off
      await get(`reports/${id}`).expect(200);
    } finally {
      await off.close();
    }
    await send(alice, id, attempt).expect(200); // control: back on, the same request works
  });

  it('stays isolated by tenant', async () => {
    const alice = await tenantToken('alice', ['clinician'], 'tenant-one');
    const mallory = await tenantToken('mallory', ['clinician'], 'tenant-two');
    const patientId = await newPatient(app, alice);
    const id = (await createReport(app, alice, patientId).expect(201)).body.id as string;
    const { attempt } = await declare(alice, id);
    await api(app).get(`/api/v1/reports/${id}/upload-state`).set(bearer(mallory)).expect(404);
    await api(app).post(`/api/v1/reports/${id}/upload-attempts`).set(bearer(mallory)).send({ requestId: randomUUID(), revision: attempt.revision, contentType: PDF_TYPE, sha256: sha(PDF) }).expect(404);
    await send(mallory, id, attempt).expect(404);
  });
});
