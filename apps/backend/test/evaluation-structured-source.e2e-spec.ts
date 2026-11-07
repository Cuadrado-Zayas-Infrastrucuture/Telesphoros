import { evaluationDtoSchema, type StructuredPreview } from '@telesphoros/shared-types';
import { toEvaluationDto } from '../src/lab-reports/lab-report.mapper';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, withAdmin, type EphemeralDatabase } from './helpers/database';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';
import { LedgerVerifier } from '../src/ledger/verifier';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { LedgerIntegrityError } from '../src/ledger/ledger-types';
import { evaluationFor, sha as hash } from './helpers/ledger-fixtures';

// 032 S3, PR 2a: an evaluation may rest on a stored structured revision instead of an accepted PDF capture. This slice adds no way for a request to
// create one (that is the next slice); it proves the storage, the ledger and the readers accept the shape, with the repository as the only writer.
const bytes = () => readFileSync(resolve(__dirname, '../../../data/fixtures/pgx-contracts', 'resolved', 'package.json'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(usingPostgres() && usingS3() ? describe : describe.skip)('an evaluation that rests on a stored structured revision (real PostgreSQL/S3)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let verifier: LedgerVerifier;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
    lab = new LabPipeline(app, db.adminUrl);
    verifier = LedgerVerifier.connect(db.verifierUrl);
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  /** Upload, verify the patient link, and store the revision: the same steps the findings-review spec takes. */
  async function storedRevision() {
    const laboratoryId = `syn-lab-${randomUUID()}`;
    const source = JSON.parse(bytes().toString('utf8'));
    source.report.laboratoryId = laboratoryId;
    if (source.report.assay.state === 'provided') source.report.assay.manifest.laboratoryId = laboratoryId;
    const content = Buffer.from(JSON.stringify(source));
    const uploader: Person = await lab.person('uploader', ['clinician', 'reviewer']);
    const reviewer: Person = await lab.person('reviewer', ['reviewer']);
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
    const p = (await lab.api().get(`/api/v1/reports/${report.id}/structured-preview`).set(bearer(uploader.token)).expect(200)).body as StructuredPreview;
    const link = (
      await lab
        .api()
        .post(`/api/v1/reports/${report.id}/structured-preview/patient-link`)
        .set(bearer(reviewer.token))
        .send({
          patientId: p.patientId,
          sha256: p.source.sha256,
          objectVersion: p.source.objectVersion,
          sourcePatientReference: p.laboratoryReport.patientId,
          decision: 'verified',
          basisCode: 'documented-clinic-procedure',
        })
        .expect(201)
    ).body;
    const saved = (
      await lab
        .api()
        .post(`/api/v1/reports/${report.id}/structured-preview/record`)
        .set(bearer(uploader.token))
        .send({
          patientId: p.patientId,
          sha256: p.source.sha256,
          objectVersion: p.source.objectVersion,
          patientLinkDecisionId: link.id,
          sourcePatientReference: p.laboratoryReport.patientId,
        })
        .expect(201)
    ).body;
    return { uploader, reportId: report.id as string, patientId: patient.id as string, revisionId: saved.record.id as string, linkId: link.id as string };
  }

  const structuredInput = (s: Awaited<ReturnType<typeof storedRevision>>, over: object = {}) => ({
    ...evaluationFor({ tenantId: lab.tenant, uploader: 'x', patientId: s.patientId, reportId: s.reportId, pdfSha256: hash('x'), objectVersion: 'x', storageKey: 'x' }, '', '', {}),
    captureId: null,
    captureAcceptanceId: null,
    structuredRevisionId: s.revisionId,
    binding: { revisionId: s.revisionId },
    patientLinkDecisionId: s.linkId,
    ...over,
  });

  it('stores it with no capture, reads it back, and the ledger walks clean', async () => {
    const s = await storedRevision();
    const repo = app.get(LedgerRecordsRepository);
    const stored = await repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(s) as never);
    expect(stored.created).toBe(true);
    const rows = await lab.row<{ capture_id: string | null; capture_acceptance_id: string | null; source_kind: string; structured_revision_id: string }>(
      'SELECT capture_id::text, capture_acceptance_id::text, source_kind, structured_revision_id::text FROM evaluations WHERE id=$1',
      [stored.record.id],
    );
    expect(rows).toEqual([{ capture_id: null, capture_acceptance_id: null, source_kind: 'structured-revision', structured_revision_id: s.revisionId }]);
    // The read routes need the report-reader pipeline, which this checkout cannot run, so the read is exercised where the service builds it: the
    // repository's view, the mapper and the public schema. Production serves the same object once a later slice lifts the pipeline requirement.
    const view = await repo.evaluationView(lab.tenant, stored.record.id);
    expect(view).toBeDefined();
    const dto = evaluationDtoSchema.parse(
      toEvaluationDto(view!.record, { ...view!.context, current: view!.current, activeDisputes: view!.activeDisputes, patientLink: view!.patientLink }),
    );
    expect(dto).toMatchObject({ id: stored.record.id, captureId: null, acceptance: null, reportId: s.reportId, patientId: s.patientId });
    expect(await verifier.verify(lab.tenant, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
  });

  it('is the same evaluation when stored twice, and a different source is a different evaluation', async () => {
    const s = await storedRevision();
    const repo = app.get(LedgerRecordsRepository);
    const first = await repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(s) as never);
    const again = await repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(s) as never);
    expect(again.created).toBe(false);
    expect(again.record.id).toBe(first.record.id);
    const other = await storedRevision();
    const second = await repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(other) as never);
    expect(second.created).toBe(true);
  });

  it('refuses a revision that belongs to another report, and names exactly one source', async () => {
    const a = await storedRevision();
    const b = await storedRevision();
    const repo = app.get(LedgerRecordsRepository);
    // Control: the same input with its own revision is stored, so each refusal below is about what was changed.
    await expect(repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(a) as never)).resolves.toMatchObject({ created: true });
    await expect(
      repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(a, { structuredRevisionId: b.revisionId, binding: { other: 1 } }) as never),
    ).rejects.toBeInstanceOf(LedgerIntegrityError);
    await expect(repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(a, { captureId: randomUUID(), binding: { other: 2 } }) as never)).rejects.toThrow(
      /exactly one source/,
    );
    await expect(repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(a, { structuredRevisionId: undefined, binding: { other: 3 } }) as never)).rejects.toThrow(
      /exactly one source/,
    );
    await expect(repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(a, { captureAcceptanceId: randomUUID(), binding: { other: 4 } }) as never)).rejects.toThrow(
      /no capture acceptance/,
    );
  });

  it('puts the source in the ledger: changing it afterwards makes the walk fail (control: the untouched chain is ok)', async () => {
    const a = await storedRevision();
    const b = await storedRevision();
    const repo = app.get(LedgerRecordsRepository);
    const stored = await repo.insertEvaluation(lab.tenant, 'syn-system', structuredInput(a) as never);
    expect(await verifier.verify(lab.tenant, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
    // As the cluster superuser with triggers off (the append-only guard would refuse anything else): point the evaluation at another revision of the same
    // patient and report is impossible, so move only the column the projection should cover. The hashed projection must notice.
    await withAdmin(db.adminUrl, async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('UPDATE evaluations SET structured_revision_id = $1 WHERE id = $2', [b.revisionId, stored.record.id]);
      await c.query('COMMIT');
    });
    const after = await verifier.verify(lab.tenant, { mode: 'full' });
    expect(after.status).not.toBe('ok');
    expect(after.failures.length).toBeGreaterThan(0);
  });
});
