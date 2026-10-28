import type { NestExpressApplication } from '@nestjs/platform-express';
import { evaluationDtoSchema } from '@telesphoros/shared-types';
import { LedgerVerifier } from '../src/ledger/verifier';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// Spec 006, slice D01a: every result in an evaluation carries the id and ordinal of its stored row, so a later record (a clinician's decision) can name
// one exact result instead of a drug name or an array position. The oracle is the stored `evaluation_results` row, read through the administrator
// connection, never the code under test. Public synthetic fixture D01 with the stand-in reader; nothing here needs the engine.
(usingPostgres() ? describe : describe.skip)('the result reference in an evaluation', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let verifier: LedgerVerifier;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    lab = new LabPipeline(app, db.adminUrl);
    verifier = LedgerVerifier.connect(db.verifierUrl);
  }, 60_000);
  afterAll(async () => {
    await verifier.close();
    await app.close();
    await db.drop();
  });

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  type StoredResult = { id: string; ordinal: number; drug: string };

  async function evaluatedD01() {
    const s = await lab.reviewedCapture(fixturePdf('D01'));
    const created: Json = (await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
    const stored = await lab.row<StoredResult>('SELECT id::text AS id, ordinal, drug FROM evaluation_results WHERE evaluation_id = $1 ORDER BY ordinal', [created.id]);
    expect(stored.length).toBeGreaterThanOrEqual(2); // control: D01 shows drugq and drugr, so there is something to reference
    return { ...s, created, stored };
  }
  const references = (evaluation: Json) => (evaluation.results as Json[]).map((r) => ({ id: r.id, ordinal: r.ordinal, drug: r.drug }));

  it('the create response gives each result the id and ordinal of its stored row, in stored order', async () => {
    const { created, stored } = await evaluatedD01();
    expect(references(created)).toEqual(stored);
  });

  it('a later read of the same evaluation gives the same references', async () => {
    const { created, stored, clinician } = await evaluatedD01();
    const first: Json = (await lab.api().get(`/api/v1/evaluations/${created.id}`).set(bearer(clinician.token)).expect(200)).body;
    const second: Json = (await lab.api().get(`/api/v1/evaluations/${created.id}`).set(bearer(clinician.token)).expect(200)).body;
    expect(references(first)).toEqual(stored);
    expect(references(second)).toEqual(references(first));
  });

  it('every clinical reader sees the references; another tenant does not see the evaluation at all', async () => {
    const { created, stored } = await evaluatedD01();
    for (const roles of [['reader'], ['clinician'], ['reviewer']]) {
      const who = await lab.person('x', roles);
      expect(references((await lab.api().get(`/api/v1/evaluations/${created.id}`).set(bearer(who.token)).expect(200)).body)).toEqual(stored);
    }
    const outsider = await lab.person('x', ['clinician'], `${lab.tenant}-other`);
    // Control: the outsider is a working member of their own tenant, so the 404 below is the tenant boundary, not a refused caller.
    const own = (await lab.api().get('/api/v1/evaluations').set(bearer(outsider.token)).expect(200)).body;
    expect(own.data.map((e: Json) => e.id)).not.toContain(created.id);
    await lab.api().get(`/api/v1/evaluations/${created.id}`).set(bearer(outsider.token)).expect(404);
  });

  it('the response still parses with the shared strict schema, and that schema refuses a result without its id', async () => {
    const { created } = await evaluatedD01();
    expect(evaluationDtoSchema.safeParse(created).success).toBe(true);
    const { id: _dropped, ...withoutId } = created.results[0] as Json; // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(evaluationDtoSchema.safeParse({ ...created, results: [withoutId, ...created.results.slice(1)] }).success).toBe(false);
  });

  // An invariant, not proof of the change (it holds without it too): exposing the references must leave every ledger record verifiable.
  it('the tenant ledger still verifies with the references exposed', async () => {
    await evaluatedD01();
    expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
  });
});
