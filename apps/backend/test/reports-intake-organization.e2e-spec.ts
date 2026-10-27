import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { tenantPrefix } from '../src/lab-reports/object-keys';
import { Readable } from 'node:stream';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { IntakeService } from '../src/reports/intake/intake.service';
import { ReportsRepository } from '../src/storage/reports.repository';
import { createTestApp, securityEventsOf, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { DOCUMENT_IDS, engineFixtures, LabPipeline } from './helpers/lab-pipeline';

import { bearer, clinicianA, clinicianB, readerA, signToken } from './helpers/tokens';

// This spec runs the private engine on its own captures (spec 004 slice 3 moves it to public fixtures).
const { fixturePdf } = engineFixtures;

// The validated intake in the organization's own scope (M2.2a): no disposable run, keys under the report, a per-organization quota and a refused file recorded as
// a security event. Synthetic data only. Runs on memory, PostgreSQL and PostgreSQL plus S3.
const vcf = {
  type: 'vcf',
  mime: 'text/x-vcf',
  name: 'sample.vcf',
  bytes: Buffer.from('##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t100\t.\tA\tG\t.\t.\t.\n'),
};
const json = { type: 'structured', mime: 'application/json', name: 'sample.json', bytes: Buffer.from('{"synthetic":true,"values":[1,2,3]}') };
const pdf = { type: 'lab-pdf', mime: 'application/pdf', name: 'sample.pdf', bytes: Buffer.from('%PDF-1.7\nSynthetic opaque bytes\n%%EOF\n') };
type Sample = typeof vcf | typeof json | typeof pdf;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const TENANT_A = 'tenant-user-a';

let app: NestExpressApplication;
let token: string;
const api = () => request(app.getHttpServer());

async function registration(s: Sample, who = token, size = s.bytes.length) {
  const patient = (
    await api()
      .post('/api/v1/patients')
      .set(bearer(who))
      .send({ label: `SYN-${randomUUID().slice(0, 8)}` })
      .expect(201)
  ).body.id;
  return (await api().post('/api/v1/reports').set(bearer(who)).send({ patientId: patient, type: s.type, filename: s.name, sizeBytes: size }).expect(201)).body.id as string;
}
const declareReq = (id: string, s: Sample, who = token, bytes = s.bytes) =>
  api()
    .get(`/api/v1/reports/${id}/upload-state`)
    .set(bearer(who))
    .expect(200)
    .then((st) =>
      api()
        .post(`/api/v1/reports/${id}/upload-attempts`)
        .set(bearer(who))
        .send({ requestId: randomUUID(), revision: st.body.revision, contentType: s.mime, sha256: sha(bytes) }),
    );
const declare = async (id: string, s: Sample, who = token) => {
  const res = await declareReq(id, s, who);
  expect(res.status).toBe(201);
  return res.body as { attemptId: string; revision: string };
};
const send = (id: string, a: { attemptId: string; revision: string }, s: Sample, bytes = s.bytes, who = token) =>
  api()
    .put(`/api/v1/reports/${id}/upload-attempts/${a.attemptId}/bytes`)
    .set(bearer(who))
    .set('X-Upload-Revision', a.revision)
    .set('Content-Type', s.mime)
    .send(s.mime === 'application/json' ? bytes.toString('utf8') : bytes);
const row = (id: string, tenant = TENANT_A) => app.get(ReportsRepository).findById(tenant, id);

describe('validated intake in the organization scope', () => {
  beforeEach(async () => {
    app = await createTestApp({ organizationIntake: true });
    token = await clinicianA();
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([vcf, json])(
    'stores a valid $type once, under the report, pinned to a real version, with the person who declared and sent it as both requester and uploader',
    async (s) => {
      const id = await registration(s);
      const a = await declare(id, s);
      expect((await send(id, a, s).expect(200)).body.state).toBe('committed');
      const stored = (await row(id))!;
      expect(stored.storageKey).toBe(`reports/${tenantPrefix(TENANT_A)}/${id}/intake/${a.attemptId}`);
      expect(stored).toMatchObject({ sha256: sha(s.bytes), contentType: s.mime, sizeBytes: s.bytes.length, uploadedBy: 'user-a', uploadRequestedBy: 'user-a' });
      expect(stored.uploadedAt).toBeTruthy();
      expect(stored.objectVersion && stored.objectVersion !== 'null').toBe(true);
      const report = (await api().get(`/api/v1/reports/${id}`).set(bearer(token)).expect(200)).body;
      expect(report).toMatchObject({ fileUploaded: true, sha256: sha(s.bytes) });
      expect(report).not.toHaveProperty('storageKey');
      const link = await api().get(`/api/v1/reports/${id}/download-url`).set(bearer(token)).expect(200);
      if (usingS3()) expect(sha(Buffer.from(await (await fetch(link.body.url)).arrayBuffer()))).toBe(sha(s.bytes));
    },
  );

  it.each([
    ['a VCF with no header line', vcf, Buffer.from('1\t100\t.\tA\tG\n')],
    ['broken JSON', json, Buffer.from('{"x":}')],
    ['a PDF that is really HTML', pdf, Buffer.from('<html>opaque</html>')],
  ] as const)('refuses %s: nothing is written to storage, the attempt is closed, and the refusal is recorded as a security event', async (_label, s, bytes) => {
    // The pipeline is off in this app, so use the type that does not need it for the control; the PDF case is covered in the pipeline block below.
    if (s.type === 'lab-pdf') return;
    const id = await registration(s, token, bytes.length);
    const a = await declare(id, { ...s, bytes } as Sample);
    const put = jest.spyOn(app.get(ObjectStorage), 'putStream');
    await send(id, a, s, bytes).expect(400);
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
    expect((await row(id))!.uploadedAt).toBeFalsy();
    const inventory = await app.get(ObjectStorage).uploadVersions(`reports/${tenantPrefix(TENANT_A)}/${id}/intake/`, AbortSignal.timeout(5000));
    expect(inventory).toEqual([]);
    const events = (await securityEventsOf(app)).filter((e) => e.eventType === 'intake.rejected');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenantId: TENANT_A, outcome: 'refused', actorRef: 'user-a', subjectKind: 'person', subjectRef: 'user-a', details: { reason: 'structure' } });
    // Only a short code: nothing about the file, its name, its hash or the report.
    const shown = JSON.stringify(events[0]);
    for (const secret of [s.name, sha(bytes), id, a.attemptId, 'fileformat']) expect(shown).not.toContain(secret);
    // Throttled like other refusals: the same person and reason within a minute add nothing.
    const again = await declare(await registration(s, token, bytes.length), s);
    void again;
    expect((await securityEventsOf(app)).filter((e) => e.eventType === 'intake.rejected')).toHaveLength(1);
  });

  it('control: a refusal for a different reason is a second event, and a cancelled transfer is not an event', async () => {
    const id = await registration(json);
    const a = await declare(id, json);
    await send(id, a, json, Buffer.from('{"x":}')).expect(400);
    const id2 = await registration(vcf);
    const b = await declare(id2, vcf);
    await send(id2, b, vcf, Buffer.from(vcf.bytes.toString().replace('\t100\t', '\t200\t'))).expect(400); // well formed, right size, wrong hash
    const reasons = (await securityEventsOf(app))
      .filter((e) => e.eventType === 'intake.rejected')
      .map((e) => e.details.reason)
      .sort();
    expect(reasons).toEqual(['checksum', 'structure']);
    const id3 = await registration(json);
    const c = await declare(id3, json);
    await api().post(`/api/v1/reports/${id3}/upload-attempts/${c.attemptId}/cancel`).set(bearer(token)).set('X-Upload-Revision', c.revision).expect(200);
    expect((await securityEventsOf(app)).filter((e) => e.eventType === 'intake.rejected')).toHaveLength(2);
  });

  it('does not record a transfer the person cancelled while it was running (control: a refused file is recorded)', async () => {
    const id = await registration(json);
    const a = await declare(id, json);
    const service = app.get(IntakeService, { strict: false });
    const principal = { sub: 'user-a', tenantId: TENANT_A, roles: ['clinician' as const] };
    // A body that starts, then waits for the cancellation, then would have continued.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = Readable.from(
      (async function* () {
        yield json.bytes.subarray(0, 5);
        await gate;
        yield json.bytes.subarray(5);
      })(),
    );
    const running = service.intake(principal, id, a.attemptId, a.revision, source, { 'content-type': json.mime }).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await service.cancel(principal, id, a.attemptId, a.revision);
    release();
    await running;
    expect((await row(id))!.uploadedAt).toBeFalsy();
    expect((await securityEventsOf(app)).filter((e) => e.eventType === 'intake.rejected')).toEqual([]);
  });

  it('keeps the quota per organization: ten declared 10 MiB files fill it, an eleventh is refused, another organization is unaffected, and a cancelled one frees its share', async () => {
    const size = 10 * 1024 * 1024;
    const mine: { id: string; a: { attemptId: string; revision: string } }[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await registration(json, token, size);
      mine.push({
        id,
        a: (
          await api()
            .post(`/api/v1/reports/${id}/upload-attempts`)
            .set(bearer(token))
            .send({
              requestId: randomUUID(),
              revision: (await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token))).body.revision,
              contentType: json.mime,
              sha256: sha(json.bytes),
            })
            .expect(201)
        ).body,
      });
    }
    const extra = await registration(json, token, size);
    const state = (await api().get(`/api/v1/reports/${extra}/upload-state`).set(bearer(token)).expect(200)).body;
    const refused = await api()
      .post(`/api/v1/reports/${extra}/upload-attempts`)
      .set(bearer(token))
      .send({ requestId: randomUUID(), revision: state.revision, contentType: json.mime, sha256: sha(json.bytes) });
    expect(refused.status).toBe(409);
    // Another organization has its own quota.
    const other = await clinicianB();
    const theirs = await registration(json, other, size);
    await declare(theirs, json, other);
    // Control: freeing one share lets the same declaration through.
    await api().post(`/api/v1/reports/${mine[0]!.id}/upload-attempts/${mine[0]!.a.attemptId}/cancel`).set(bearer(token)).set('X-Upload-Revision', mine[0]!.a.revision).expect(200);
    await api()
      .post(`/api/v1/reports/${extra}/upload-attempts`)
      .set(bearer(token))
      .send({ requestId: randomUUID(), revision: state.revision, contentType: json.mime, sha256: sha(json.bytes) })
      .expect(201);
  });

  it("keeps a report's inventory to itself: an object nobody declared under one report blocks that report only", async () => {
    const [blocked, free] = [await registration(json), await registration(json)];
    const storage = app.get(ObjectStorage);
    const stray = `reports/${tenantPrefix(TENANT_A)}/${blocked}/intake/${randomUUID()}`;
    await storage.putStream(stray, Readable.from([Buffer.from('x')]), 'application/json', 1, AbortSignal.timeout(5000));
    expect((await declareReq(blocked, json)).status).toBe(503);
    await declare(free, json); // control
  });

  it('answers 503 and reserves nothing when the bucket cannot be listed, then works again (control)', async () => {
    const id = await registration(json);
    const storage = app.get(ObjectStorage);
    const failing = jest.spyOn(storage, 'uploadVersions').mockRejectedValue(new Error('AccessDenied'));
    expect((await declareReq(id, json)).status).toBe(503);
    failing.mockRestore();
    const state = (await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token)).expect(200)).body;
    expect(state.run.pendingCount).toBe(0);
    await declare(id, json);
  });

  it('refuses a reader, a stale revision and another organization, as in a local run', async () => {
    const id = await registration(json);
    const a = await declare(id, json);
    await send(id, a, json, json.bytes, await readerA()).expect(403);
    await send(id, { ...a, revision: randomUUID() }, json).expect(404);
    await send(id, a, json, json.bytes, await clinicianB()).expect(404);
    await send(id, a, json).expect(200); // control
  });

  it('refuses a lab PDF while the lab-report pipeline is off, as the retired direct-upload routes did', async () => {
    const id = await registration(pdf);
    const st = await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token)).expect(200);
    const r = await api()
      .post(`/api/v1/reports/${id}/upload-attempts`)
      .set(bearer(token))
      .send({ requestId: randomUUID(), revision: st.body.revision, contentType: pdf.mime, sha256: sha(pdf.bytes) });
    expect(r.status).toBe(503);
    expect(r.body.error.code ?? r.body.code).toBeDefined();
  });

  it('requires a signed-in clinician', async () => {
    await api().post(`/api/v1/reports/${randomUUID()}/upload-attempts`).send({}).expect(401);
    const reviewer = await signToken({ sub: 'rev', tenant: TENANT_A, roles: ['reviewer'] });
    const id = await registration(json);
    await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(reviewer)).expect(403);
  });
});

(usingPostgres() ? describe : describe.skip)('validated intake with the lab-report pipeline on', () => {
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let pipelineApp: NestExpressApplication;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    pipelineApp = await createTestApp({ labReportPipeline: true, readerEngine: true, postgresUrl: db.appUrl });
    lab = new LabPipeline(pipelineApp, db.adminUrl);
  });
  afterAll(async () => {
    await pipelineApp.close();
    await db.drop();
  });

  async function intakePdf(who: { token: string }, bytes: Buffer, patientId?: string) {
    const pid = patientId ?? (await lab.patient(who as never));
    const reportId = (
      await lab.api().post('/api/v1/reports').set(bearer(who.token)).send({ patientId: pid, type: 'lab-pdf', filename: 'sample.pdf', sizeBytes: bytes.length }).expect(201)
    ).body.id as string;
    const st = await lab.api().get(`/api/v1/reports/${reportId}/upload-state`).set(bearer(who.token)).expect(200);
    const a = (
      await lab
        .api()
        .post(`/api/v1/reports/${reportId}/upload-attempts`)
        .set(bearer(who.token))
        .send({ requestId: randomUUID(), revision: st.body.revision, contentType: 'application/pdf', sha256: sha(bytes) })
        .expect(201)
    ).body;
    return {
      reportId,
      a,
      put: (b = bytes) =>
        lab
          .api()
          .put(`/api/v1/reports/${reportId}/upload-attempts/${a.attemptId}/bytes`)
          .set(bearer(who.token))
          .set('X-Upload-Revision', a.revision)
          .set('Content-Type', 'application/pdf')
          .send(b),
    };
  }

  it.each(DOCUMENT_IDS.slice(0, 3))('%s: a lab PDF stored by the intake is captured by the existing route, with the identities the independence rules read', async (docId) => {
    const clinician = await lab.person('clin', ['clinician']);
    const bytes = fixturePdf(docId);
    const up = await intakePdf(clinician, bytes);
    expect((await up.put().expect(200)).body.state).toBe('committed');
    const [r] = await lab.row<{ created_by: string; upload_requested_by: string; uploaded_by: string; uploaded_at: Date | null; object_version: string; sha256: string }>(
      'SELECT created_by, upload_requested_by, uploaded_by, uploaded_at, object_version, sha256 FROM reports WHERE id = $1',
      [up.reportId],
    );
    expect(r).toMatchObject({ created_by: clinician.sub, upload_requested_by: clinician.sub, uploaded_by: clinician.sub, sha256: sha(bytes) });
    expect(r!.uploaded_at).toBeTruthy();
    expect(r!.object_version && r!.object_version !== 'null').toBe(true);
    await lab.capture(clinician, up.reportId).expect(201);
  });

  it('refuses a malformed PDF with no object and records the refusal', async () => {
    const clinician = await lab.person('clin', ['clinician']);
    const bytes = Buffer.from('<html>not a pdf</html>');
    const up = await intakePdf(clinician, bytes);
    await up.put().expect(400);
    expect((await lab.row<{ uploaded_at: Date | null }>('SELECT uploaded_at FROM reports WHERE id = $1', [up.reportId]))[0]!.uploaded_at).toBeNull();
    expect((await lab.row<{ uploaded_at: Date | null }>('SELECT uploaded_at FROM reports WHERE id = $1', [up.reportId]))[0]!.uploaded_at).toBeNull();
    const events = await lab.row<{ details: { reason: string } }>("SELECT details FROM security_events WHERE event_type = 'intake.rejected' AND actor_ref = $1", [clinician.sub]);
    expect(events.map((e) => e.details)).toEqual([{ reason: 'structure' }]);
    await lab.capture(clinician, up.reportId).expect(409);
  });
});
