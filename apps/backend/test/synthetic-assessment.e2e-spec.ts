import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { evaluationDtoSchema } from '@telesphoros/shared-types';
import { ROLES_KEY } from '../src/auth/decorators';
import { EvaluationsController } from '../src/lab-reports/evaluations.controller';
import { EvaluationsService } from '../src/lab-reports/evaluations.service';
import { LabReportsModule } from '../src/lab-reports/lab-reports.module';
import { REQUIRES_PIPELINE, UNLOCKED_BY_SYNTHETIC_ASSESSMENT } from '../src/lab-reports/pipeline-switch';
import { StructuredBasisChangedError } from '../src/ledger/ledger-types';
import { LedgerVerifier } from '../src/ledger/verifier';
import { PatientLinkQuarantineController, ReportPatientLinkController } from '../src/patient-identity/patient-identity.controller';
import { StructuredPreviewController } from '../src/patient-identity/structured-preview.controller';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { LabPipeline } from './helpers/lab-pipeline';
import { structuredFixtures, type Prepared } from './helpers/structured-fixtures';
import { bearer } from './helpers/tokens';

// 032 S3, PR 3a: SYNTHETIC_ASSESSMENT is the switch that lets an environment holding only synthetic data (the synthetic staging) review, assess and read
// assessments of stored structured revisions WITHOUT the lab-report pipeline. These specs boot the application the way that environment runs (the switch on, no
// pipeline, no disposable local run) and walk the whole path over HTTP, then prove the switch opens exactly what it names and nothing else.
type ControllerClass = (new (...args: never[]) => object) & { prototype: Record<string, unknown> };
const ID = '00000000-0000-4000-8000-000000000001';
const REVIEWS = { 'syn-finding-a': 'accepted-as-evidence', 'syn-finding-b': 'accepted-as-evidence' } as const;

function routesOf(controller: ControllerClass) {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, controller.prototype[name] as object) !== undefined)
    .map((name) => ({
      method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, controller.prototype[name] as object) as number]!,
      path: `/api/v1/${base}/${Reflect.getMetadata(PATH_METADATA, controller.prototype[name] as object) as string}`.replace(':id', ID).replace(/\/+/g, '/').replace(/\/$/, ''),
      roles: Reflect.getMetadata(ROLES_KEY, controller.prototype[name] as object) as string[] | undefined,
    }));
}

const pipelineControllers = [
  ...(Reflect.getMetadata('controllers', LabReportsModule) as ControllerClass[]),
  ReportPatientLinkController,
  PatientLinkQuarantineController,
] as ControllerClass[];
const everyControllerTheSwitchCouldTouch = [...pipelineControllers, StructuredPreviewController as unknown as ControllerClass];

describe('what the switch opens (no database needed)', () => {
  it('is exactly the evaluation reads, the assessment route and the structured preview, by their own marks', () => {
    const unlocked = everyControllerTheSwitchCouldTouch.filter((c) => Reflect.getMetadata(UNLOCKED_BY_SYNTHETIC_ASSESSMENT, c) === true).map((c) => c.name);
    expect(unlocked.sort()).toEqual(['EvaluationsController', 'StructuredAssessmentController', 'StructuredPreviewController']);
  });

  it('opens only reads of evaluations: every route of the evaluations controller is a GET', () => {
    expect(routesOf(EvaluationsController as unknown as ControllerClass).map((r) => r.method)).toEqual(['GET', 'GET']);
  });

  it('leaves every other pipeline route behind the pipeline gate alone (decisions, acknowledgements, renders, disputes, corrections, captures, requests, the ledger)', () => {
    const rest = pipelineControllers.filter((c) => Reflect.getMetadata(UNLOCKED_BY_SYNTHETIC_ASSESSMENT, c) !== true);
    expect(rest.length).toBeGreaterThanOrEqual(10);
    for (const controller of rest) expect(Reflect.getMetadata(REQUIRES_PIPELINE, controller)).toBe(true);
  });
});

(usingPostgres() && usingS3() ? describe : describe.skip)('the synthetic structured assessment over HTTP (real PostgreSQL/S3, the switch on, no pipeline)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let prepare: ReturnType<typeof structuredFixtures>['prepare'];
  let verifier: LedgerVerifier;

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl, syntheticAssessment: true });
    lab = new LabPipeline(app, db.adminUrl);
    prepare = structuredFixtures(lab).prepare;
    verifier = LedgerVerifier.connect(db.verifierUrl);
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const assess = (s: Prepared, who = s.uploader) => lab.api().post(`/api/v1/reports/${s.reportId}/structured-assessment`).set(bearer(who.token));
  const cell = (r: { outcome: string; strength: string | null; recommendationText: string | null }) => ({ outcome: r.outcome, strength: r.strength, text: r.recommendationText });

  it('walks upload, independent review, assessment and read over HTTP, and reads back the same stored evaluation', async () => {
    const s = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: REVIEWS });
    const created = await assess(s).expect(201);
    const dto = evaluationDtoSchema.parse(created.body);
    expect(dto).toMatchObject({
      disposition: 'evaluated',
      holdCode: null,
      captureId: null,
      scope: 'synthetic-structured-assessment',
      reportId: s.reportId,
      patientId: s.patientId,
    });
    // Hand-written from the fixtures: GENEA *1/*1 is Normal and GENEB *3/*3 (activity 0) is Low.
    expect(cell(dto.results.find((r) => r.drug === 'drugz')!)).toEqual({ outcome: 'shown', strength: 'Strong', text: 'Z normal-low.' });
    expect(cell(dto.results.find((r) => r.drug === 'drugq')!)).toEqual({ outcome: 'shown', strength: 'Strong', text: 'Q normal.' });

    // The same assessment again is the same evaluation (200), and both reads answer without the pipeline.
    const again = await assess(s).expect(200);
    expect(again.body.id).toBe(dto.id);
    const reviewer = await lab.person('reader', ['reviewer']);
    const read = await lab.api().get(`/api/v1/evaluations/${dto.id}`).set(bearer(reviewer.token)).expect(200);
    expect(evaluationDtoSchema.parse(read.body).id).toBe(dto.id);
    const list = await lab.api().get(`/api/v1/evaluations?patientId=${s.patientId}`).set(bearer(reviewer.token)).expect(200);
    expect(list.body.data.map((e: { id: string }) => e.id)).toContain(dto.id);
    expect(await verifier.verify(lab.tenant, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
  });

  it('assesses the demonstration package as it is stored in the repository, byte for byte', async () => {
    const bytes = readFileSync(resolve(__dirname, '../../../data/fixtures/pgx-structured-demo/package.json'));
    const s = await prepare({}, { bytes, reviews: REVIEWS });
    const dto = evaluationDtoSchema.parse((await assess(s).expect(201)).body);
    expect(dto).toMatchObject({ disposition: 'evaluated', holdCode: null });
    expect(Object.fromEntries(dto.results.map((r) => [r.drug, r.recommendationText]))).toEqual({ drugq: 'Q normal.', drugz: 'Z normal-low.' });
  });

  it('stores a held assessment with its fixed wording when a finding has no independent review', async () => {
    const s = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
    const body = evaluationDtoSchema.parse((await assess(s).expect(201)).body);
    expect(body).toMatchObject({ disposition: 'held', holdCode: 'findings-not-reviewed', results: [] });
    expect(body.hold?.message).toMatch(/second person has not yet accepted/);
  });

  it('refuses a caller who may not assess, and a report with no verified patient link, with nothing stored', async () => {
    const s = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
    const reader = await lab.person('plain', ['reader']);
    await assess(s, reader).expect(403);
    await lab.api().post(`/api/v1/reports/${s.reportId}/structured-assessment`).expect(401);
    const stranger = await prepare({ a: '*1/*1' }, { save: false });
    await lab
      .api()
      .post(`/api/v1/reports/${stranger.reportId}/structured-preview/patient-link`)
      .set(bearer(stranger.reviewer.token))
      .send({
        patientId: stranger.binding.patientId,
        sha256: stranger.binding.sha256,
        objectVersion: stranger.binding.objectVersion,
        sourcePatientReference: stranger.binding.sourcePatientReference,
        decision: 'rejected',
        basisCode: 'different-person',
      })
      .expect(201);
    await assess(stranger).expect(409);
    expect(await lab.count('evaluations', 'report_id = $1', [stranger.reportId])).toBe(0);
  });

  it('keeps every other pipeline route shut: 503 PIPELINE_DISABLED for someone allowed, with the switch on', async () => {
    const rest = pipelineControllers.filter((c) => Reflect.getMetadata(UNLOCKED_BY_SYNTHETIC_ASSESSMENT, c) !== true).flatMap(routesOf);
    expect(rest.length).toBeGreaterThanOrEqual(20);
    for (const route of rest) {
      const who = await lab.person('allowed', route.roles ?? ['reader']);
      const call = lab.api()[route.method.toLowerCase() as 'get' | 'post'](route.path).set(bearer(who.token));
      const res = route.method === 'POST' ? await call.send({}) : await call;
      expect({ route: `${route.method} ${route.path}`, status: res.status, code: res.body?.error?.code }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 503,
        code: 'PIPELINE_DISABLED',
      });
    }
  });

  describe('the stored evidence is read again after the ledger lock', () => {
    const review = (s: Prepared, findingId: string, decision: string) =>
      lab
        .api()
        .post(`/api/v1/reports/${s.reportId}/structured-preview/review`)
        .set(bearer(s.reviewer.token))
        .send({
          requestId: randomUUID(),
          revisionId: s.revisionId,
          patientId: s.binding.patientId,
          sha256: s.binding.sha256,
          objectVersion: s.binding.objectVersion,
          patientLinkDecisionId: s.binding.patientLinkDecisionId,
          findingId,
          decision,
          reasonCode: decision === 'accepted-as-evidence' ? 'matches-source' : 'needs-clarification',
        })
        .expect(201);

    it('plans again on what changed between the plan and the insert (a review that landed meanwhile is used, and the assessment is not stored on the old one)', async () => {
      const s = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      const repo = app.get(LedgerRecordsRepository);
      const original = repo.insertEvaluation.bind(repo);
      let calls = 0;
      const spy = jest.spyOn(repo, 'insertEvaluation').mockImplementation(async (...args) => {
        calls++;
        // After the plan (finding b still unreviewed) and before the insert, the second person accepts finding b.
        if (calls === 1) await review(s, 'syn-finding-b', 'accepted-as-evidence');
        return original(...args);
      });
      try {
        const outcome = await app.get(EvaluationsService).assessStructured({ sub: 'syn-system', tenantId: lab.tenant, roles: [] }, s.reportId);
        expect(calls).toBe(2);
        expect(outcome.evaluation).toMatchObject({ disposition: 'evaluated', holdCode: null });
      } finally {
        spy.mockRestore();
      }
      const [row] = await lab.row<{ n: number }>("SELECT count(*)::int AS n FROM evaluations WHERE report_id = $1 AND disposition = 'held'", [s.reportId]);
      expect(row!.n).toBe(0);
    });

    it('plans again when a source resolution landed meanwhile (the conflict it was held for is settled, so the hold changes)', async () => {
      const first = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      const second = await prepare({ a: '*1/*1' }, { same: first, mutate: (pkg) => (pkg.report.limitations = ['A changed source at the same laboratory revision.']) });
      const repo = app.get(LedgerRecordsRepository);
      const original = repo.insertEvaluation.bind(repo);
      let calls = 0;
      const spy = jest.spyOn(repo, 'insertEvaluation').mockImplementation(async (...args) => {
        calls++;
        // After the plan (the two sources conflict) and before the insert, the second person chooses the second source.
        if (calls === 1)
          await lab
            .api()
            .post(`/api/v1/reports/${second.reportId}/structured-preview/source-resolution`)
            .set(bearer(second.reviewer.token))
            .send({
              requestId: randomUUID(),
              patientId: second.binding.patientId,
              laboratoryId: second.laboratoryId,
              seriesId: 'syn-series-1',
              revision: 1,
              revisionIds: [first.revisionId, second.revisionId],
              outcome: 'use-revision',
              chosenRevisionId: second.revisionId,
              reasonCode: 'verified-against-laboratory',
            })
            .expect(201);
        return original(...args);
      });
      try {
        const outcome = await app.get(EvaluationsService).assessStructured({ sub: 'syn-system', tenantId: lab.tenant, roles: [] }, second.reportId);
        expect(calls).toBe(2);
        // Planned as a conflict, stored on what the ledger held at the lock: the chosen source, whose findings no one has reviewed yet.
        expect(outcome.evaluation).toMatchObject({ disposition: 'held', holdCode: 'findings-not-reviewed' });
      } finally {
        spy.mockRestore();
      }
      expect(await lab.count('evaluations', "report_id = $1 AND hold_code = 'source-conflict'", [second.reportId])).toBe(0);
    });

    it('gives up when the evidence keeps changing, and stores nothing', async () => {
      const s = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      const repo = app.get(LedgerRecordsRepository);
      const original = repo.insertEvaluation.bind(repo);
      let calls = 0;
      const spy = jest.spyOn(repo, 'insertEvaluation').mockImplementation(async (...args) => {
        calls++;
        await review(s, 'syn-finding-b', calls % 2 === 1 ? 'held' : 'accepted-as-evidence');
        return original(...args);
      });
      try {
        await expect(app.get(EvaluationsService).assessStructured({ sub: 'syn-system', tenantId: lab.tenant, roles: [] }, s.reportId)).rejects.toBeInstanceOf(
          StructuredBasisChangedError,
        );
        expect(calls).toBe(3);
      } finally {
        spy.mockRestore();
      }
      expect(await lab.count('evaluations', 'report_id = $1', [s.reportId])).toBe(0);
    });
  });

  it('is controlled: with the switch off the same route is shut (the default app has no assessment route open)', async () => {
    const off = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
    try {
      const offLab = new LabPipeline(off, db.adminUrl, lab.tenant);
      const who = await offLab.person('clinician', ['clinician', 'reviewer']);
      const res = await offLab.api().post(`/api/v1/reports/${ID}/structured-assessment`).set(bearer(who.token)).send({});
      expect(res.status).toBe(503);
      expect(res.body.error.code).not.toBe('NOT_FOUND');
      const read = await offLab.api().get(`/api/v1/evaluations/${ID}`).set(bearer(who.token));
      expect({ status: read.status, code: read.body.error.code }).toEqual({ status: 503, code: 'PIPELINE_DISABLED' });
    } finally {
      await off.close();
    }
  });
});
