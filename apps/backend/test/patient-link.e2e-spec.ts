import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { patientLinkDecisionDtoSchema, patientLinkDtoSchema } from '@telesphoros/shared-types';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { fixturePdf, LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

/**
 * The recorded decision that a report's exact file version belongs to its patient (M2.1b, decision DP-5). The decision is a ledger record, so these
 * run on PostgreSQL with the lab-report pipeline on. Synthetic data only.
 */
(usingPostgres() ? describe : describe.skip)('the report-to-patient link', () => {
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

  const decisions = (reportId?: string) =>
    lab.count('report_patient_decisions', reportId ? 'tenant_id = $1 AND report_id = $2' : 'tenant_id = $1', reportId ? [lab.tenant, reportId] : [lab.tenant]);
  const events = () => lab.count('ledger_events', `tenant_id = $1 AND event_type = 'patient-link-decision'`, [lab.tenant]);
  const secretNumber = () => `ZQX-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const attest = { decision: 'verified', method: 'person-confirmed', basisCode: 'no-identifier-on-report' } as const;
  const registerIdentifier = (who: Person, patientId: string, system: string, value: string) =>
    lab.api().post(`/api/v1/patients/${patientId}/identifiers`).set(bearer(who.token)).send({ system, value });

  /** A clinician uploads a report for a fresh patient; a different person is returned to decide. */
  async function uploaded() {
    const creator = await lab.person('clin', ['clinician']);
    const up = await lab.uploadedLabPdf(creator, fixturePdf('D01'));
    const decider = await lab.person('rev', ['reviewer']);
    return { creator, decider, ...up };
  }

  describe('reading the state', () => {
    it('starts unverified, in the documented shape', async () => {
      const s = await uploaded();
      const res = await lab.patientLink(s.decider, s.reportId).expect(200);
      expect(patientLinkDtoSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toEqual({ reportId: s.reportId, patientId: s.patientId, state: 'unverified', decision: null, staleDecision: false });
    });

    it('is open to the clinical read roles, not to an administrator or a person with no role, and not to another organization (404)', async () => {
      const s = await uploaded();
      for (const roles of [['reader'], ['clinician'], ['reviewer']]) expect((await lab.patientLink(await lab.person('r', roles), s.reportId)).status).toBe(200);
      for (const roles of [['admin'], []]) expect((await lab.patientLink(await lab.person('r', roles), s.reportId)).status).toBe(403);
      expect((await lab.patientLink(await lab.person('x', ['clinician'], 'another-organization'), s.reportId)).status).toBe(404);
      expect((await lab.patientLink(s.decider, randomUUID())).status).toBe(404);
      expect((await lab.patientLink(s.decider, 'not-a-uuid')).status).toBe(400);
    });
  });

  describe('who may decide', () => {
    it('refuses the person who registered, the person who asked for the upload link and the person who completed it (each, alone), and records nothing', async () => {
      const a = await lab.person('creator', ['clinician']);
      const b = await lab.person('requester', ['clinician']);
      const c = await lab.person('completer', ['clinician']);
      const up = await lab.uploadedLabPdf(a, fixturePdf('D01'), { requester: b, completer: c });
      for (const who of [a, b, c]) {
        const res = await lab.verifyLink(who, up.reportId);
        expect([res.status, res.body.error.details[0].reason]).toEqual([409, 'self-review']);
      }
      expect(await decisions(up.reportId)).toBe(0);
      const fourth = await lab.person('fourth', ['clinician']);
      await lab.verifyLink(fourth, up.reportId).expect(201); // control: anyone else
      expect(await decisions(up.reportId)).toBe(1);
    });

    it('is open to a clinician or a reviewer, and refused to a reader, an administrator alone, or a person with no role (403)', async () => {
      const s = await uploaded();
      for (const roles of [['reader'], ['admin'], []]) {
        const res = await lab.verifyLink(await lab.person('x', roles), s.reportId);
        expect([roles, res.status]).toEqual([roles, 403]);
      }
      expect(await decisions(s.reportId)).toBe(0);
      await lab.verifyLink(await lab.person('both', ['admin', 'reviewer']), s.reportId).expect(201); // control: administration plus a deciding role
    });

    it('answers 404 for another organization\'s report and 401 without a token', async () => {
      const s = await uploaded();
      expect((await lab.verifyLink(await lab.person('x', ['clinician'], 'another-organization'), s.reportId)).status).toBe(404);
      await lab.api().post(`/api/v1/reports/${s.reportId}/patient-link/decisions`).send(attest).expect(401);
    });

    it('refuses a report whose file is not uploaded yet (409 not-uploaded)', async () => {
      const creator = await lab.person('clin', ['clinician']);
      const pending = await lab.uploadedLabPdf(creator, fixturePdf('D01'), { complete: false });
      const res = await lab.verifyLink(await lab.person('rev', ['reviewer']), pending.reportId);
      expect([res.status, res.body.error.details[0].reason]).toEqual([409, 'not-uploaded']);
    });
  });

  describe('verifying by an identifier', () => {
    it('verifies when the identifier read off the report matches one registered for the report\'s patient (any letter case or spacing), and shows it as the stronger method', async () => {
      const s = await uploaded();
      const value = secretNumber();
      await registerIdentifier(s.creator, s.patientId, 'hospital-a-mrn', value).expect(201);
      const res = await lab.decideLink(s.decider, s.reportId, { decision: 'verified', method: 'identifier-match', system: 'hospital-a-mrn', value: `  ${value.toLowerCase()} ` }).expect(201);
      expect(patientLinkDecisionDtoSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toMatchObject({ decision: 'verified', method: 'identifier-match', basisCode: null });
      expect(JSON.stringify(res.body)).not.toContain(value);
      const link = (await lab.patientLink(s.decider, s.reportId).expect(200)).body;
      expect(link).toMatchObject({ state: 'verified', staleDecision: false, decision: { id: res.body.id, method: 'identifier-match' } });
    });

    it('does not verify, and records NOTHING, for a wrong value, another system, another patient\'s identifier or a withdrawn one (409 identifier-mismatch)', async () => {
      const s = await uploaded();
      const other = await lab.patient(s.creator);
      const mine = secretNumber();
      const theirs = secretNumber();
      const gone = secretNumber();
      await registerIdentifier(s.creator, s.patientId, 'hospital-a-mrn', mine).expect(201);
      await registerIdentifier(s.creator, other, 'hospital-a-mrn', theirs).expect(201);
      const withdrawn = (await registerIdentifier(s.creator, s.patientId, 'hospital-a-mrn', gone).expect(201)).body;
      await lab.api().delete(`/api/v1/patients/${s.patientId}/identifiers/${withdrawn.id}`).set(bearer(s.creator.token)).expect(204);
      const before = { decisions: await decisions(), events: await events() };
      for (const [system, value] of [
        ['hospital-a-mrn', secretNumber()], // not registered
        ['hospital-b-mrn', mine], // right number, wrong authority
        ['hospital-a-mrn', theirs], // registered, but to another patient
        ['hospital-a-mrn', gone], // withdrawn
        ['hospital-a-mrn', `${mine}0`], // near miss
      ]) {
        const res = await lab.decideLink(s.decider, s.reportId, { decision: 'verified', method: 'identifier-match', system, value });
        expect([system, res.status, res.body.error.details[0].reason]).toEqual([system, 409, 'identifier-mismatch']);
        expect(JSON.stringify(res.body)).not.toContain(value);
      }
      expect({ decisions: await decisions(), events: await events() }).toEqual(before);
      expect((await lab.patientLink(s.decider, s.reportId)).body.state).toBe('unverified');
      await lab.decideLink(s.decider, s.reportId, { decision: 'verified', method: 'identifier-match', system: 'hospital-a-mrn', value: mine }).expect(201); // control
    });

    it('never matches the same number registered in another organization', async () => {
      const s = await uploaded();
      const value = secretNumber();
      const foreign = await lab.person('clin', ['clinician'], 'another-organization');
      const foreignPatient = await lab.patient(foreign);
      await registerIdentifier(foreign, foreignPatient, 'hospital-a-mrn', value).expect(201);
      const res = await lab.decideLink(s.decider, s.reportId, { decision: 'verified', method: 'identifier-match', system: 'hospital-a-mrn', value });
      expect([res.status, res.body.error.details[0].reason]).toEqual([409, 'identifier-mismatch']);
    });
  });

  describe('verifying or rejecting by attestation', () => {
    it('records a coded attestation as the weaker method, and a rejection', async () => {
      const s = await uploaded();
      const verified = await lab.decideLink(s.decider, s.reportId, attest).expect(201);
      expect(verified.body).toMatchObject({ decision: 'verified', method: 'person-confirmed', basisCode: 'no-identifier-on-report' });
      expect((await lab.patientLink(s.decider, s.reportId)).body.state).toBe('verified');
      const rejected = await lab.decideLink(await lab.person('rev2', ['reviewer']), s.reportId, { decision: 'rejected', method: 'person-confirmed', basisCode: 'different-person' }).expect(201);
      expect(rejected.body).toMatchObject({ decision: 'rejected', basisCode: 'different-person' });
      const link = (await lab.patientLink(s.decider, s.reportId)).body;
      expect(link).toMatchObject({ state: 'rejected', decision: { id: rejected.body.id }, staleDecision: false });
      // A second look can verify again: the newest decision counts, and the history keeps all three.
      await lab.decideLink(await lab.person('rev3', ['reviewer']), s.reportId, attest).expect(201);
      expect((await lab.patientLink(s.decider, s.reportId)).body.state).toBe('verified');
      expect(await decisions(s.reportId)).toBe(3);
    });

    it.each([
      [{ decision: 'verified', method: 'person-confirmed', basisCode: 'different-person' }],
      [{ decision: 'rejected', method: 'person-confirmed', basisCode: 'documented-clinic-procedure' }],
      [{ decision: 'verified', method: 'person-confirmed' }],
      [{ decision: 'verified', method: 'person-confirmed', basisCode: 'because-i-said-so' }],
      [{ decision: 'rejected', method: 'identifier-match', system: 'hospital-a-mrn', value: 'X-1' }],
      [{ decision: 'verified', method: 'identifier-match', system: 'hospital-a-mrn' }],
      [{ decision: 'verified', method: 'identifier-match', system: 'hospital-a-mrn', value: 'X-1', basisCode: 'no-identifier-on-report' }],
      [{ decision: 'maybe', method: 'person-confirmed', basisCode: 'cannot-establish' }],
      [{ decision: 'verified', method: 'guess' }],
      [{}],
    ])('refuses %j (400) and records nothing', async (body) => {
      const s = await uploaded();
      expect((await lab.decideLink(s.decider, s.reportId, body)).status).toBe(400);
      expect(await decisions(s.reportId)).toBe(0);
    });

    it('answers a repeated decision about the same file with the same record (200) and writes no second record or event', async () => {
      const s = await uploaded();
      const first = await lab.decideLink(s.decider, s.reportId, attest).expect(201);
      const before = { decisions: await decisions(), events: await events() };
      const again = await lab.decideLink(await lab.person('rev2', ['reviewer']), s.reportId, attest).expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect({ decisions: await decisions(), events: await events() }).toEqual(before);
    });

    it('serializes two people deciding at once: the newest counts, the history is intact and the ledger verifies', async () => {
      const s = await uploaded();
      const [one, two] = await Promise.all([lab.verifyLink(await lab.person('r1', ['reviewer']), s.reportId), lab.verifyLink(await lab.person('r2', ['reviewer']), s.reportId)]);
      expect([one.status, two.status].every((status) => status === 200 || status === 201)).toBe(true);
      expect((await lab.patientLink(s.decider, s.reportId)).body.state).toBe('verified');
      const admin = await lab.person('adm', ['admin']);
      const check = await lab.api().get('/api/v1/ledger/verify?full=true').set(bearer(admin.token)).expect(200);
      expect(check.body).toMatchObject({ status: 'ok', failures: [] });
    });
  });

  describe('the ledger', () => {
    it('describes each decision with its own event, without any identifier value, and the verifier accepts the chain', async () => {
      const s = await uploaded();
      const value = secretNumber();
      await registerIdentifier(s.creator, s.patientId, 'hospital-a-mrn', value).expect(201);
      const before = await events();
      await lab.decideLink(s.decider, s.reportId, { decision: 'verified', method: 'identifier-match', system: 'hospital-a-mrn', value }).expect(201);
      expect(await events()).toBe(before + 1);
      const event = (await lab.row(`SELECT event_type, subject_table, actor_sub FROM ledger_events WHERE tenant_id = $1 AND event_type = 'patient-link-decision' ORDER BY seq DESC LIMIT 1`, [lab.tenant]))[0];
      expect(event).toEqual({ event_type: 'patient-link-decision', subject_table: 'report_patient_decisions', actor_sub: s.decider.sub });
      await withAdmin(db.adminUrl, async (c) => {
        const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename as string);
        for (const table of tables) {
          const { rows } = await c.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text ILIKE $1`, [`%${value}%`]);
          expect([table, rows[0].n]).toEqual([table, 0]);
        }
      });
      const admin = await lab.person('adm', ['admin']);
      expect((await lab.api().get('/api/v1/ledger/verify?full=true').set(bearer(admin.token)).expect(200)).body).toMatchObject({ status: 'ok', failures: [] });
    });
  });

  describe('a replaced file', () => {
    it('makes the link unverified again, keeps the earlier decision visible as out of date, and blocks evaluation until someone decides about the new file', async () => {
      const s = await lab.reviewedCapture(fixturePdf('D01'));
      expect((await lab.patientLink(s.reviewer, s.reportId)).body.state).toBe('verified');
      // The product has no way to replace an uploaded file yet; the owner does it here, which is the state a future replacement leaves.
      await withAdmin(db.adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query('ALTER TABLE reports DISABLE TRIGGER USER'); // the product refuses to change an uploaded file; the owner can, once, on purpose
        await c.query(`UPDATE reports SET object_version = 'replaced-' || object_version WHERE id = $1`, [s.reportId]);
        await c.query('ALTER TABLE reports ENABLE TRIGGER USER');
        await c.query('COMMIT');
      });
      const link = (await lab.patientLink(s.reviewer, s.reportId)).body;
      expect(link).toMatchObject({ state: 'unverified', staleDecision: true });
      expect(link.decision).toMatchObject({ decision: 'verified' });
      const res = await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId });
      expect([res.status, res.body.error.details[0].reason]).toEqual([409, 'patient-link-unverified']);
      await lab.decideLink(await lab.person('rev2', ['reviewer']), s.reportId, attest).expect(201); // a decision about the NEW file
      expect((await lab.patientLink(s.reviewer, s.reportId)).body).toMatchObject({ state: 'verified', staleDecision: false });
    });
  });

  describe('the gate on evaluation', () => {
    it('refuses an evaluation until a second person has verified the report, then allows it, and refuses again after a rejection', async () => {
      const s = await lab.reviewedCapture(fixturePdf('D01'), { verified: false });
      const body = { captureId: s.captureId, acceptanceId: s.acceptanceId };
      const before = await lab.count('evaluations', 'tenant_id = $1', [lab.tenant]);
      for (const who of [s.clinician, s.reviewer]) {
        const res = await lab.evaluate(who, s.reportId, body);
        expect([res.status, res.body.error.details[0].reason]).toEqual([409, 'patient-link-unverified']);
      }
      expect(await lab.count('evaluations', 'tenant_id = $1', [lab.tenant])).toBe(before);
      await lab.verifyLink(s.reviewer, s.reportId).expect(201);
      const created = await lab.evaluate(s.clinician, s.reportId, body).expect(201);
      expect(await lab.count('evaluations', 'tenant_id = $1', [lab.tenant])).toBe(before + 1);
      await lab.decideLink(await lab.person('rev2', ['reviewer']), s.reportId, { decision: 'rejected', method: 'person-confirmed', basisCode: 'identifier-conflict' }).expect(201);
      const refused = await lab.evaluate(s.clinician, s.reportId, body);
      expect([refused.status, refused.body.error.details[0].reason]).toEqual([409, 'patient-link-unverified']); // a POST never replays from a rejected link
      await lab.decideLink(await lab.person('rev3', ['reviewer']), s.reportId, attest).expect(201);
      const replay = await lab.evaluate(s.clinician, s.reportId, body).expect(200); // control: verified again, the same evaluation comes back
      expect(replay.body.id).toBe(created.body.id);
    });

    it('is checked after the cheaper refusals and before the reader: an unaccepted capture still answers capture-not-accepted', async () => {
      const clin = await lab.person('clin', ['clinician']);
      const rev = await lab.person('rev', ['reviewer']);
      const up = await lab.uploadedLabPdf(clin, fixturePdf('D01'));
      const capture = (await lab.capture(clin, up.reportId).expect(201)).body;
      const rejected = (await lab.decide(rev, capture.id, { decision: 'rejected' }).expect(201)).body;
      const res = await lab.evaluate(clin, up.reportId, { captureId: capture.id, acceptanceId: rejected.id });
      expect([res.status, res.body.error.details[0].reason]).toEqual([409, 'capture-not-accepted']);
    });
  });

  describe('with the pipeline switched off', () => {
    it('answers 503 on both link routes for a person who may use them, and still 403 for one who may not', async () => {
      const off = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
      try {
        const sw = new LabPipeline(off, db.adminUrl);
        const clin = await sw.person('clin', ['clinician']);
        const id = randomUUID();
        expect((await sw.patientLink(clin, id)).status).toBe(503);
        expect((await sw.verifyLink(await sw.person('rev', ['reviewer']), id)).status).toBe(503);
        expect((await sw.patientLink(await sw.person('adm', ['admin']), id)).status).toBe(403);
        expect((await sw.verifyLink(await sw.person('rd', ['reader']), id)).status).toBe(403);
      } finally {
        await off.close();
      }
    });
  });
});
