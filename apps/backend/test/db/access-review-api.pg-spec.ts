import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createTestApp } from '../helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';
import { bearer, signToken } from '../helpers/tokens';

// Spec 046 T-4 and T-5 through the API on PostgreSQL: a clinician's reads are written by the existing audit, and an admin's review resolves each one to
// its patient. Expected values are written by hand. Synthetic ids and labels only.
const ORG = `syn-ar-${randomUUID().slice(0, 8)}`;
const clinician = () => signToken({ sub: 'syn-ar-clinician', roles: ['clinician'], tenant: ORG });
const admin = () => signToken({ sub: 'syn-ar-admin', roles: ['admin'], tenant: ORG });
const outsider = () => signToken({ sub: 'syn-ar-other-admin', roles: ['admin'], tenant: `${ORG}-other` });

let pg: EphemeralDatabase;
let app: NestExpressApplication;
let database: Database;
let seeded: { patientId: string; reportId: string; evaluationId: string; label: string };

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  app = await createTestApp({ postgresUrl: pg.appUrl });
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  const ledger = new PostgresLedgerRecordsRepository(database);
  const label = `SYN-AR-${randomUUID().slice(0, 6)}`;
  const report = await seedLabReport(pg.adminUrl, ORG, { label });
  const capture = captureFor(report);
  const stored = await ledger.insertCapture(ORG, report.uploader, capture);
  const acceptance = await ledger.insertAcceptance(ORG, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
  await ledger.insertPatientDecision(ORG, 'syn-verifier', {
    reportId: report.reportId,
    expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
    decision: 'verified',
    method: 'person-confirmed',
    basisCode: 'no-identifier-on-report',
  });
  const evaluation = (await ledger.insertEvaluation(ORG, 'syn-system', evaluationFor(report, stored.record.id, acceptance.record.id))).record;
  seeded = { patientId: report.patientId, reportId: report.reportId, evaluationId: evaluation.id, label };
}, 120_000);
afterAll(async () => {
  await app?.close();
  await database?.onModuleDestroy();
  await pg?.drop();
});

const api = () => request(app.getHttpServer());
const window = () => ({ from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

it('T-4: a clinician opens a patient, its evaluations, an evaluation and a report; the review by that patient lists each, resolved to the patient', async () => {
  const token = await clinician();
  await api().get(`/api/v1/patients/${seeded.patientId}`).set(bearer(token)).expect(200);
  await api().get(`/api/v1/evaluations?patientId=${seeded.patientId}`).set(bearer(token)); // 200 or 503 by the pipeline switch; either is audited
  await api().get(`/api/v1/evaluations/${seeded.evaluationId}`).set(bearer(token));
  await api().get(`/api/v1/reports/${seeded.reportId}`).set(bearer(token)).expect(200);

  const res = await api().get('/api/v1/access-review').query({ patientId: seeded.patientId, ...window() }).set(bearer(await admin())).expect(200);
  const rows = res.body.data as Array<{ member: string; routeKey: string; subjectKind: string; subjectId: string | null; patientId: string | null; outcome: string }>;
  const byRoute = Object.fromEntries(rows.map((r) => [r.routeKey, r]));
  expect(byRoute['PatientsController.get']).toMatchObject({ member: 'syn-ar-clinician', subjectKind: 'patient', subjectId: seeded.patientId, patientId: seeded.patientId, outcome: 'succeeded' });
  expect(byRoute['EvaluationsController.list']).toMatchObject({ subjectKind: 'patient', subjectId: seeded.patientId, patientId: seeded.patientId });
  expect(byRoute['EvaluationsController.get']).toMatchObject({ subjectKind: 'evaluation', subjectId: seeded.evaluationId, patientId: seeded.patientId });
  expect(byRoute['ReportsController.get']).toMatchObject({ subjectKind: 'report', subjectId: seeded.reportId, patientId: seeded.patientId, outcome: 'succeeded' });
  expect(rows.every((r) => r.patientId === seeded.patientId)).toBe(true);
  expect(JSON.stringify(res.body)).not.toContain(seeded.label);

  const mine = await api().get('/api/v1/access-review').query({ member: 'syn-ar-clinician', ...window() }).set(bearer(await admin())).expect(200);
  expect(mine.body.data.length).toBeGreaterThanOrEqual(4);
  expect(mine.body.data.every((r: { member: string }) => r.member === 'syn-ar-clinician')).toBe(true);
});

it('T-5: the export is CSV with its header, holds no label, and another organisation sees none of these rows', async () => {
  const csv = await api().get('/api/v1/access-review/export').query({ patientId: seeded.patientId, ...window() }).set(bearer(await admin())).expect(200);
  expect(csv.headers['content-type']).toMatch(/^text\/csv/);
  const lines = csv.text.trim().split('\n');
  expect(lines[0]).toBe('occurred_at,member,route_key,event,outcome,subject_kind,subject_id,patient_id');
  expect(lines.length).toBeGreaterThanOrEqual(5);
  expect(csv.text).not.toContain(seeded.label);
  const foreign = await api().get('/api/v1/access-review').query({ patientId: seeded.patientId, ...window() }).set(bearer(await outsider())).expect(200);
  expect(foreign.body.data).toEqual([]);
  await api().get('/api/v1/access-review').query(window()).set(bearer(await clinician())).expect(403);
  await api().get('/api/v1/access-review/export').query(window()).set(bearer(await clinician())).expect(403);
});

it('the review itself is audited, and a refused filter is a 400', async () => {
  const id = `syn-ar-review-${randomUUID().slice(0, 8)}`;
  await api().get('/api/v1/access-review').query(window()).set(bearer(await admin())).set('X-Request-Id', id).expect(200);
  const rows = await withAdmin(pg.adminUrl, async (c) => (await c.query('SELECT event_type, route_key FROM security_audit_events WHERE request_id = $1', [id])).rows);
  expect(rows).toContainEqual({ event_type: 'private-read', route_key: 'AccessReviewController.list' });
  await api().get('/api/v1/access-review').query({ patientId: seeded.patientId, member: 'syn-ar-clinician', ...window() }).set(bearer(await admin())).expect(400);
  await api()
    .get('/api/v1/access-review')
    .query({ from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' })
    .set(bearer(await admin()))
    .expect(400);
});
