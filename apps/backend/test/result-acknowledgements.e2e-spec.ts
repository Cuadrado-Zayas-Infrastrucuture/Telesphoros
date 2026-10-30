import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { resultAcknowledgementDtoSchema, resultAcknowledgementsDtoSchema } from '@telesphoros/shared-types';
import { LedgerVerifier } from '../src/ledger/verifier';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// Spec 019, slice D02a: result acknowledgements over HTTP, and the plan's verification scenarios that the backend answers (the patient-change one
// is the frontend's: ReviewedControl.test.tsx). Every expected value is written by hand; the oracle for what was stored is the database, read through
// the administrator connection, never the code under test. Synthetic fixture D01 with the stand-in reader.
(usingPostgres() ? describe : describe.skip)('result acknowledgements', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let verifier: LedgerVerifier;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    verifier = LedgerVerifier.connect(db.verifierUrl);
  }, 60_000);
  // Acknowledgements, corrections and evaluations are tenant state: every test gets its own tenant.
  beforeEach(() => {
    lab = new LabPipeline(app, db.adminUrl);
  });
  afterAll(async () => {
    await verifier.close();
    await app.close();
    await db.drop();
  });

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const post = (who: Person, resultId: string, body: object) => lab.api().post(`/api/v1/evaluation-results/${resultId}/acknowledgements`).set(bearer(who.token)).send(body);
  const list = (who: Person, resultId: string) => lab.api().get(`/api/v1/evaluation-results/${resultId}/acknowledgements`).set(bearer(who.token));
  const stored = (resultId: string) => lab.count('result_acknowledgements', 'result_id = $1', [resultId]);
  const events = () => lab.count('ledger_events', "tenant_id = $1 AND event_type = 'result-acknowledgement'", [lab.tenant]);
  const correct = (who: Person, evaluationId: string, body: object) => lab.api().post(`/api/v1/evaluations/${evaluationId}/corrections`).set(bearer(who.token)).send(body);
  const reason = (res: { body: Json }) => res.body.error?.details?.[0]?.reason;

  /** One report, one evaluation of D01; `result` is the first shown result. */
  async function evaluated() {
    const s = await lab.reviewedCapture(fixturePdf('D01'));
    const e: Json = (await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
    const result: Json = e.results.find((r: Json) => r.outcome === 'shown');
    expect(result).toBeDefined(); // control: D01 shows a result to review
    const clinician = await lab.person('dr', ['clinician']);
    return { ...s, e, result, clinician };
  }
  type Setup = Awaited<ReturnType<typeof evaluated>>;
  /** A valid review of the setup's result, as a client that displayed it `active` would send it. */
  const review = (s: Setup, extra: object = {}) => ({
    requestId: randomUUID(),
    resultId: s.result.id,
    patientId: s.patientId,
    kind: 'review',
    reviewTask: 'result-review',
    displayedBasis: ['active'],
    ...extra,
  });

  describe('binding and tenancy', () => {
    it('stores a correctly bound review (the control), attributed to its clinician, with one ledger event', async () => {
      const s = await evaluated();
      const res = await post(s.clinician, s.result.id, review(s)).expect(201);
      expect(resultAcknowledgementDtoSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toMatchObject({
        resultId: s.result.id,
        evaluationId: s.e.id,
        patientId: s.patientId,
        createdBy: s.clinician.sub,
        kind: 'review',
        reviewTask: 'result-review',
        basis: ['active'],
        basisRule: 'cdr-basis-v1',
      });
      expect(await stored(s.result.id)).toBe(1);
      expect(await events()).toBe(1);
      const [row] = await lab.row<{ created_by: string }>('SELECT created_by FROM result_acknowledgements WHERE id = $1', [res.body.id]);
      expect(row!.created_by).toBe(s.clinician.sub);
    });

    it('refuses a wrong patient, or a body naming another result, with 409 acknowledgement-binding-mismatch, and stores nothing', async () => {
      const s = await evaluated();
      expect(reason(await post(s.clinician, s.result.id, review(s, { patientId: randomUUID() })).expect(409))).toBe('acknowledgement-binding-mismatch');
      expect(reason(await post(s.clinician, s.result.id, review(s, { resultId: randomUUID() })).expect(409))).toBe('acknowledgement-binding-mismatch');
      expect(await stored(s.result.id)).toBe(0);
      expect(await events()).toBe(0);
    });
  });

  describe('roles (A6)', () => {
    it('reader, reviewer and admin are 403 on POST; clinician+reviewer stores, with authorRoles from the membership row', async () => {
      const s = await evaluated();
      for (const roles of [['reader'], ['reviewer'], ['admin']]) await post(await lab.person('x', roles), s.result.id, review(s)).expect(403);
      expect(await stored(s.result.id)).toBe(0);
      // The route's role check runs before anything is looked up: a reader is refused even for a result that does not exist (a clinician gets 404).
      const missing = randomUUID();
      await post(await lab.person('x', ['reader']), missing, review(s, { resultId: missing })).expect(403);
      await post(s.clinician, missing, review(s, { resultId: missing })).expect(404);
      const both = await lab.person('cr', ['clinician', 'reviewer']);
      const res = (await post(both, s.result.id, review(s)).expect(201)).body;
      const [row] = await lab.row<{ roles: string[] }>('SELECT roles FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2', [lab.tenant, both.sub]);
      expect([...res.authorRoles].sort()).toEqual([...row!.roles].sort());
    });

    it('every clinical reader may read the acknowledgements; admin may not', async () => {
      const s = await evaluated();
      await post(s.clinician, s.result.id, review(s)).expect(201);
      for (const roles of [['reader'], ['clinician'], ['reviewer']]) {
        const body = (await list(await lab.person('r', roles), s.result.id).expect(200)).body;
        expect(resultAcknowledgementsDtoSchema.safeParse(body).success).toBe(true);
        expect(body.acknowledgements.map((a: Json) => [a.createdBy, a.byYou])).toEqual([[s.clinician.sub, false]]);
      }
      expect((await list(s.clinician, s.result.id).expect(200)).body.acknowledgements.map((a: Json) => a.byYou)).toEqual([true]); // the author's own
      await list(await lab.person('a', ['admin']), s.result.id).expect(403);
    });
  });

  describe('retries, the request id and A5', () => {
    it('scenario 4, duplicate delivery: two identical requests at once store one row and one event, and both answers carry its id (201 and 200)', async () => {
      const s = await evaluated();
      const body = review(s);
      const [a, b] = await Promise.all([post(s.clinician, s.result.id, body), post(s.clinician, s.result.id, body)]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await stored(s.result.id)).toBe(1);
      expect(await events()).toBe(1);
    });

    it('scenario 4, network loss: a retry of a request whose answer was lost returns the original (200); the same id with other fields is 409 request-id-reused', async () => {
      const s = await evaluated();
      const body = review(s);
      const first = await post(s.clinician, s.result.id, body).expect(201); // the client never saw this answer
      expect((await post(s.clinician, s.result.id, body).expect(200)).body).toEqual(first.body);
      const reused = await post(s.clinician, s.result.id, { ...body, patientId: randomUUID() }).expect(409);
      expect(reason(reused)).toBe('request-id-reused');
      expect(await stored(s.result.id)).toBe(1);
      expect(await events()).toBe(1);
    });

    it('A5: a new request for an acknowledgement that exists is 409 already-acknowledged, never a second row or a false success', async () => {
      const s = await evaluated();
      await post(s.clinician, s.result.id, review(s)).expect(201);
      expect(reason(await post(s.clinician, s.result.id, review(s)).expect(409))).toBe('already-acknowledged');
      expect(await stored(s.result.id)).toBe(1);
      expect(await events()).toBe(1);
      const other = await lab.person('drb', ['clinician']);
      await post(other, s.result.id, review(s)).expect(201); // control: the key is per clinician
    });

    it('a missing requestId, an unknown task, or a kind the basis does not allow is 400 and stores nothing', async () => {
      const s = await evaluated();
      const { requestId: _omit, ...body } = review(s); // eslint-disable-line @typescript-eslint/no-unused-vars
      await post(s.clinician, s.result.id, body).expect(400);
      await post(s.clinician, s.result.id, review(s, { reviewTask: 'decision-review' })).expect(400);
      await post(s.clinician, s.result.id, review(s, { kind: 'retraction-reviewed' })).expect(400);
      await post(s.clinician, s.result.id, review(s, { displayedBasis: ['retracted'] })).expect(400);
      await post(s.clinician, s.result.id, review(s, { displayedBasis: [] })).expect(400);
      expect(await stored(s.result.id)).toBe(0);
    });
  });

  describe('the basis at commit (A3, A4)', () => {
    it('scenario 2: a retraction lands while the result is open; the stale review is 409 acknowledgement-basis-changed and only "retraction reviewed" is accepted', async () => {
      const s = await evaluated();
      const before = review(s);
      const kept = (await post(s.clinician, s.result.id, before).expect(201)).body; // made while the basis was active
      await correct(s.reviewer, s.e.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201);
      const other = await lab.person('drb', ['clinician']); // has the result open, displayed as active
      expect(reason(await post(other, s.result.id, review(s)).expect(409))).toBe('acknowledgement-basis-changed');
      expect(await stored(s.result.id)).toBe(1);
      expect(await events()).toBe(1);
      // A replay of the review stored before the retraction still finds its original (replay comes before any other check).
      expect((await post(s.clinician, s.result.id, before).expect(200)).body.id).toBe(kept.id);
      // Refreshed: the basis is retracted, so a generic review is refused and "retraction reviewed" is what is offered.
      const now: Json = (await list(other, s.result.id).expect(200)).body;
      expect(now.basis).toEqual(['retracted']);
      await post(other, s.result.id, review(s, { displayedBasis: ['retracted'] })).expect(400);
      const ack = (await post(other, s.result.id, review(s, { kind: 'retraction-reviewed', displayedBasis: ['retracted'] })).expect(201)).body;
      expect(ack).toMatchObject({ kind: 'retraction-reviewed', basis: ['retracted'], createdBy: other.sub });
      // The review made before the retraction is kept, and reads as historical.
      const after: Json = (await list(s.clinician, s.result.id).expect(200)).body;
      expect(after.acknowledgements.map((a: Json) => [a.id, a.kind, a.basisIsCurrent])).toEqual([
        [kept.id, 'review', false],
        [ack.id, 'retraction-reviewed', true],
      ]);
    });

    it('a basis displayed with extra categories is also stale (409), and nothing is stored', async () => {
      const s = await evaluated();
      expect(reason(await post(s.clinician, s.result.id, review(s, { displayedBasis: ['disputed'] })).expect(409))).toBe('acknowledgement-basis-changed');
      expect(await stored(s.result.id)).toBe(0);
      expect(await events()).toBe(0);
    });

    it('scenario 1: two clinicians review different versions of one result; their histories stay distinct and the current-review status is right', async () => {
      const s = await evaluated();
      const b = await lab.person('drb', ['clinician']);
      const a1 = (await post(s.clinician, s.result.id, review(s)).expect(201)).body;
      // A new evaluation of the same report: a new result row, the new version. The old row is no longer current.
      const reviewer2 = await lab.person('rev2', ['reviewer']);
      const acceptance2 = (await lab.decide(reviewer2, s.captureId, { decision: 'accepted' }).expect(201)).body.id as string;
      const e2: Json = (await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: acceptance2 }).expect(201)).body;
      const r2: Json = e2.results.find((r: Json) => r.outcome === 'shown' && r.drug === s.result.drug);
      expect(r2.id).not.toBe(s.result.id); // control: a different version
      const b2 = (await post(b, r2.id, { ...review(s), resultId: r2.id }).expect(201)).body;

      const v1: Json = (await list(s.clinician, s.result.id).expect(200)).body;
      expect(v1.basis).toEqual(['not-current']);
      expect(v1.acknowledgements.map((a: Json) => [a.id, a.createdBy, a.basisIsCurrent])).toEqual([[a1.id, s.clinician.sub, false]]);
      const v2: Json = (await list(b, r2.id).expect(200)).body;
      expect(v2.basis).toEqual(['active']);
      expect(v2.acknowledgements.map((a: Json) => [a.id, a.createdBy, a.basisIsCurrent])).toEqual([[b2.id, b.sub, true]]);
      // A's review of the old version does not count for the new one: A may review it, once.
      await post(s.clinician, r2.id, { ...review(s), resultId: r2.id }).expect(201);
      expect(reason(await post(s.clinician, s.result.id, review(s, { displayedBasis: ['not-current'] })).expect(409))).toBe('already-acknowledged');
    });
  });

  describe('scenario 5: another organization, or a role that does not carry it', () => {
    it('a clinician or reader of another tenant gets 404 on both routes; a same-tenant admin gets 403; nothing is stored', async () => {
      const s = await evaluated();
      await post(s.clinician, s.result.id, review(s)).expect(201);
      for (const roles of [['clinician'], ['reader'], ['clinician', 'reviewer']]) {
        const outsider = await lab.person('x', roles, `${lab.tenant}-other`);
        if (roles.includes('clinician')) await post(outsider, s.result.id, review(s)).expect(404);
        await list(outsider, s.result.id).expect(404);
      }
      const admin = await lab.person('adm', ['admin']);
      await post(admin, s.result.id, review(s)).expect(403);
      await list(admin, s.result.id).expect(403);
      expect(await stored(s.result.id)).toBe(1);
    });
  });

  // The default test app makes each membership match the token on every request. Here the database alone holds memberships (granted by SQL), so a token
  // that still says `clinician` proves that the live row, not the token, decides (A6).
  describe('membership held by the database, not the token', () => {
    let managed: NestExpressApplication;
    beforeAll(async () => {
      managed = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, membershipFromTokens: false });
    }, 60_000);
    afterAll(() => managed.close());

    it('a membership whose clinician role was dropped is refused although the token still claims it; the control stores', async () => {
      const m = new LabPipeline(managed, db.adminUrl);
      const grant = async (name: string, roles: string[]) => {
        const who = await m.person(name, roles);
        await m.row(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'syn-test', 'syn-test') ON CONFLICT (id) DO NOTHING`, [m.tenant]);
        await m.row(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', $3::text[], 'syn-test')`, [m.tenant, who.sub, roles]);
        return who;
      };
      const clinician = await grant('clin', ['clinician']);
      const other = await grant('clin2', ['clinician']);
      const reviewer = await grant('rev', ['reviewer']);
      const s = await m.reviewedCapture(fixturePdf('D01'), { clinician, reviewer });
      const e: Json = (await m.evaluate(clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
      const result: Json = e.results.find((r: Json) => r.outcome === 'shown');
      const body = () => ({ requestId: randomUUID(), resultId: result.id, patientId: s.patientId, kind: 'review', reviewTask: 'result-review', displayedBasis: ['active'] });
      const send = (who: Person) => m.api().post(`/api/v1/evaluation-results/${result.id}/acknowledgements`).set(bearer(who.token)).send(body());
      await send(other).expect(201); // control: a live clinician membership works
      await m.row(`UPDATE tenant_memberships SET roles = '{reader}', changed_by = 'syn-test' WHERE tenant_id = $1 AND sub = $2`, [m.tenant, clinician.sub]);
      const res = await send(clinician);
      expect([401, 403]).toContain(res.status);
      expect(await m.count('result_acknowledgements', 'result_id = $1', [result.id])).toBe(1);
    });
  });

  describe('contract and ledger', () => {
    it('no response field says anything was read, seen, viewed, presented, ordered, dispensed or taken', async () => {
      const s = await evaluated();
      const res = (await post(s.clinician, s.result.id, review(s)).expect(201)).body;
      const h = (await list(s.clinician, s.result.id).expect(200)).body;
      const keys = JSON.stringify([Object.keys(res), Object.keys(h), Object.keys(h.acknowledgements[0])]).toLowerCase();
      for (const word of ['read', 'seen', 'viewed', 'present', 'order', 'dispens', 'administ', 'taken', 'implement']) expect(keys).not.toContain(word);
    });

    it('the tenant ledger verifies with reviews and retraction reviews in it', async () => {
      const s = await evaluated();
      await post(s.clinician, s.result.id, review(s)).expect(201);
      await correct(s.reviewer, s.e.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201);
      await post(s.clinician, s.result.id, review(s, { kind: 'retraction-reviewed', displayedBasis: ['retracted'] })).expect(201);
      expect(await events()).toBe(2);
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
    });
  });
});
