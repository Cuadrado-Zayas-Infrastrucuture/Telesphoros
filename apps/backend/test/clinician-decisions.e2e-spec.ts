import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CDR_CHANGE_CODES,
  CDR_CODE_LABELS,
  CDR_NOTE_REQUIRED_CODES,
  CDR_REASON_CODES,
  clinicianDecisionDtoSchema,
  clinicianDecisionHistoryDtoSchema,
} from '@telesphoros/shared-types';
import { LedgerVerifier } from '../src/ledger/verifier';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// Spec 006, slice D01b: clinician result decisions over HTTP. Every expected value is written by hand; the oracle for what was stored is the
// database, read through the administrator connection, never the code under test. Synthetic fixture D01 with the stand-in reader.
// The detail codes are vocabulary cdr-v1 as decided (D6, 2026-10-28, 13 codes); only the "rules" block names codes.
(usingPostgres() ? describe : describe.skip)('clinician result decisions', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let verifier: LedgerVerifier;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    verifier = LedgerVerifier.connect(db.verifierUrl);
  }, 60_000);
  // Decisions, corrections and disputes are tenant state: every test gets its own tenant.
  beforeEach(() => {
    lab = new LabPipeline(app, db.adminUrl);
  });
  afterAll(async () => {
    await verifier.close();
    await app.close();
    await db.drop();
  });

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const post = (who: Person, resultId: string, body: object) => lab.api().post(`/api/v1/evaluation-results/${resultId}/clinician-decisions`).set(bearer(who.token)).send(body);
  const history = (who: Person, resultId: string) => lab.api().get(`/api/v1/evaluation-results/${resultId}/clinician-decisions`).set(bearer(who.token));
  const stored = (resultId: string) => lab.count('clinician_result_decisions', 'result_id = $1', [resultId]);
  const events = () => lab.count('ledger_events', "tenant_id = $1 AND event_type = 'clinician-result-decision'", [lab.tenant]);
  const correct = (who: Person, evaluationId: string, body: object) => lab.api().post(`/api/v1/evaluations/${evaluationId}/corrections`).set(bearer(who.token)).send(body);
  const reason = (res: { body: Json }) => res.body.error?.details?.[0]?.reason;

  /** One report, one evaluation of D01; `result` is the first shown result, with the ids a decision names. */
  async function evaluated() {
    const s = await lab.reviewedCapture(fixturePdf('D01'));
    const e: Json = (await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
    const result: Json = e.results.find((r: Json) => r.outcome === 'shown');
    expect(result).toBeDefined(); // control: D01 shows a result to decide about
    const clinician = await lab.person('dr', ['clinician']);
    return { ...s, e, result, clinician };
  }
  type Setup = Awaited<ReturnType<typeof evaluated>>;
  /** A valid first decision on the setup's result. */
  const accept = (s: Setup, extra: object = {}) => ({
    requestId: randomUUID(),
    evaluationId: s.e.id,
    patientId: s.patientId,
    entryKind: 'decision',
    previousEntryId: null,
    response: 'accepted',
    ...extra,
  });

  describe('binding and tenancy (T01)', () => {
    it('stores a correctly bound decision (the control), with one ledger event', async () => {
      const s = await evaluated();
      const res = await post(s.clinician, s.result.id, accept(s)).expect(201);
      expect(clinicianDecisionDtoSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toMatchObject({ resultId: s.result.id, evaluationId: s.e.id, patientId: s.patientId, createdBy: s.clinician.sub, response: 'accepted' });
      expect(await stored(s.result.id)).toBe(1);
      expect(await events()).toBe(1);
    });

    it('refuses a wrong evaluation or patient with 409 decision-binding-mismatch, another tenant with 404, and stores nothing', async () => {
      const s = await evaluated();
      expect(reason(await post(s.clinician, s.result.id, accept(s, { patientId: randomUUID() })).expect(409))).toBe('decision-binding-mismatch');
      expect(reason(await post(s.clinician, s.result.id, accept(s, { evaluationId: randomUUID() })).expect(409))).toBe('decision-binding-mismatch');
      const outsider = await lab.person('x', ['clinician'], `${lab.tenant}-other`);
      await post(outsider, s.result.id, accept(s)).expect(404);
      await history(outsider, s.result.id).expect(404);
      expect(await stored(s.result.id)).toBe(0);
      expect(await events()).toBe(0);
    });
  });

  describe('retries (T02, T03, T09) and the request id', () => {
    it('two identical requests at once store one row and one event, and both answers carry its id (201 and 200)', async () => {
      const s = await evaluated();
      const body = accept(s);
      const [a, b] = await Promise.all([post(s.clinician, s.result.id, body), post(s.clinician, s.result.id, body)]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await stored(s.result.id)).toBe(1);
      expect(await events()).toBe(1);
    });

    it('a sequential retry returns the original (200); the same id with a different response is 409 request-id-reused', async () => {
      const s = await evaluated();
      const body = accept(s);
      const first = await post(s.clinician, s.result.id, body).expect(201);
      expect((await post(s.clinician, s.result.id, body).expect(200)).body).toEqual(first.body);
      const reused = await post(s.clinician, s.result.id, { ...body, response: 'rejected', detailCodes: ['clinical-context'] }).expect(409);
      expect(reason(reused)).toBe('request-id-reused');
      expect(await stored(s.result.id)).toBe(1);
    });

    it('a missing requestId is 400 and stores nothing', async () => {
      const s = await evaluated();
      const { requestId: _omit, ...body } = accept(s); // eslint-disable-line @typescript-eslint/no-unused-vars
      await post(s.clinician, s.result.id, body).expect(400);
      expect(await stored(s.result.id)).toBe(0);
    });
  });

  describe('the basis at commit (D3)', () => {
    it('T05a: after a retraction the decision is 409 decision-basis-unavailable; T05e: a replay of an entry stored before it still returns 200', async () => {
      const s = await evaluated();
      const before = accept(s);
      const kept = await post(s.clinician, s.result.id, before).expect(201);
      await correct(s.reviewer, s.e.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201);
      expect((await post(s.clinician, s.result.id, before).expect(200)).body.id).toBe(kept.body.id);
      const later = { ...accept(s), previousEntryId: kept.body.id, response: 'rejected', detailCodes: ['clinical-context'] };
      expect(reason(await post(s.clinician, s.result.id, later).expect(409))).toBe('decision-basis-unavailable');
      const h: Json = (await history(s.clinician, s.result.id).expect(200)).body;
      expect(h.basis).toEqual(['retracted']);
      expect(h.entries.map((e: Json) => e.id)).toEqual([kept.body.id]); // the stored decision is unchanged
      expect(await stored(s.result.id)).toBe(1);
    });

    it('T05d: a superseded evaluation and a non-current one are refused; the newer evaluation is accepted (control)', async () => {
      const s = await evaluated();
      const reviewer2 = await lab.person('rev2', ['reviewer']);
      const a2 = (await lab.decide(reviewer2, s.captureId, { decision: 'accepted' }).expect(201)).body.id as string;
      const e2: Json = (await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: a2 }).expect(201)).body;
      expect(reason(await post(s.clinician, s.result.id, accept(s)).expect(409))).toBe('decision-basis-unavailable');
      expect((await history(s.clinician, s.result.id).expect(200)).body.basis).toEqual(['not-current']);
      await correct(s.reviewer, s.e.id, { kind: 'supersession', reasonCode: 'knowledge-error-found', replacementEvaluationId: e2.id }).expect(201);
      expect((await history(s.clinician, s.result.id).expect(200)).body.basis).toEqual(['superseded', 'not-current']);
      const r2: Json = e2.results.find((r: Json) => r.outcome === 'shown');
      await post(s.clinician, r2.id, { ...accept(s), evaluationId: e2.id }).expect(201);
    });

    it('T05c: a rejected patient link quarantines the result, and the decision is refused', async () => {
      const s = await evaluated();
      const other = await lab.person('rev3', ['reviewer']);
      await lab.decideLink(other, s.reportId, { decision: 'rejected', method: 'person-confirmed', basisCode: 'different-person' }).expect(201);
      expect(reason(await post(s.clinician, s.result.id, accept(s)).expect(409))).toBe('decision-basis-unavailable');
      expect((await history(s.clinician, s.result.id).expect(200)).body.basis).toEqual(['quarantined']);
    });

    it('T05c: a dispute raised on the cited cell blocks a decision; once dismissed the result is decidable again', async () => {
      const s = await evaluated();
      const cell = {
        guidelineId: s.result.citation.guidelineId,
        locator: {
          table: s.result.citation.locator.table,
          row: s.result.citation.locator.row,
          ...(s.result.citation.locator.column ? { column: s.result.citation.locator.column } : {}),
        },
      };
      const d: Json = (
        await lab
          .api()
          .post('/api/v1/cell-disputes')
          .set(bearer(s.reviewer.token))
          .send({ ...cell, note: 'SYN: cell looks wrong' })
          .expect(201)
      ).body;
      expect(reason(await post(s.clinician, s.result.id, accept(s)).expect(409))).toBe('decision-basis-unavailable');
      expect((await history(s.clinician, s.result.id).expect(200)).body.basis).toEqual(['disputed']);
      const decider = await lab.person('rev4', ['reviewer']);
      await lab.api().post(`/api/v1/cell-disputes/${d.id}/decision`).set(bearer(decider.token)).send({ decision: 'dismissed', evidenceNote: 'SYN: the cell is right' }).expect(201);
      await post(s.clinician, s.result.id, accept(s)).expect(201);
    });

    it('T06: an evaluation with no decision has an empty history and no current decision', async () => {
      const s = await evaluated();
      const h: Json = (await history(s.clinician, s.result.id).expect(200)).body;
      expect(clinicianDecisionHistoryDtoSchema.safeParse(h).success).toBe(true);
      expect(h).toMatchObject({ basis: ['active'], headEntryId: null, currentDecisionId: null, entries: [], clinicalUse: 'not-approved', actionable: false });
    });
  });

  describe('the history', () => {
    it('chain: two first entries at once store one; the other is 409 decision-stale', async () => {
      const s = await evaluated();
      const [a, b] = await Promise.all([post(s.clinician, s.result.id, accept(s)), post(s.clinician, s.result.id, accept(s))]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(reason(a.status === 409 ? a : b)).toBe('decision-stale');
      expect(await stored(s.result.id)).toBe(1);
    });

    it('disagreement: B decides after A; both entries are kept with their authors, and the current decision is B’s', async () => {
      const s = await evaluated();
      const b = await lab.person('drb', ['clinician']);
      const first = (await post(s.clinician, s.result.id, accept(s)).expect(201)).body;
      const second = (await post(b, s.result.id, { ...accept(s), previousEntryId: first.id, response: 'rejected', detailCodes: ['disagree-with-guideline'] }).expect(201)).body;
      const h: Json = (await history(s.clinician, s.result.id).expect(200)).body;
      expect(h.entries.map((e: Json) => [e.createdBy, e.response])).toEqual([
        [s.clinician.sub, 'accepted'],
        [b.sub, 'rejected'],
      ]);
      expect(h.entries[0]).toEqual(first); // A's entry is unchanged
      expect(h).toMatchObject({ headEntryId: second.id, currentDecisionId: second.id });
    });

    it('plan change vs correction: a later decision is a plan change; entered-in-error leaves no current decision', async () => {
      const s = await evaluated();
      const a1 = (await post(s.clinician, s.result.id, accept(s)).expect(201)).body;
      const a2 = (await post(s.clinician, s.result.id, { ...accept(s), previousEntryId: a1.id, response: 'modified', detailCodes: ['change-dose'] }).expect(201)).body;
      const h1: Json = (await history(s.clinician, s.result.id).expect(200)).body;
      expect(h1.entries.filter((e: Json) => e.entryKind === 'decision')).toHaveLength(2);
      expect(h1.currentDecisionId).toBe(a2.id);

      const t = await evaluated();
      const b1 = (await post(t.clinician, t.result.id, accept(t)).expect(201)).body;
      await post(t.clinician, t.result.id, { ...accept(t), entryKind: 'entered-in-error', previousEntryId: b1.id, response: null }).expect(201);
      const h2: Json = (await history(t.clinician, t.result.id).expect(200)).body;
      expect(h2.currentDecisionId).toBeNull();
      expect(h2.entries).toHaveLength(2); // every entry stays in the history
    });

    it('author-only: B may not amend or withdraw A’s entry (403 not-entry-author); A may (control)', async () => {
      const s = await evaluated();
      const b = await lab.person('drb', ['clinician']);
      const first = (await post(s.clinician, s.result.id, accept(s)).expect(201)).body;
      const amend = { ...accept(s), entryKind: 'amendment', previousEntryId: first.id };
      expect(reason(await post(b, s.result.id, amend).expect(403))).toBe('not-entry-author');
      expect(reason(await post(b, s.result.id, { ...amend, entryKind: 'entered-in-error', response: null }).expect(403))).toBe('not-entry-author');
      expect(await stored(s.result.id)).toBe(1);
      await post(s.clinician, s.result.id, amend).expect(201);
    });

    it('a stale previousEntryId is 409 decision-stale', async () => {
      const s = await evaluated();
      const first = (await post(s.clinician, s.result.id, accept(s)).expect(201)).body;
      await post(s.clinician, s.result.id, { ...accept(s), previousEntryId: first.id, response: 'modified', detailCodes: ['change-drug'] }).expect(201);
      expect(reason(await post(s.clinician, s.result.id, { ...accept(s), previousEntryId: first.id }).expect(409))).toBe('decision-stale');
    });
  });

  describe('time', () => {
    it('backdating: occurredAt yesterday is stored as reported; createdAt is the database clock', async () => {
      const s = await evaluated();
      const evaluatedAt = new Date(s.e.createdAt as string).getTime();
      const occurredAt = new Date(evaluatedAt + 1).toISOString();
      const res = (await post(s.clinician, s.result.id, accept(s, { occurredAt })).expect(201)).body;
      expect(res).toMatchObject({ occurredAtSource: 'reported' });
      expect(new Date(res.occurredAt).getTime()).toBe(evaluatedAt + 1);
      const [row] = await lab.row<{ late: boolean }>("SELECT created_at >= now() - interval '1 minute' AS late FROM clinician_result_decisions WHERE id = $1", [res.id]);
      expect(row!.late).toBe(true);
      const plain = (await post(s.clinician, s.result.id, { ...accept(s), previousEntryId: res.id }).expect(201)).body;
      expect(plain.occurredAtSource).toBe('recorded');
      expect(plain.occurredAt).toBe(plain.createdAt);
    });

    it('occurredAt before the evaluation or in the future is 400', async () => {
      const s = await evaluated();
      await post(s.clinician, s.result.id, accept(s, { occurredAt: '2000-01-01T00:00:00.000Z' })).expect(400);
      await post(s.clinician, s.result.id, accept(s, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() })).expect(400);
      expect(await stored(s.result.id)).toBe(0);
    });
  });

  describe('rules per response (vocabulary cdr-v1)', () => {
    const valid: Json[] = [
      { response: 'accepted' },
      { response: 'modified', detailCodes: ['change-drug', 'clinical-context'] },
      { response: 'rejected', detailCodes: ['not-applicable'] },
      { response: 'deferred', detailCodes: ['information-needed'], reviewBy: '2099-01-01' },
      { response: 'clarification-requested', detailCodes: ['information-needed'] },
      { response: 'rejected', detailCodes: ['other'], note: 'SYN: a reason not in the list' },
      { response: 'rejected', detailCodes: ['drug-interaction'] },
      { response: 'clarification-requested', detailCodes: ['report-doubt'] },
    ];
    const invalid: Json[] = [
      { response: 'modified' },
      { response: 'rejected' },
      { response: 'deferred' },
      { response: 'clarification-requested' },
      { response: 'rejected', detailCodes: ['change-drug'] },
      { response: 'accepted', detailCodes: ['not-applicable'] },
      { response: 'rejected', detailCodes: ['access'], reviewBy: '2099-01-01' },
      { response: 'modified', detailCodes: ['change-other'] },
      { response: 'rejected', detailCodes: ['access', 'access'] },
      { response: 'rejected', detailCodes: ['no-such-code'] },
      { response: null },
    ];

    it('each response stores one valid form (control)', async () => {
      for (const form of valid) {
        const s = await evaluated();
        await post(s.clinician, s.result.id, { ...accept(s), ...form }).expect(201);
      }
    });

    it.each(invalid.map((form) => [JSON.stringify(form), form]))('%s is 400 and stores nothing', async (_label, form) => {
      const s = await evaluated();
      await post(s.clinician, s.result.id, { ...accept(s), ...(form as Json) }).expect(400);
      expect(await stored(s.result.id)).toBe(0);
    });

    it('the database lists exactly the shared vocabulary, in order, and every code has a label', async () => {
      const [row] = await lab.row<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE proname = 'clinician_decision_codes_valid'");
      const arrayNamed = (alias: string) => {
        const found = new RegExp(`ARRAY\\[([^\\]]*)\\]::text\\[\\] AS ${alias}`).exec(row!.src);
        expect(found).not.toBeNull(); // the parser found the array, so an empty match cannot pass
        return [...found![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      };
      expect(arrayNamed('change_codes')).toEqual([...CDR_CHANGE_CODES]);
      expect(arrayNamed('reason_codes')).toEqual([...CDR_REASON_CODES]);
      expect(row!.src).toContain(`ARRAY[${CDR_NOTE_REQUIRED_CODES.map((c) => `'${c}'`).join(', ')}]::text[]`);
      expect(Object.keys(CDR_CODE_LABELS).sort()).toEqual([...CDR_CHANGE_CODES, ...CDR_REASON_CODES].sort());
    });
  });

  describe('roles (D2)', () => {
    it('reader, reviewer-only and admin-only are 403; clinician+reviewer stores, with authorRoles from the membership row', async () => {
      const s = await evaluated();
      for (const roles of [['reader'], ['reviewer'], ['admin']]) await post(await lab.person('x', roles), s.result.id, accept(s)).expect(403);
      expect(await stored(s.result.id)).toBe(0);
      // The route's role check runs before anything is looked up: a reader is refused even for a result that does not exist (a clinician gets 404).
      await post(await lab.person('x', ['reader']), randomUUID(), accept(s)).expect(403);
      await post(s.clinician, randomUUID(), accept(s)).expect(404);
      const both = await lab.person('cr', ['clinician', 'reviewer']);
      const res = (await post(both, s.result.id, accept(s)).expect(201)).body;
      const [row] = await lab.row<{ roles: string[] }>('SELECT roles FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2', [lab.tenant, both.sub]);
      expect([...res.authorRoles].sort()).toEqual([...row!.roles].sort());
    });

    it('every clinical reader may read the history', async () => {
      const s = await evaluated();
      await post(s.clinician, s.result.id, accept(s)).expect(201);
      for (const roles of [['reader'], ['clinician'], ['reviewer']]) await history(await lab.person('r', roles), s.result.id).expect(200);
      await history(await lab.person('a', ['admin']), s.result.id).expect(403);
    });
  });

  // The default test app makes each membership match the token on every request. Here the database alone holds memberships (granted by SQL),
  // so a token that still says `clinician` proves that the live row, not the token, decides (T04).
  describe('membership held by the database, not the token (T04)', () => {
    let managed: NestExpressApplication;
    beforeAll(async () => {
      managed = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, membershipFromTokens: false });
    }, 60_000);
    afterAll(() => managed.close());

    async function setup() {
      const m = new LabPipeline(managed, db.adminUrl);
      const grant = async (name: string, roles: string[]) => {
        const who = await m.person(name, roles);
        await m.row(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'syn-test', 'syn-test') ON CONFLICT (id) DO NOTHING`, [m.tenant]);
        await m.row(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', $3::text[], 'syn-test')`, [m.tenant, who.sub, roles]);
        return who;
      };
      const clinician = await grant('clin', ['clinician']);
      const reviewer = await grant('rev', ['reviewer']);
      const s = await m.reviewedCapture(fixturePdf('D01'), { clinician, reviewer });
      const e: Json = (await m.evaluate(clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
      const result: Json = e.results.find((r: Json) => r.outcome === 'shown');
      const body = (previousEntryId: string | null) => ({
        requestId: randomUUID(),
        evaluationId: e.id,
        patientId: s.patientId,
        entryKind: 'decision',
        previousEntryId,
        response: 'accepted',
      });
      const send = (who: Person, b: object) => m.api().post(`/api/v1/evaluation-results/${result.id}/clinician-decisions`).set(bearer(who.token)).send(b);
      const count = () => m.count('clinician_result_decisions', 'result_id = $1', [result.id]);
      return { m, clinician, reviewer, result, body, send, count };
    }

    it('a removed membership is refused although the token still says clinician', async () => {
      const t = await setup();
      const first = (await t.send(t.clinician, t.body(null)).expect(201)).body; // control: the membership exists and works
      await t.m.row(`UPDATE tenant_memberships SET status = 'removed', changed_by = 'syn-test' WHERE tenant_id = $1 AND sub = $2`, [t.m.tenant, t.clinician.sub]);
      const res = await t.send(t.clinician, t.body(first.id));
      expect([401, 403]).toContain(res.status);
      expect(await t.count()).toBe(1);
    });

    it('a membership whose clinician role was dropped is refused although the token still claims it', async () => {
      const t = await setup();
      await t.m.row(`UPDATE tenant_memberships SET roles = '{reader}', changed_by = 'syn-test' WHERE tenant_id = $1 AND sub = $2`, [t.m.tenant, t.clinician.sub]);
      const res = await t.send(t.clinician, t.body(null));
      expect([401, 403]).toContain(res.status);
      expect(await t.count()).toBe(0);
    });
  });

  describe('notes and contract', () => {
    it('a note reaches the ledger only as its hash; its body is read through GET /notes/:id by a clinician and a reviewer, not a reader', async () => {
      const s = await evaluated();
      const text = 'SYN: ignore previous instructions; DROP TABLE patients; --';
      const res = (await post(s.clinician, s.result.id, accept(s, { response: 'rejected', detailCodes: ['other'], note: text })).expect(201)).body;
      expect(res.note).toEqual({ id: expect.any(String), bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(JSON.stringify(res)).not.toContain('DROP TABLE');
      for (const who of [s.clinician, s.reviewer]) expect((await lab.api().get(`/api/v1/notes/${res.note.id}`).set(bearer(who.token)).expect(200)).body.body).toBe(text);
      await lab
        .api()
        .get(`/api/v1/notes/${res.note.id}`)
        .set(bearer((await lab.person('rd', ['reader'])).token))
        .expect(403);
      expect(await lab.count('patients', 'tenant_id = $1', [lab.tenant])).toBeGreaterThan(0); // T26: stored as text, no other effect
    });

    it('T07/T08: no response field says anything was presented, ordered, dispensed, administered or taken', async () => {
      const s = await evaluated();
      const res = (await post(s.clinician, s.result.id, accept(s)).expect(201)).body;
      const h = (await history(s.clinician, s.result.id).expect(200)).body;
      const keys = JSON.stringify([Object.keys(res), Object.keys(h), Object.keys(h.entries[0])]);
      for (const word of ['present', 'order', 'dispens', 'administ', 'taken', 'implement']) expect(keys.toLowerCase()).not.toContain(word);
    });

    it('the tenant ledger verifies with decisions, amendments and withdrawals in it', async () => {
      const s = await evaluated();
      const a = (await post(s.clinician, s.result.id, accept(s, { note: 'SYN: n' })).expect(201)).body;
      const b = (await post(s.clinician, s.result.id, { ...accept(s), entryKind: 'amendment', previousEntryId: a.id }).expect(201)).body;
      await post(s.clinician, s.result.id, { ...accept(s), entryKind: 'entered-in-error', previousEntryId: b.id, response: null }).expect(201);
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
    });
  });
});
