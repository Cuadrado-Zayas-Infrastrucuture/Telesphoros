import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { evaluationDtoSchema, quarantineEntryDtoSchema } from '@telesphoros/shared-types';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { fixturePdf, LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

/**
 * Wrong-chart quarantine (M2.1c-1). A report is quarantined when the newest patient-link decision names the file and patient it holds now and
 * says `rejected`. Nothing is stored for that: it is derived, shown on every evaluation read, removes the report's evaluations from "current", and
 * puts the report on a reviewer's work list until each active evaluation is retracted by a person. Synthetic data only.
 */
(usingPostgres() ? describe : describe.skip)('wrong-chart quarantine', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
    lab = new LabPipeline(app, db.adminUrl);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const read = (who: Person, id: string) => lab.api().get(`/api/v1/evaluations/${id}`).set(bearer(who.token));
  const list = (who: Person, query = '') => lab.api().get(`/api/v1/evaluations${query}`).set(bearer(who.token));
  const queue = (who: Person, query = '') => lab.api().get(`/api/v1/patient-link/quarantine${query}`).set(bearer(who.token));
  const reject = (who: Person, reportId: string, basisCode = 'different-person') => lab.decideLink(who, reportId, { decision: 'rejected', method: 'person-confirmed', basisCode });
  const retract = (who: Person, evaluationId: string) =>
    lab.api().post(`/api/v1/evaluations/${evaluationId}/corrections`).set(bearer(who.token)).send({ kind: 'retraction', reasonCode: 'wrong-patient' });

  /** A fresh organization-wide scenario: a verified report with one evaluation, and an independent reviewer who rejects. */
  async function scenario(tenantLab: LabPipeline = lab) {
    const s = await tenantLab.reviewedCapture(fixturePdf('D01'));
    const e: Json = (await tenantLab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
    const rejecter = await tenantLab.person('rejecter', ['reviewer']);
    return { ...s, e, rejecter };
  }

  describe('what a rejected link does to an evaluation that already exists', () => {
    it('shows the link state on the evaluation, and takes the evaluation out of "current" without touching its history', async () => {
      const s = await scenario();
      expect(s.e.advisory).toEqual({ activeDisputes: 0, patientLink: 'verified' });
      expect(s.e).toMatchObject({ current: true, state: 'active' });

      await reject(s.rejecter, s.reportId).expect(201);
      const after = (await read(s.clinician, s.e.id).expect(200)).body;
      expect(evaluationDtoSchema.safeParse(after).success).toBe(true);
      expect(after).toMatchObject({ advisory: { patientLink: 'rejected' }, current: false, state: 'active', corrections: [] });
      // Everything but the derived reading is exactly as it was stored.
      const { advisory: _a, current: _c, ...before } = s.e; // eslint-disable-line @typescript-eslint/no-unused-vars
      const { advisory: _b, current: _d, ...kept } = after; // eslint-disable-line @typescript-eslint/no-unused-vars
      expect(kept).toEqual(before);
      // The listing: still in history, no longer current.
      const all = (await list(s.clinician, `?reportId=${s.reportId}`).expect(200)).body.data as Json[];
      expect(all).toEqual([expect.objectContaining({ id: s.e.id, current: false, advisory: expect.objectContaining({ patientLink: 'rejected' }) })]);
      expect((await list(s.clinician, `?reportId=${s.reportId}&current=true`).expect(200)).body.data).toEqual([]);
    });

    it('is lifted by a later verification of the same file (a second look): the evaluation is current again, and nothing was written to it', async () => {
      const s = await scenario();
      await reject(s.rejecter, s.reportId).expect(201);
      expect((await read(s.clinician, s.e.id)).body.current).toBe(false);
      await lab.verifyLink(await lab.person('rev3', ['reviewer']), s.reportId).expect(201);
      const back = (await read(s.clinician, s.e.id).expect(200)).body;
      expect(back).toMatchObject({ current: true, state: 'active', advisory: { patientLink: 'verified' }, corrections: [] });
      expect((await list(s.clinician, `?reportId=${s.reportId}&current=true`)).body.data.map((e: Json) => e.id)).toEqual([s.e.id]);
    });

    it('is about the file it names: after a replacement the report reads as unverified, not quarantined, and its evaluation is current again', async () => {
      const s = await scenario();
      await reject(s.rejecter, s.reportId).expect(201);
      await withAdmin(db.adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query('ALTER TABLE reports DISABLE TRIGGER USER'); // the product refuses to change an uploaded file; the owner can, once, on purpose
        await c.query(`UPDATE reports SET object_version = 'replaced-' || object_version WHERE id = $1`, [s.reportId]);
        await c.query('ALTER TABLE reports ENABLE TRIGGER USER');
        await c.query('COMMIT');
      });
      expect(await read(s.clinician, s.e.id)).toMatchObject({ body: { advisory: { patientLink: 'unverified' }, current: true } });
      expect((await queue(await lab.person('rv', ['reviewer']))).body.data.map((x: Json) => x.reportId)).not.toContain(s.reportId);
    });

    it('is derived only from the report in question: another report of the same patient is unaffected', async () => {
      const s = await scenario();
      const other = await lab.reviewedCapture(fixturePdf('D02'), { clinician: s.clinician, reviewer: s.reviewer });
      const otherEval: Json = (await lab.evaluate(s.clinician, other.reportId, { captureId: other.captureId, acceptanceId: other.acceptanceId }).expect(201)).body;
      await reject(s.rejecter, s.reportId).expect(201);
      expect((await read(s.clinician, otherEval.id)).body).toMatchObject({ current: true, advisory: { patientLink: 'verified' } });
    });
  });

  describe('the reviewer work list', () => {
    it('lists a quarantined report with its active evaluations and the coded reason, oldest first, and nothing else', async () => {
      const org = new LabPipeline(app, db.adminUrl, `org-${randomUUID().slice(0, 6)}`);
      const first = await scenario(org);
      const second = await scenario(org);
      const fine = await scenario(org); // verified, never rejected: must not appear
      const viewer = await org.person('viewer', ['reviewer']);
      await reject(first.rejecter, first.reportId, 'identifier-conflict').expect(201);
      await reject(second.rejecter, second.reportId, 'cannot-establish').expect(201);

      const body = (await queue(viewer).expect(200)).body;
      expect(body.meta.total).toBe(2);
      for (const entry of body.data) expect(quarantineEntryDtoSchema.safeParse(entry).success).toBe(true);
      expect(body.data).toEqual([
        { reportId: first.reportId, patientId: first.patientId, basisCode: 'identifier-conflict', rejectedAt: expect.any(String), activeEvaluationIds: [first.e.id] },
        { reportId: second.reportId, patientId: second.patientId, basisCode: 'cannot-establish', rejectedAt: expect.any(String), activeEvaluationIds: [second.e.id] },
      ]);
      expect(JSON.stringify(body)).not.toContain(fine.reportId);
      // Paging: one per page, with exact totals, in the same order.
      const page1 = (await queue(viewer, '?page=1&pageSize=1').expect(200)).body;
      const page2 = (await queue(viewer, '?page=2&pageSize=1').expect(200)).body;
      expect([page1.data.map((x: Json) => x.reportId), page2.data.map((x: Json) => x.reportId), page1.meta.total, page2.meta.total]).toEqual([
        [first.reportId],
        [second.reportId],
        2,
        2,
      ]);
      expect((await queue(viewer, '?page=3&pageSize=1').expect(200)).body).toMatchObject({ data: [], meta: { total: 2 } });
    });

    it('drops a report once every evaluation on it is retracted by a person, and the system writes no correction by itself', async () => {
      const s = await scenario();
      // A second evaluation of the same report (a second, later acceptance by another reviewer gives it a different identity).
      const reviewer2 = await lab.person('rev2', ['reviewer']);
      const a2 = (await lab.decide(reviewer2, s.captureId, { decision: 'accepted' }).expect(201)).body.id as string;
      const e2: Json = (await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: a2 }).expect(201)).body;
      const corrections = () => lab.count('corrections', 'tenant_id = $1', [lab.tenant]);
      const before = await corrections();

      await reject(s.rejecter, s.reportId).expect(201);
      expect(await corrections()).toBe(before); // rejecting a link records no correction
      const mine = async () => ((await queue(s.rejecter).expect(200)).body.data as Json[]).find((x) => x.reportId === s.reportId);
      expect((await mine())?.activeEvaluationIds).toEqual([s.e.id, e2.id]);

      await retract(s.rejecter, e2.id).expect(201);
      expect((await mine())?.activeEvaluationIds).toEqual([s.e.id]);
      await retract(s.rejecter, s.e.id).expect(201);
      expect(await mine()).toBeUndefined(); // nothing active is left; the report stays quarantined but needs no more action
      expect((await read(s.clinician, s.e.id)).body).toMatchObject({ state: 'retracted', advisory: { patientLink: 'rejected' }, current: false });
    });

    it('drops a report that is verified again, and an evaluation reinstated afterwards by another person puts it back', async () => {
      const s = await scenario();
      await reject(s.rejecter, s.reportId).expect(201);
      await retract(s.rejecter, s.e.id).expect(201);
      const retraction = (await read(s.clinician, s.e.id)).body.corrections[0];
      await lab.verifyLink(await lab.person('rev3', ['reviewer']), s.reportId).expect(201);
      const ids = async () => ((await queue(s.rejecter)).body.data as Json[]).map((x) => x.reportId);
      expect(await ids()).not.toContain(s.reportId);
      // Rejected again later, and the earlier retraction is reinstated by someone else: the evaluation is active on a quarantined report, so it is listed.
      await reject(await lab.person('rev4', ['reviewer']), s.reportId).expect(201);
      await lab
        .api()
        .post(`/api/v1/evaluations/${s.e.id}/corrections`)
        .set(bearer((await lab.person('rev5', ['reviewer'])).token))
        .send({ kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: retraction.id })
        .expect(201);
      expect(await ids()).toContain(s.reportId);
    });

    it("is the reviewer's alone: a clinician, a reader, an administrator and a person with no role are refused (403), another organization sees none, a bad page is 400", async () => {
      const s = await scenario();
      await reject(s.rejecter, s.reportId).expect(201);
      for (const roles of [['clinician'], ['reader'], ['admin'], []]) {
        const res = await queue(await lab.person('x', roles));
        expect([roles, res.status]).toEqual([roles, 403]);
      }
      expect((await queue(await lab.person('both', ['admin', 'reviewer']))).status).toBe(200); // control: administration plus the reviewer role
      const foreign = await lab.person('rv', ['reviewer'], `org-${randomUUID().slice(0, 6)}`);
      expect((await queue(foreign).expect(200)).body).toMatchObject({ data: [], meta: { total: 0 } });
      for (const query of ['?page=0', '?pageSize=0', '?pageSize=101', '?extra=1']) expect([query, (await queue(s.rejecter, query)).status]).toEqual([query, 400]);
      await lab.api().get('/api/v1/patient-link/quarantine').expect(401);
    });

    it('is 503 with the pipeline switched off, and 403 still for a role that may not use it', async () => {
      const off = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
      try {
        const sw = new LabPipeline(off, db.adminUrl);
        expect(
          (
            await sw
              .api()
              .get('/api/v1/patient-link/quarantine')
              .set(bearer((await sw.person('rv', ['reviewer'])).token))
          ).status,
        ).toBe(503);
        expect(
          (
            await sw
              .api()
              .get('/api/v1/patient-link/quarantine')
              .set(bearer((await sw.person('cl', ['clinician'])).token))
          ).status,
        ).toBe(403);
      } finally {
        await off.close();
      }
    });
  });

  describe('what it does not do', () => {
    it('does not stop a reviewer reading the file, the capture or the evaluation of a quarantined report, and still refuses a new evaluation', async () => {
      const s = await scenario();
      await reject(s.rejecter, s.reportId).expect(201);
      await lab.api().get(`/api/v1/captures/${s.captureId}`).set(bearer(s.rejecter.token)).expect(200);
      await lab.api().get(`/api/v1/reports/${s.reportId}/download-url`).set(bearer(s.rejecter.token)).expect(200);
      await read(s.rejecter, s.e.id).expect(200);
      const again = await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId });
      expect([again.status, again.body.error.details[0].reason]).toEqual([409, 'patient-link-unverified']);
    });
  });
});
