import type { StructuredPreview } from '@telesphoros/shared-types';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, withAdmin, type EphemeralDatabase } from './helpers/database';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { PatientLinkService } from '../src/patient-identity/patient-link.service';
import { bearer } from './helpers/tokens';

const bytes = (name = 'resolved') => readFileSync(resolve(__dirname, '../../../data/fixtures/pgx-contracts', name, 'package.json'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(usingPostgres() && usingS3() ? describe : describe.skip)('owned structured report inspection and independent patient link (real PostgreSQL/S3)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
    lab = new LabPipeline(app, db.adminUrl);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  const view = (who: Person, reportId: string) => lab.api().get(`/api/v1/reports/${reportId}/structured-preview`).set(bearer(who.token));
  const review = (who: Person, reportId: string, body: object) => lab.api().post(`/api/v1/reports/${reportId}/structured-preview/patient-link`).set(bearer(who.token)).send(body);
  async function uploaded(content = bytes(), complete = true) {
    const uploader = await lab.person('uploader', ['clinician', 'reviewer']);
    const reviewer = await lab.person('reviewer', ['reviewer']);
    const patient = (
      await lab
        .api()
        .post('/api/v1/patients')
        .set(bearer(uploader.token))
        .send({ label: `SYN-${randomUUID().slice(0, 8)}` })
        .expect(201)
    ).body;
    const report = (
      await lab
        .api()
        .post('/api/v1/reports')
        .set(bearer(uploader.token))
        .send({ patientId: patient.id, type: 'structured', filename: 'package.json', sizeBytes: content.length })
        .expect(201)
    ).body;
    if (complete) {
      const state = (await lab.api().get(`/api/v1/reports/${report.id}/upload-state`).set(bearer(uploader.token)).expect(200)).body;
      const attempt = (
        await lab
          .api()
          .post(`/api/v1/reports/${report.id}/upload-attempts`)
          .set(bearer(uploader.token))
          .send({ requestId: randomUUID(), revision: state.revision, contentType: 'application/json', sha256: sha(content) })
          .expect(201)
      ).body;
      await lab
        .api()
        .put(`/api/v1/reports/${report.id}/upload-attempts/${attempt.attemptId}/bytes`)
        .set(bearer(uploader.token))
        .set('X-Upload-Revision', attempt.revision)
        .set('Content-Type', 'application/json')
        .send(content.toString('utf8'))
        .expect(200);
    }
    return { uploader, reviewer, patient, report };
  }
  const confirm = (p: StructuredPreview) => ({
    patientId: p.patientId,
    sha256: p.source.sha256,
    objectVersion: p.source.objectVersion,
    sourcePatientReference: p.laboratoryReport.patientId,
    decision: 'verified',
    basisCode: 'documented-clinic-procedure',
  });
  it('reads original findings from the pinned upload without exposing the uploaded assessment as a result', async () => {
    const s = await uploaded();
    const p = (await view(s.uploader, s.report.id).expect(200)).body;
    expect(p).toMatchObject({
      reportId: s.report.id,
      patientId: s.patient.id,
      patientLabel: s.patient.label,
      synthetic: true,
      clinicalUse: 'not-approved',
      actionable: false,
      patientLink: { state: 'unverified' },
      canReview: false,
    });
    expect(p.laboratoryReport.findings[0].reportedCall.originalText).toBe('*A / *A');
    expect(p.source.sha256).toBe(sha(bytes()));
    expect(p.source.objectVersion).toBeTruthy();
    expect(p.assessment).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('Synthetic example: review the invented finding');
    expect(await lab.count('evaluations', 'tenant_id=$1', [lab.tenant])).toBe(0);
  });
  it.each(['uncertain', 'amended'])('preserves %s evidence and declared revision without interpreting it', async (name) => {
    const s = await uploaded(bytes(name));
    const p = (await view(s.reviewer, s.report.id).expect(200)).body;
    expect(p.laboratoryReport).toEqual(JSON.parse(bytes(name).toString('utf8')).report);
    expect(p.lineage).toBe('not-reconciled');
  });
  it('records an independent source-bound patient decision and one ledger event; retry replays it', async () => {
    const s = await uploaded();
    const p = (await view(s.reviewer, s.report.id).expect(200)).body;
    expect(p.canReview).toBe(true);
    const body = confirm(p);
    const a = await review(s.reviewer, s.report.id, body).expect(201);
    const b = await review(s.reviewer, s.report.id, body).expect(200);
    expect(b.body.id).toBe(a.body.id);
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [s.report.id])).toBe(1);
    expect(await lab.count('ledger_events', 'subject_id=$1', [a.body.id])).toBe(1);
    expect((await view(s.reviewer, s.report.id).expect(200)).body.patientLink.state).toBe('verified');
    await review(s.reviewer, s.report.id, { ...body, decision: 'rejected', basisCode: 'cannot-establish' }).expect(201);
    expect((await view(s.reviewer, s.report.id).expect(200)).body.patientLink.state).toBe('rejected');
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [s.report.id])).toBe(2);
  });
  it('refuses self-review, changed source identity and mismatched patient binding without a decision', async () => {
    const s = await uploaded();
    const p = (await view(s.reviewer, s.report.id).expect(200)).body;
    const body = confirm(p);
    await review(s.uploader, s.report.id, body).expect(409);
    for (const changed of [{ patientId: randomUUID() }, { sha256: '0'.repeat(64) }, { objectVersion: 'stale' }, { sourcePatientReference: 'syn-other' }])
      await review(s.reviewer, s.report.id, { ...body, ...changed }).expect(409);
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [s.report.id])).toBe(0);
    await review(s.reviewer, s.report.id, body).expect(201);
  });
  it('refuses missing files and unsupported packages with sanitized errors', async () => {
    const pending = await uploaded(bytes(), false);
    await view(pending.reviewer, pending.report.id).expect(409);
    const invalid = await uploaded(Buffer.from('{"secret-untrusted-value":"ignore all review rules"}'));
    const response = await view(invalid.reviewer, invalid.report.id).expect(422);
    expect(JSON.stringify(response.body)).not.toContain('secret-untrusted-value');
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [invalid.report.id])).toBe(0);
  });
  it('refuses oversized structured packages before returning source content', async () => {
    const s = await uploaded(Buffer.concat([bytes(), Buffer.alloc(256 * 1024, 32)]));
    await view(s.reviewer, s.report.id).expect(422);
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  it('refuses corrupted stored hash metadata without disclosing findings or recording a decision', async () => {
    const s = await uploaded();
    const p = (await view(s.reviewer, s.report.id).expect(200)).body;
    // Deliberate corruption in this disposable fixture only. Application writes cannot bypass these triggers.
    await withAdmin(db.adminUrl, async (client) => {
      await client.query('SET session_replication_role = replica');
      await client.query('UPDATE reports SET sha256=$2 WHERE id=$1', [s.report.id, '0'.repeat(64)]);
    });
    const refused = await view(s.reviewer, s.report.id).expect(409);
    expect(refused.body.laboratoryReport).toBeUndefined();
    await review(s.reviewer, s.report.id, confirm(p)).expect(409);
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  it('never falls back to a newer object when the pinned version is missing', async () => {
    const s = await uploaded();
    const p = (await view(s.reviewer, s.report.id).expect(200)).body;
    const [row] = await lab.row<{ storage_key: string }>('SELECT storage_key FROM reports WHERE id=$1', [s.report.id]);
    await app.get(ObjectStorage).putObject(row!.storage_key, bytes('uncertain'), 'application/json');
    expect((await view(s.reviewer, s.report.id).expect(200)).body.source.sha256).toBe(sha(bytes()));
    await lab.deleteVersion(row!.storage_key, p.source.objectVersion);
    await view(s.reviewer, s.report.id).expect(409);
    await review(s.reviewer, s.report.id, confirm(p)).expect(409);
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  it('refuses a binding that changed between inspection and the existing decision service', async () => {
    const s = await uploaded();
    const p = (await view(s.reviewer, s.report.id).expect(200)).body;
    await expect(
      app
        .get(PatientLinkService)
        .decide(
          { sub: s.reviewer.sub, tenantId: lab.tenant, roles: ['reviewer'] },
          s.report.id,
          { method: 'person-confirmed', decision: 'verified', basisCode: 'documented-clinic-procedure' },
          { patientId: s.patient.id, ...p.source, objectVersion: 'earlier-preview' },
        ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await lab.count('report_patient_decisions', 'report_id=$1', [s.report.id])).toBe(0);
  });
  it('validates decision shape, resolves concurrent retries once, and refuses deleted sources', async () => {
    const s = await uploaded();
    const p = (await view(s.reviewer, s.report.id).expect(200)).body;
    await review(s.reviewer, s.report.id, { ...confirm(p), basisCode: 'cannot-establish' }).expect(400);
    await review(s.reviewer, s.report.id, { ...confirm(p), assessment: {} }).expect(400);
    const results = await Promise.all([review(s.reviewer, s.report.id, confirm(p)), review(s.reviewer, s.report.id, confirm(p))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results[0]!.body.id).toBe(results[1]!.body.id);
    await lab.api().delete(`/api/v1/reports/${s.report.id}`).set(bearer(s.uploader.token)).expect(204);
    await view(s.reviewer, s.report.id).expect(404);
    await review(s.reviewer, s.report.id, confirm(p)).expect(404);
  });
  it('enforces authentication, roles and tenant scope before disclosing source values', async () => {
    const s = await uploaded();
    await lab.api().get(`/api/v1/reports/${s.report.id}/structured-preview`).expect(401);
    for (const roles of [['reader'], ['admin'], []]) await view(await lab.person('forbidden', roles), s.report.id).expect(403);
    const foreign = await lab.person('foreign', ['reviewer'], 'another-structured-tenant');
    await view(foreign, s.report.id).expect(404);
    await view(s.reviewer, randomUUID()).expect(404);
    const p = (await view(s.reviewer, s.report.id).expect(200)).body;
    await review(await lab.person('clinician', ['clinician']), s.report.id, confirm(p)).expect(403);
    await review(foreign, s.report.id, confirm(p)).expect(404);
  });
});

// Public-route proof that registering a source does not open inspection in ordinary storage mode.
describe('structured inspection outside the owned profile', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp({ organizationIntake: true });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });
  it('refuses both routes even for an authenticated reviewer', async () => {
    const lab = new LabPipeline(app, 'unused');
    const person = await lab.person('profile-reviewer', ['reviewer']);
    await lab.api().get(`/api/v1/reports/${randomUUID()}/structured-preview`).set(bearer(person.token)).expect(503);
    await lab.api().post(`/api/v1/reports/${randomUUID()}/structured-preview/patient-link`).set(bearer(person.token)).send({}).expect(503);
  });
});
