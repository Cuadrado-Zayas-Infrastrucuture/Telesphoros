import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { type ClaimedJob, evaluationRequest, JobQueue } from '@telesphoros/jobs';
import type { EvaluationExecutionProfile } from '@telesphoros/shared-types';
import { Database } from '../src/db/database';
import { EvaluationRequestConsumer } from '../src/lab-reports/evaluation-request-consumer';
import { EvaluationRequestsService } from '../src/lab-reports/evaluation-requests.service';
import { EvaluationsService, LAB_KNOWLEDGE } from '../src/lab-reports/evaluations.service';
import { TextCaptureRunner } from '../src/lab-reports/runner/text-capture-runner';
import type { KnowledgeSet } from '../src/services/knowledge/knowledge-set';
import { EvaluationRequestsRepository } from '../src/storage/postgres/evaluation-requests.repository';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, sha } from './helpers/lab-pipeline';

// Spec 020 E1a, one test per create path: the capture, the evaluation made on request (sync), and the evaluation made by the queued worker. Each must leave
// exactly one provenance row, with the values the slice plan names, written by the server (no request field sets the origin). The real stack, synthetic D01.
(usingPostgres() ? describe : describe.skip)('data provenance on every create path', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let workerPool: Pool;
  let queue: JobQueue;
  let profile: EvaluationExecutionProfile;

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    lab = new LabPipeline(app, db.adminUrl);
    workerPool = new Pool({ connectionString: db.workerUrl, max: 4 });
    queue = new JobQueue(workerPool);
    profile = {
      version: 'evaluation-execution-profile/1',
      codeArtifactSha256: sha('synthetic code artifact'),
      executionManifestSha256: sha('synthetic self-hosted manifest'),
      knowledgeSetId: app.get<KnowledgeSet>(LAB_KNOWLEDGE).id,
      recordingsSha256: app.get(TextCaptureRunner).manifestSha256,
    };
  }, 60_000);
  afterAll(async () => {
    await workerPool?.end();
    await app?.close();
    await db?.drop();
  });

  const provenance = (column: 'capture_id' | 'evaluation_id', id: string) => lab.row<Record<string, unknown>>(`SELECT * FROM data_provenance WHERE ${column} = $1`, [id]);

  it('capture: one row, synthetic, from the stored report and the runner, with the report as its parent', async () => {
    const clinician = await lab.person('clin', ['clinician']);
    const up = await lab.uploadedLabPdf(clinician, fixturePdf('D01'));
    const made = await lab.capture(clinician, up.reportId).expect(201);
    const [report] = await lab.row<{ uploaded_at: Date; object_version: string }>('SELECT uploaded_at, object_version FROM reports WHERE id = $1', [up.reportId]);

    const [row, ...more] = await provenance('capture_id', made.body.id);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      tenant_id: lab.tenant,
      created_by: clinician.sub,
      subject_kind: 'capture',
      evaluation_id: null,
      origin: 'synthetic',
      interpretation: null,
      document_sha256: up.pdfSha256,
      object_version: report!.object_version,
      transform_runner: 'fake',
      transform_poppler_version: '26.03.0',
      transform_engine_version: null,
      transform_knowledge_set_id: null,
      parent_kind: 'report',
      parent_id: up.reportId,
      source_organization: null,
      source_type: null,
      context: null,
      collection_location: null,
    });
    expect((row!.received_at as Date).getTime()).toBe(report!.uploaded_at.getTime());
    expect(await lab.count('ledger_events', `subject_table = 'data_provenance' AND subject_id = $1`, [row!.id])).toBe(1);

    // The same capture again is the same fact: no second row.
    await lab.capture(clinician, up.reportId).expect(200);
    expect(await provenance('capture_id', made.body.id)).toHaveLength(1);
  });

  it('evaluation on request: one row, synthetic and software-derived, from the capture and the engine, with the acceptance as its parent', async () => {
    const setup = await lab.reviewedCapture(fixturePdf('D01'));
    const created = await lab.evaluate(setup.clinician, setup.reportId, { captureId: setup.captureId, acceptanceId: setup.acceptanceId }).expect(201);
    const [stored] = await lab.row<{ knowledge_set_id: string; engine_version: string }>('SELECT knowledge_set_id, engine_version FROM evaluations WHERE id = $1', [
      created.body.id,
    ]);

    const [row, ...more] = await provenance('evaluation_id', created.body.id);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      tenant_id: lab.tenant,
      created_by: setup.clinician.sub,
      subject_kind: 'evaluation',
      capture_id: null,
      origin: 'synthetic',
      interpretation: 'software-derived',
      document_sha256: setup.upload.pdfSha256,
      object_version: null,
      received_at: null,
      transform_runner: null,
      transform_poppler_version: null,
      transform_engine_version: stored!.engine_version,
      transform_knowledge_set_id: stored!.knowledge_set_id,
      parent_kind: 'capture-acceptance',
      parent_id: setup.acceptanceId,
      source_organization: null,
      source_type: null,
      context: null,
      collection_location: null,
    });
    expect(stored!.engine_version.length).toBeGreaterThan(0);
    expect(await lab.count('ledger_events', `subject_table = 'data_provenance' AND subject_id = $1`, [row!.id])).toBe(1);

    // Asked again, the same evaluation is returned and no second row is written.
    await lab.evaluate(setup.clinician, setup.reportId, { captureId: setup.captureId, acceptanceId: setup.acceptanceId }).expect(200);
    expect(await provenance('evaluation_id', created.body.id)).toHaveLength(1);
  }, 60_000);

  it('evaluation by the queued worker: one row, written in the transaction that stores the evaluation and its completion', async () => {
    const setup = await lab.reviewedCapture(fixturePdf('D01'));
    const principal = { tenantId: lab.tenant, sub: setup.clinician.sub, roles: ['clinician' as const] };
    const { request } = await new EvaluationRequestsService(new EvaluationRequestsRepository(app.get(Database)), profile).admit(principal, {
      requestId: randomUUID(),
      reportId: setup.reportId,
      captureId: setup.captureId,
      acceptanceId: setup.acceptanceId,
    });
    let job: ClaimedJob | undefined;
    for (let i = 0; !job && i < 20; i++) {
      const claimed = await queue.claim('w-provenance', { types: [evaluationRequest.type], batch: 10, tenantCap: 50, leaseSeconds: 60 });
      job = claimed.find((j) => j.id === request.jobId);
      for (const other of claimed.filter((j) => j !== job)) await queue.release(other.id, 'w-provenance');
    }
    if (!job) throw new Error('The job was not claimed.');
    expect(await provenance('evaluation_id', randomUUID())).toEqual([]); // control: the lookup finds nothing for an evaluation that does not exist

    await new EvaluationRequestConsumer(app.get(Database), app.get(EvaluationsService), profile).handle({ job, workerId: 'w-provenance', signal: new AbortController().signal });

    const [completion] = await lab.row<{ evaluation_id: string }>('SELECT evaluation_id::text FROM evaluation_request_completions WHERE request_id = $1', [request.id]);
    expect(completion).toBeDefined();
    const [row, ...more] = await provenance('evaluation_id', completion!.evaluation_id);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      tenant_id: lab.tenant,
      created_by: setup.clinician.sub, // the worker acts for the requester, as the evaluation itself records
      subject_kind: 'evaluation',
      origin: 'synthetic',
      interpretation: 'software-derived',
      document_sha256: setup.upload.pdfSha256,
      transform_knowledge_set_id: profile.knowledgeSetId,
      parent_kind: 'capture-acceptance',
      parent_id: setup.acceptanceId,
    });
    expect(await lab.count('ledger_events', `subject_table = 'data_provenance' AND subject_id = $1`, [row!.id])).toBe(1);
  }, 60_000);

  it('no request field sets the origin: a body that names one stores a synthetic row or is refused, and nothing stores `real`', async () => {
    const setup = await lab.reviewedCapture(fixturePdf('D01'));
    const response = await lab.evaluate(setup.clinician, setup.reportId, { captureId: setup.captureId, acceptanceId: setup.acceptanceId, origin: 'real' });
    expect([201, 200, 400]).toContain(response.status);
    expect(await lab.count('data_provenance', `origin = 'real'`)).toBe(0);
    const clinician = await lab.person('clin', ['clinician']);
    const up = await lab.uploadedLabPdf(clinician, fixturePdf('D01'));
    await lab.capture(clinician, up.reportId).send({ origin: 'real' });
    expect(await lab.count('data_provenance', `origin = 'real'`)).toBe(0);
  }, 60_000);
});
