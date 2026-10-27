import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Principal } from '../src/auth/principal';
import { EvaluationsService, LAB_READER } from '../src/lab-reports/evaluations.service';
import { ReaderLimiter } from '../src/lab-reports/reader-limiter';
import type { ReaderResult } from '../src/services/report-reader/reader-result';
import type { ReportReader } from '../src/services/report-reader/report-reader';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline } from './helpers/lab-pipeline';
import { StandInReportReader } from './helpers/stand-in-reader';
import { bearer } from './helpers/tokens';

// H2: cancelling an evaluation, on the real stack (migrations, row-level security, the real ledger repository and storage) with the public synthetic
// fixture D01. The reader is the test stand-in, wrapped so a test can cancel while it reads; the wrapper IGNORES the signal and answers late, the worst
// case a reader can present. The HTTP route passes no signal, so cancellation is driven through EvaluationsService.create, the boundary a job handler
// will call; everything is asserted through the public API and the stored rows.
class LateAnsweringReader implements ReportReader {
  private readonly standIn = new StandInReportReader();
  reads = 0;
  whileReading: () => void = () => undefined;

  // Takes no options on purpose: the signal is never looked at.
  async read(text: string): Promise<ReaderResult> {
    this.reads++;
    this.whileReading();
    await new Promise((r) => setTimeout(r, 20));
    return this.standIn.read(text);
  }
}

(usingPostgres() ? describe : describe.skip)('cancelling a lab-report evaluation', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  const reader = new LateAnsweringReader();

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, overrides: [{ provide: LAB_READER, useValue: reader }] });
    lab = new LabPipeline(app, db.adminUrl);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await db.drop();
  });
  beforeEach(() => {
    reader.whileReading = () => undefined;
  });

  const principalOf = (sub: string): Principal => ({ sub, tenantId: lab.tenant, roles: ['clinician'] as Principal['roles'] });
  const listedFor = async (token: string, reportId: string) =>
    (await lab.api().get(`/api/v1/evaluations?reportId=${reportId}`).set(bearer(token)).expect(200)).body.meta.total as number;

  it('control: without cancellation the same request stores an evaluation', async () => {
    const setup = await lab.reviewedCapture(fixturePdf('D01'));
    const body = { captureId: setup.captureId, acceptanceId: setup.acceptanceId };

    await app.get(EvaluationsService).create(principalOf(setup.clinician.sub), setup.reportId, body, { signal: new AbortController().signal });

    expect(await listedFor(setup.clinician.token, setup.reportId)).toBe(1);
  }, 60_000);

  it('stores nothing when cancelled during a read whose reader answers late, and the request can then be made again', async () => {
    const setup = await lab.reviewedCapture(fixturePdf('D01'));
    const body = { captureId: setup.captureId, acceptanceId: setup.acceptanceId };
    const controller = new AbortController();
    reader.whileReading = () => controller.abort();

    const cancelled = app.get(EvaluationsService).create(principalOf(setup.clinician.sub), setup.reportId, body, { signal: controller.signal });

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(await listedFor(setup.clinician.token, setup.reportId)).toBe(0);
    expect(await lab.count('evaluations', 'report_id = $1', [setup.reportId])).toBe(0);
    expect(app.get(ReaderLimiter).active).toBe(0);
    reader.whileReading = () => undefined;
    await lab.evaluate(setup.clinician, setup.reportId, body).expect(201); // the cancelled attempt consumed nothing
    expect(await listedFor(setup.clinician.token, setup.reportId)).toBe(1);
  }, 60_000);

  it('does not read or store anything when already cancelled', async () => {
    const setup = await lab.reviewedCapture(fixturePdf('D01'));
    const controller = new AbortController();
    controller.abort();
    const readsBefore = reader.reads;

    const cancelled = app
      .get(EvaluationsService)
      .create(principalOf(setup.clinician.sub), setup.reportId, { captureId: setup.captureId, acceptanceId: setup.acceptanceId }, { signal: controller.signal });

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(reader.reads).toBe(readsBefore);
    expect(await listedFor(setup.clinician.token, setup.reportId)).toBe(0);
    expect(app.get(ReaderLimiter).active).toBe(0);
  }, 60_000);
});
