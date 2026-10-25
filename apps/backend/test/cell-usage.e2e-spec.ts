import type { NestExpressApplication } from '@nestjs/platform-express';
import { cellUsageDtoSchema } from '@telesphoros/shared-types';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { LedgerVerifier } from '../src/ledger/verifier';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

(usingPostgres() ? describe : describe.skip)('cell usage listing', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
  }, 60000);
  beforeEach(() => {
    lab = new LabPipeline(app, db.adminUrl);
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });
  it('lists exact file matches, withheld citations, corrected history and pagination, without wording or a ledger write', async () => {
    const clin = await lab.person('clin', ['clinician']);
    const rev = await lab.person('rev', ['reviewer']);
    const capture = await lab.reviewedCapture(fixturePdf('D01'), { clinician: clin, reviewer: rev });
    const e = (await lab.evaluate(clin, capture.reportId, { captureId: capture.captureId, acceptanceId: capture.acceptanceId }).expect(201)).body;
    const result = e.results.find((r: { drug: string }) => r.drug === 'drugq');
    const dispute = (
      await lab
        .api()
        .post('/api/v1/cell-disputes')
        .set(bearer(rev.token))
        .send({ guidelineId: result.citation.guidelineId, locator: { table: result.citation.locator.table, row: result.citation.locator.row }, note: 'SYN dispute' })
        .expect(201)
    ).body;
    const later = (await lab.evaluate(clin, capture.reportId, { captureId: capture.captureId, acceptanceId: capture.acceptanceId }).expect(201)).body;
    await lab.api().post(`/api/v1/evaluations/${e.id}/corrections`).set(bearer(rev.token)).send({ kind: 'retraction', reasonCode: 'knowledge-error-found' }).expect(201);
    const count = await lab.count('ledger_events', 'tenant_id = $1', [lab.tenant]);
    const url = `/api/v1/cell-disputes/${dispute.id}/evaluations`;
    const one = (await lab.api().get(url).query({ limit: '1' }).set(bearer(clin.token)).expect(200)).body;
    expect(cellUsageDtoSchema.safeParse(one).success).toBe(true);
    expect(one.entries).toMatchObject([{ evaluationId: e.id, state: 'retracted', matches: [{ identity: 'exact-file', wordingExposed: true }] }]);
    const two = (await lab.api().get(url).query({ limit: '1', afterSeq: one.nextAfterSeq }).set(bearer(rev.token)).expect(200)).body;
    expect(two.entries).toMatchObject([{ evaluationId: later.id, matches: [{ identity: 'exact-file', wordingExposed: false, outcome: 'held' }] }]);
    expect(two.nextAfterSeq).toBeNull();
    expect(JSON.stringify(one)).not.toMatch(/recommendationText|patientId|geneInputs|note|SYN dispute/);
    expect(await lab.count('ledger_events', 'tenant_id = $1', [lab.tenant])).toBe(count);
    const stored = await app.get(LedgerRecordsRepository).findEvaluation(lab.tenant, e.id);
    expect(stored!.binding).toHaveProperty('cellProvenance.version', 'cell-provenance/1');
    const verifier = LedgerVerifier.connect(db.verifierUrl);
    try {
      expect(await verifier.verify(lab.tenant, { mode: 'full' })).toMatchObject({ status: 'ok' });
    } finally {
      await verifier.close();
    }
    const reader = await lab.person('reader', ['reader']);
    await lab.api().get(url).set(bearer(reader.token)).expect(403);
    await lab.api().get(url).expect(401);
    const foreign = await new LabPipeline(app, db.adminUrl).person('foreign', ['reviewer']);
    await lab.api().get(url).set(bearer(foreign.token)).expect(404);
    await lab.api().get(url).query({ limit: '101' }).set(bearer(rev.token)).expect(400);
    await lab.api().get(url).query({ afterSeq: '-1' }).set(bearer(rev.token)).expect(400);
  });
});
