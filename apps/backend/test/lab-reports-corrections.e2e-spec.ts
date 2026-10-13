import { randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { correctionDtoSchema, evaluationDtoSchema, evaluationSummaryDtoSchema, noteDtoSchema } from '@telesphoros/shared-types';
import { LedgerVerifier } from '../src/ledger/verifier';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, type Person, sha } from './helpers/lab-pipeline';
import { attempt } from './helpers/ledger-sql';
import { bearer } from './helpers/tokens';

// Corrections of stored evaluations over HTTP (slice 5B-3.3a): retraction, reinstatement and supersession by reviewers; the history and the
// derived state; "current"; notes. Every refusal is asserted to have stored NOTHING and each has a control that succeeds. Synthetic data only.
(usingPostgres() ? describe : describe.skip)('corrections of stored evaluations', () => {
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

  type Evaluation = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const correct = (who: Person, evaluationId: string, body: object) => lab.api().post(`/api/v1/evaluations/${evaluationId}/corrections`).set(bearer(who.token)).send(body);
  const read = (who: Person, evaluationId: string) => lab.api().get(`/api/v1/evaluations/${evaluationId}`).set(bearer(who.token));
  const corrections = (tenant = lab.tenant) => lab.count('corrections', 'tenant_id = $1', [tenant]);
  const events = (tenant = lab.tenant) => lab.count('ledger_events', 'tenant_id = $1', [tenant]);
  /** Everything about an evaluation that a correction must never change. */
  const frozen = (e: Evaluation) => {
    const { state, supersededBy, corrections: _history, current, acceptance, advisory, ...rest } = e; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  };

  /** One report with one evaluation (D01 evaluates), made by a clinician and an independent reviewer. */
  async function scenario() {
    const s = await lab.reviewedCapture(fixturePdf('D01'));
    const e1: Evaluation = (await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
    return { ...s, e1 };
  }
  /** A second evaluation of the same report (a second, later acceptance by another reviewer gives it a different identity). */
  async function withSecond(s: Awaited<ReturnType<typeof scenario>>) {
    const reviewer2 = await lab.person('rev2', ['reviewer']);
    const a2 = (await lab.decide(reviewer2, s.captureId, { decision: 'accepted' }).expect(201)).body.id as string;
    const e2: Evaluation = (await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: a2 }).expect(201)).body;
    return { ...s, reviewer2, e2 };
  }

  describe('retraction and reinstatement', () => {
    it('a reviewer retracts; the evaluation is unchanged, its state and history say so, and the ledger chain still verifies', async () => {
      const s = await scenario();
      expect(s.e1).toMatchObject({ state: 'active', current: true, corrections: [] });
      const before = { corrections: await corrections(), events: await events() };

      const res = await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201);
      expect(correctionDtoSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toMatchObject({ evaluationId: s.e1.id, kind: 'retraction', reasonCode: 'software-defect', previousCorrectionId: null, replacementEvaluationId: null, note: null });
      expect(JSON.stringify(res.body)).not.toMatch(/createdBy|created_by|tenant/i);

      const after: Evaluation = (await read(s.clinician, s.e1.id).expect(200)).body;
      expect(evaluationDtoSchema.safeParse(after).success).toBe(true);
      expect(after).toMatchObject({ state: 'retracted', supersededBy: null, current: false, actionable: false });
      expect(after.corrections).toEqual([res.body]);
      expect(frozen(after)).toEqual(frozen(s.e1)); // the stored result is exactly as it was shown
      expect(await corrections()).toBe(before.corrections + 1);
      expect(await events()).toBe(before.events + 1); // one record, one ledger event
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
    });

    it('a reinstatement needs a different person than the retractor, names the retraction, and makes the evaluation active and current again', async () => {
      const s = await scenario();
      const retraction = (await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'wrong-patient' }).expect(201)).body;
      const reinstate = { kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: retraction.id };

      const count = await corrections();
      const self = await correct(s.reviewer, s.e1.id, reinstate).expect(409);
      expect(self.body.error.details[0].reason).toBe('self-reinstatement');
      expect(await corrections()).toBe(count); // refused, nothing stored

      const other = await lab.person('rev-other', ['reviewer']);
      const done = await correct(other, s.e1.id, reinstate).expect(201); // control: the same request by someone else succeeds
      expect(done.body).toMatchObject({ kind: 'reinstatement', previousCorrectionId: retraction.id });
      const after: Evaluation = (await read(s.clinician, s.e1.id).expect(200)).body;
      expect(after).toMatchObject({ state: 'active', current: true });
      expect(after.corrections.map((c: { kind: string }) => c.kind)).toEqual(['retraction', 'reinstatement']);
      expect(frozen(after)).toEqual(frozen(s.e1));

      // The chain goes on: the reinstated evaluation can be retracted again, naming the reinstatement as the last thing seen.
      const again = await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'software-defect', previousCorrectionId: done.body.id }).expect(201);
      expect(again.body.previousCorrectionId).toBe(done.body.id);
      expect((await read(s.clinician, s.e1.id)).body.state).toBe('retracted');
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok' });
    });

    it('only a retracted evaluation can be reinstated, and a retracted one can only be reinstated (invalid-transition, nothing stored)', async () => {
      const s = await scenario();
      const count = await corrections();
      // Naming a correction that does not exist is stale, whatever the kind.
      const noPrevious = await correct(s.reviewer, s.e1.id, { kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: randomUUID() }).expect(409);
      expect(noPrevious.body.error.details[0].reason).toBe('stale-chain');

      const retraction = (await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'input-misread' }).expect(201)).body;
      const twice = await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'input-misread', previousCorrectionId: retraction.id }).expect(409);
      expect(twice.body.error.details[0].reason).toBe('invalid-transition');
      const other = await lab.person('rev-other', ['reviewer']);
      const reinstated = (await correct(other, s.e1.id, { kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: retraction.id }).expect(201)).body;
      const again = await correct(other, s.e1.id, { kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: reinstated.id }).expect(409);
      expect(again.body.error.details[0].reason).toBe('invalid-transition');
      expect(await corrections()).toBe(count + 2); // only the retraction and the one valid reinstatement were stored
    });
  });

  describe('the chain is explicit: the reviewer names the last correction they saw', () => {
    it('a missing or wrong previousCorrectionId is 409 stale-chain; the right one succeeds', async () => {
      const s = await scenario();
      const first = (await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'capture-wrong' }).expect(201)).body;
      const other = await lab.person('rev-other', ['reviewer']);
      const count = await corrections();
      for (const previousCorrectionId of [undefined, randomUUID()]) {
        const res = await correct(other, s.e1.id, { kind: 'reinstatement', reasonCode: 'retraction-mistaken', ...(previousCorrectionId ? { previousCorrectionId } : {}) });
        // omitting it for a reinstatement is a validation error (it must name the retraction); a wrong one is stale
        expect(res.status).toBe(previousCorrectionId ? 409 : 400);
        if (previousCorrectionId) expect(res.body.error.details[0].reason).toBe('stale-chain');
      }
      const missing = await correct(other, s.e1.id, { kind: 'retraction', reasonCode: 'capture-wrong' }).expect(409); // the evaluation already has a correction
      expect(missing.body.error.details[0].reason).toBe('stale-chain');
      expect(await corrections()).toBe(count);
      await correct(other, s.e1.id, { kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: first.id }).expect(201); // control
    });

    it('a first correction that names a previous one is stale too (there is none)', async () => {
      const s = await scenario();
      const res = await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'capture-wrong', previousCorrectionId: randomUUID() }).expect(409);
      expect(res.body.error.details[0].reason).toBe('stale-chain');
      expect(await lab.count('corrections', 'evaluation_id = $1', [s.e1.id])).toBe(0);
    });

    it('two reviewers acting at the same moment: exactly one succeeds, the other is told to reload, and one correction is stored', async () => {
      const s = await scenario();
      const other = await lab.person('rev-other', ['reviewer']);
      const results = await Promise.all([
        correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'software-defect' }),
        correct(other, s.e1.id, { kind: 'retraction', reasonCode: 'wrong-patient' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(['LEDGER_CONFLICT', 'CONFLICT']).toContain(loser.body.error.code);
      expect(await lab.count('corrections', 'evaluation_id = $1', [s.e1.id])).toBe(1);
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok' });
    });
  });

  describe('supersession', () => {
    it('replaces an evaluation by a newer active one of the same report; it is terminal and "current" moves to the replacement', async () => {
      const s = await withSecond(await scenario());
      expect(s.e2.current).toBe(true);
      expect((await read(s.clinician, s.e1.id)).body.current).toBe(false); // the newer active evaluation is the current one

      const res = await correct(s.reviewer, s.e1.id, { kind: 'supersession', reasonCode: 'knowledge-error-found', replacementEvaluationId: s.e2.id }).expect(201);
      expect(res.body).toMatchObject({ kind: 'supersession', replacementEvaluationId: s.e2.id });
      const after: Evaluation = (await read(s.clinician, s.e1.id)).body;
      expect(after).toMatchObject({ state: 'superseded', supersededBy: s.e2.id, current: false });
      expect((await read(s.clinician, s.e2.id)).body).toMatchObject({ state: 'active', current: true });

      // Terminal: nothing more can be said about the superseded evaluation.
      for (const body of [
        { kind: 'retraction', reasonCode: 'software-defect', previousCorrectionId: res.body.id },
        { kind: 'supersession', reasonCode: 'software-defect', previousCorrectionId: res.body.id, replacementEvaluationId: s.e2.id },
      ]) {
        const refused = await correct(s.reviewer, s.e1.id, body).expect(409);
        expect(refused.body.error.details[0].reason).toBe('invalid-transition');
      }
      expect(await lab.count('corrections', 'evaluation_id = $1', [s.e1.id])).toBe(1);
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok' });
    });

    it('refuses a replacement that is older, itself, from another report, or already retracted; each stores nothing', async () => {
      const s = await withSecond(await scenario());
      const foreign = await scenario(); // an evaluation of a DIFFERENT report in the same tenant
      const count = await corrections();
      const supersede = (id: string, replacementEvaluationId: string) => correct(s.reviewer, id, { kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId });

      for (const [label, evaluation, replacement] of [
        ['older', s.e2.id, s.e1.id],
        ['itself', s.e1.id, s.e1.id],
        ['another report', s.e1.id, foreign.e1.id],
      ] as const) {
        const res = await supersede(evaluation, replacement).expect(409);
        expect([label, res.body.error.details[0].reason]).toEqual([label, 'bad-replacement']);
      }
      // A retracted replacement.
      await correct(s.reviewer, s.e2.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201);
      expect((await supersede(s.e1.id, s.e2.id).expect(409)).body.error.details[0].reason).toBe('bad-replacement');
      expect(await corrections()).toBe(count + 1); // only the retraction of e2 was stored

      // Unknown or another tenant's evaluation is 404.
      await supersede(s.e1.id, randomUUID()).expect(404);
      // Control: with e2 reinstated the same request now succeeds.
      const retraction = (await read(s.clinician, s.e2.id)).body.corrections[0];
      const other = await lab.person('rev-other', ['reviewer']);
      await correct(other, s.e2.id, { kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: retraction.id }).expect(201);
      await supersede(s.e1.id, s.e2.id).expect(201);
    });

    it('a held replacement is allowed: "replaced by no result" is a legitimate outcome, and it becomes the current evaluation', async () => {
      // D12 is held. A second, later acceptance gives a second held evaluation of the same report, which replaces the first.
      const d12 = await lab.reviewedCapture(fixturePdf('D12'));
      const held: Evaluation = (await lab.evaluate(d12.clinician, d12.reportId, { captureId: d12.captureId, acceptanceId: d12.acceptanceId }).expect(201)).body;
      expect(held.disposition).toBe('held');
      const reviewer2 = await lab.person('rev2', ['reviewer']);
      const a2 = (await lab.decide(reviewer2, d12.captureId, { decision: 'accepted' }).expect(201)).body.id as string;
      const heldAgain: Evaluation = (await lab.evaluate(d12.clinician, d12.reportId, { captureId: d12.captureId, acceptanceId: a2 }).expect(201)).body;
      await correct(d12.reviewer, held.id, { kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId: heldAgain.id }).expect(201);
      expect((await read(d12.clinician, heldAgain.id)).body).toMatchObject({ disposition: 'held', state: 'active', current: true });
    });
  });

  describe('validation', () => {
    it.each([
      ['a reason not allowed for the kind', { kind: 'retraction', reasonCode: 'retraction-mistaken' }],
      ['a supersession reason on a reinstatement', { kind: 'reinstatement', reasonCode: 'software-defect', previousCorrectionId: randomUUID() }],
      ['a supersession without a replacement', { kind: 'supersession', reasonCode: 'software-defect' }],
      ['a replacement on a retraction', { kind: 'retraction', reasonCode: 'software-defect', replacementEvaluationId: randomUUID() }],
      ['clinical-review-disagrees without a note', { kind: 'retraction', reasonCode: 'clinical-review-disagrees' }],
      ['a reinstatement that names no retraction', { kind: 'reinstatement', reasonCode: 'retraction-mistaken' }],
      ['a note over 1000 characters', { kind: 'retraction', reasonCode: 'software-defect', note: 'x'.repeat(1001) }],
      ['an unknown field (the reviewer is never taken from the body)', { kind: 'retraction', reasonCode: 'software-defect', createdBy: 'someone-else' }],
      ['a non-uuid previous id', { kind: 'retraction', reasonCode: 'software-defect', previousCorrectionId: 'nope' }],
    ])('%s is 400 and stores nothing', async (_name, body) => {
      const s = await scenario();
      const count = await corrections();
      const res = await correct(s.reviewer, s.e1.id, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await corrections()).toBe(count);
    });

    it('control: clinical-review-disagrees with a note is accepted', async () => {
      const s = await scenario();
      await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'clinical-review-disagrees', note: 'SYN: the reviewer disagrees' }).expect(201);
    });
  });

  describe('who may correct, and whose evaluation', () => {
    it('only a reviewer; reader, clinician and an admin alone are 403, no token is 401, and none of them stores anything', async () => {
      const s = await scenario();
      const count = await corrections();
      for (const roles of [['reader'], ['clinician'], ['admin']]) {
        const who = await lab.person('x', roles);
        await correct(who, s.e1.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(403);
      }
      await lab.api().post(`/api/v1/evaluations/${s.e1.id}/corrections`).send({ kind: 'retraction', reasonCode: 'software-defect' }).expect(401);
      expect(await corrections()).toBe(count);
      const both = await lab.person('admin-reviewer', ['admin', 'reviewer']); // control: holding the reviewer role (alongside others) is enough
      await correct(both, s.e1.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201);
    });

    it("another tenant's evaluation reads as not found, for the correction and for its replacement", async () => {
      const s = await scenario();
      const stranger = await lab.person('stranger', ['reviewer'], 'tenant-elsewhere');
      const count = await corrections();
      await correct(stranger, s.e1.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(404);
      await read(stranger, s.e1.id).expect(404);
      const mine = await withSecond(s);
      await correct(mine.reviewer, mine.e1.id, { kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId: mine.e2.id }).expect(201); // control, own tenant
      const theirs = await lab.person('their-reviewer', ['reviewer'], 'tenant-elsewhere');
      await correct(theirs, mine.e2.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(404);
      expect(await corrections()).toBe(count + 1);
      expect(await corrections('tenant-elsewhere')).toBe(0);
    });

    it('an unknown evaluation is 404', async () => {
      const reviewer = await lab.person('rev', ['reviewer']);
      await correct(reviewer, randomUUID(), { kind: 'retraction', reasonCode: 'software-defect' }).expect(404);
    });
  });

  describe('"current" (specification 4.5, amended in section 22): the newest evaluation of a report, if it is active', () => {
    const list = (who: Person, query = '') => lab.api().get(`/api/v1/evaluations${query}`).set(bearer(who.token));
    const ids = (res: { body: { data: Array<{ id: string }> } }) => res.body.data.map((e) => e.id).sort();

    it('follows the corrections: the newest if active; NONE if the newest is retracted (an older active one is not promoted); the newest again once reinstated', async () => {
      const s = await withSecond(await scenario());
      const mine = (query: string) => list(s.clinician, `?reportId=${s.reportId}${query}`);
      expect(ids(await mine('&current=true').expect(200))).toEqual([s.e2.id]);
      expect(ids(await mine('').expect(200))).toEqual([s.e1.id, s.e2.id].sort()); // without the filter, both
      expect((await mine('').expect(200)).body.data.map((e: Evaluation) => [e.id, e.current]).sort()).toEqual([[s.e1.id, false], [s.e2.id, true]].sort());

      // Retract the NEWEST: the report has no current evaluation. The older one is still ACTIVE (it was never corrected) but is not promoted:
      // a reviewer who retracted the newest said "do not rely on this", and nobody has said the older one is what to rely on instead.
      const retraction = (await correct(s.reviewer, s.e2.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201)).body;
      expect((await mine('&current=true').expect(200)).body.data).toEqual([]);
      expect((await read(s.clinician, s.e1.id)).body).toMatchObject({ state: 'active', current: false });
      expect((await read(s.clinician, s.e2.id)).body).toMatchObject({ state: 'retracted', current: false });

      // Retract that too: still none, and both remain readable by id.
      await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201);
      expect((await mine('&current=true').expect(200)).body.data).toEqual([]);
      expect((await read(s.clinician, s.e1.id)).body).toMatchObject({ state: 'retracted', current: false });

      // Reinstating the newest brings it back.
      const other = await lab.person('rev-other', ['reviewer']);
      await correct(other, s.e2.id, { kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: retraction.id }).expect(201);
      expect(ids(await mine('&current=true').expect(200))).toEqual([s.e2.id]);
    });

    it('is per report, composes with the patient filter, and the list shape carries the history without the engine inputs', async () => {
      const a = await scenario();
      const b = await scenario();
      await correct(a.reviewer, a.e1.id, { kind: 'retraction', reasonCode: 'software-defect' }).expect(201);
      const current = await list(a.clinician, '?current=true').expect(200);
      expect(ids(current)).toEqual(expect.arrayContaining([b.e1.id]));
      expect(ids(current)).not.toContain(a.e1.id);
      const byPatient = await list(a.clinician, `?patientId=${a.patientId}&current=true`).expect(200);
      expect(byPatient.body.data).toEqual([]); // a's only evaluation is retracted; b's patient is not asked for
      const all = await list(a.clinician, `?patientId=${a.patientId}`).expect(200);
      expect(all.body.data).toHaveLength(1);
      expect(evaluationSummaryDtoSchema.safeParse(all.body.data[0]).success).toBe(true);
      expect(all.body.data[0]).not.toHaveProperty('geneInputs');
      expect(all.body.data[0]).toMatchObject({ state: 'retracted', current: false, corrections: [expect.objectContaining({ kind: 'retraction' })] });
    });

    it('accepts only current=true', async () => {
      const who = await lab.person('clin', ['clinician']);
      await list(who, '?current=false').expect(400);
      await list(who, '?current=1').expect(400);
      await list(who, '?current=true').expect(200);
    });
  });

  describe('notes: free text stays out of the ledger and the responses, and is read through one route', () => {
    const NOTE = 'SYN: zebra-17 note text that must never appear in a response list or a log';
    const getNote = (who: Person, id: string) => lab.api().get(`/api/v1/notes/${id}`).set(bearer(who.token));

    it('the correction carries only the note digest; GET /notes/:id returns the text to a clinician or reviewer, not to a reader or an administrator', async () => {
      const s = await scenario();
      const res = await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'clinical-review-disagrees', note: NOTE }).expect(201);
      expect(res.body.note).toEqual({ id: expect.any(String), bodySha256: sha(NOTE) });
      expect(JSON.stringify((await read(s.clinician, s.e1.id)).body)).not.toContain('zebra-17');
      expect(JSON.stringify((await list(s.clinician)).body)).not.toContain('zebra-17');

      for (const roles of [['clinician'], ['reviewer'], ['admin', 'clinician']]) {
        const who = await lab.person('x', roles);
        const note = await getNote(who, res.body.note.id).expect(200);
        expect(noteDtoSchema.safeParse(note.body).success).toBe(true);
        expect(note.body).toMatchObject({ id: res.body.note.id, body: NOTE, bodySha256: sha(NOTE), redacted: false });
      }
      await getNote(await lab.person('reader', ['reader']), res.body.note.id).expect(403);
      await getNote(await lab.person('admin', ['admin']), res.body.note.id).expect(403); // administration is not clinical access
      await lab.api().get(`/api/v1/notes/${res.body.note.id}`).expect(401);
      // The ledger holds the digest only: no event row contains the text anywhere.
      const leaked = await lab.row(`SELECT 1 FROM ledger_events WHERE row_to_json(ledger_events)::text LIKE '%zebra-17%'`);
      expect(leaked).toEqual([]);

      // Another tenant, or an id that is not a note, is 404.
      await getNote(await lab.person('stranger', ['clinician'], 'tenant-elsewhere'), res.body.note.id).expect(404);
      await getNote(await lab.person('clin', ['clinician']), randomUUID()).expect(404);
      await getNote(await lab.person('clin', ['clinician']), 'not-a-uuid').expect(400);
    });

    it('a redacted note reads as the tombstone, keeps its digest, and the chain still verifies', async () => {
      const s = await scenario();
      const res = await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'clinical-review-disagrees', note: NOTE }).expect(201);
      const failure = await attempt(db.operatorUrl, lab.tenant, 'operator-1', (c) => c.query(`SELECT redact_event_note($1, $2, 'phi-in-note')`, [res.body.note.id, randomUUID()]));
      expect(failure).toBeUndefined();
      const note = await getNote(await lab.person('clin', ['clinician']), res.body.note.id).expect(200);
      expect(note.body).toMatchObject({ body: '[redacted]', redacted: true, bodySha256: sha(NOTE) });
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok' });
    });

    it('nothing a correction, a refusal or a note read writes to the log contains the note text', async () => {
      const s = await scenario();
      const lines: string[] = [];
      const capture = new (class extends ConsoleLogger {
        override log(...args: unknown[]) { lines.push(JSON.stringify(args)); }
        override warn(...args: unknown[]) { lines.push(JSON.stringify(args)); }
        override error(...args: unknown[]) { lines.push(JSON.stringify(args)); }
      })();
      Logger.overrideLogger(capture);
      try {
        const res = await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'clinical-review-disagrees', note: NOTE }).expect(201);
        await correct(s.reviewer, s.e1.id, { kind: 'retraction', reasonCode: 'clinical-review-disagrees', note: NOTE }).expect(409); // stale: a refusal is logged too
        await getNote(s.clinician, res.body.note.id).expect(200);
      } finally {
        Logger.overrideLogger(['error', 'warn']);
      }
      expect(lines.join('\n')).not.toContain('zebra-17');
    });
  });

  it('the ledger chain of the whole tenant verifies after everything above', async () => {
    const result = await verifier.verify(lab.tenant);
    expect(result).toMatchObject({ status: 'ok', failures: [] });
    expect(result.eventsChecked).toBe(await events());
  });

  const list = (who: Person, query = '') => lab.api().get(`/api/v1/evaluations${query}`).set(bearer(who.token));
});
