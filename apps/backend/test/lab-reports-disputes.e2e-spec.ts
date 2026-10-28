import { randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { disputeDtoSchema } from '@telesphoros/shared-types';
import { LedgerVerifier } from '../src/ledger/verifier';
import { LAB_KNOWLEDGE, LAB_READER } from '../src/lab-reports/evaluations.service';
import { effectiveKnowledgeSetId } from '../src/services/knowledge/dispute-overlay';
import { loadKnowledge } from '../src/services/knowledge/knowledge-loader';
import type { KnowledgeSet } from '../src/services/knowledge/knowledge-set';
import type { ReportReader } from '../src/services/report-reader/report-reader';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, type Person, TEST_KNOWLEDGE } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// Disputes about guideline cells (slice 5B-3.3b) and what they do to the NEXT evaluation: a disputed cell is held with no wording, the rest is
// evaluated as usual, and a dispute that appears while an evaluation is being made is never missed. Every refusal is asserted to have stored
// NOTHING and each has a control that succeeds. Synthetic data only; the knowledge is the repository's invented test-only set.
(usingPostgres() ? describe : describe.skip)('disputes about guideline cells', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let verifier: LedgerVerifier;
  let knowledge: KnowledgeSet;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    lab = new LabPipeline(app, db.adminUrl);
    verifier = LedgerVerifier.connect(db.verifierUrl);
    knowledge = await loadKnowledge({ directory: TEST_KNOWLEDGE, mode: 'non-production' });
  }, 60_000);
  // Disputes are state of a TENANT, so every test gets its own: what one test raises must not change what the next one evaluates.
  const tenants: string[] = [];
  beforeEach(() => {
    lab = new LabPipeline(app, db.adminUrl);
    tenants.push(lab.tenant);
  });
  afterAll(async () => {
    await verifier.close();
    await app.close();
    await db.drop();
  });

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const raise = (who: Person, body: object) => lab.api().post('/api/v1/cell-disputes').set(bearer(who.token)).send(body);
  const decide = (who: Person, id: string, body: object) => lab.api().post(`/api/v1/cell-disputes/${id}/decision`).set(bearer(who.token)).send(body);
  const disputes = (tenant = lab.tenant) => lab.count('cell_disputes', 'tenant_id = $1', [tenant]);
  const events = (tenant = lab.tenant) => lab.count('ledger_events', 'tenant_id = $1', [tenant]);
  const evaluationsOf = (reportId: string) => lab.count('evaluations', 'report_id = $1', [reportId]);
  const body = (s: { captureId: string; acceptanceId: string }) => ({ captureId: s.captureId, acceptanceId: s.acceptanceId });
  const resultFor = (evaluation: Json, drug: string): Json => evaluation.results.find((r: Json) => r.drug === drug);
  /** A result without its row id: a new evaluation stores new result rows (spec 006 D01a), so "as before" compares everything else. */
  const contentOf = ({ id: _id, ...rest }: Json): Json => rest; // eslint-disable-line @typescript-eslint/no-unused-vars

  /** What a dispute names for the cell a result cited. */
  const cellOf = (result: Json) => ({
    guidelineId: result.citation.guidelineId as string,
    locator: {
      table: result.citation.locator.table as string,
      row: result.citation.locator.row as string,
      ...(result.citation.locator.column ? { column: result.citation.locator.column as string } : {}),
    },
  });

  /** D01 evaluates: drugq (one-gene guideline) and drugr (two-gene guideline) are both shown. */
  async function evaluatedD01(local = lab) {
    const clin = await local.person('clin', ['clinician']);
    const rev = await local.person('rev', ['reviewer']);
    const s = await local.reviewedCapture(fixturePdf('D01'), { clinician: clin, reviewer: rev });
    const e: Json = (await local.evaluate(clin, s.reportId, body(s)).expect(201)).body;
    expect(resultFor(e, 'drugq')).toMatchObject({ outcome: 'shown' }); // control: shown before any dispute
    expect(resultFor(e, 'drugr')).toMatchObject({ outcome: 'shown' });
    return { ...s, clin, rev, e };
  }

  describe('raising a dispute', () => {
    it('an active dispute beyond the default public page still holds its clinical cell and appears in complete advisories', async () => {
      const s = await evaluatedD01();
      const other = await lab.person('independent', ['reviewer']);
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const d = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugr')), note: 'SYN page filler' }).expect(201)).body;
        ids.push(d.id);
        await decide(other, d.id, { decision: 'dismissed', evidenceNote: 'SYN dismissed filler' }).expect(201);
      }
      const target = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugq')), note: 'SYN off-page active cell' }).expect(201)).body;
      const get = (query = '') =>
        lab
          .api()
          .get('/api/v1/cell-disputes' + query)
          .set(bearer(s.clin.token));
      const first = await get().expect(200);
      expect(first.body.data.map((d: Json) => d.id)).toEqual(ids);
      expect(first.body.meta).toEqual({ page: 1, pageSize: 20, total: 21, totalPages: 2 });
      const second = await get('?page=2').expect(200);
      expect(second.body.data.map((d: Json) => d.id)).toEqual([target.id]);
      const open = await get('?status=open&pageSize=1').expect(200);
      expect(open.body.data.map((d: Json) => d.id)).toEqual([target.id]);
      expect(open.body.meta.total).toBe(1);
      const empty = await get('?status=open&page=2&pageSize=1').expect(200);
      expect(empty.body).toEqual({ data: [], meta: { page: 2, pageSize: 1, total: 1, totalPages: 1 } });
      await get('?pageSize=100').expect(200);
      for (const bad of ['page=0', 'page=-1', 'page=1.5', 'pageSize=0', 'pageSize=101', 'page=9007199254740991&pageSize=100', 'page=1&page=2', 'unknown=1'])
        await get('?' + bad).expect(400);
      const after = (await lab.evaluate(s.clin, s.reportId, body(s)).expect(201)).body;
      expect(resultFor(after, 'drugq')).toMatchObject({ outcome: 'held', reasonCode: 'cell-disputed', recommendationText: null });
      expect(contentOf(resultFor(after, 'drugr'))).toEqual(contentOf(resultFor(s.e, 'drugr')));
      expect(resultFor(after, 'drugr').id).not.toBe(resultFor(s.e, 'drugr').id); // its own stored row
      expect(after.advisory.activeDisputes).toBe(1);
      const history = await lab.api().get('/api/v1/evaluations?pageSize=1').set(bearer(s.clin.token)).expect(200);
      expect(history.body.data[0].advisory.activeDisputes).toBe(1);
    });

    it('stores it as open, taking the guideline version and the file hash from the loaded knowledge, with only the note digest in the answer', async () => {
      const s = await evaluatedD01();
      const cell = cellOf(resultFor(s.e, 'drugq'));
      const before = { disputes: await disputes(), events: await events() };
      const res = await raise(s.rev, { ...cell, note: 'SYN: the cell looks wrong' }).expect(201);
      expect(disputeDtoSchema.safeParse(res.body).success).toBe(true);
      const guideline = knowledge.allGuidelines().find((g) => g.id === cell.guidelineId)!;
      expect(res.body).toMatchObject({
        guidelineId: cell.guidelineId,
        guidelineVersion: guideline.guidelineVersion,
        guidelineContentSha256: knowledge.files.find((f) => f.id === cell.guidelineId)!.contentSha256,
        locator: { table: cell.locator.table, row: cell.locator.row, column: null },
        status: 'open',
        inForce: true,
        decision: null,
      });
      expect(res.body.note).toEqual({ id: expect.any(String), bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(JSON.stringify(res.body)).not.toMatch(/the cell looks wrong|createdBy|created_by|tenant/i);
      expect(await disputes()).toBe(before.disputes + 1);
      expect(await events()).toBe(before.events + 1);
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
    });

    it('takes nothing but the documented fields: the version and the hash cannot be supplied, nor the author', async () => {
      const s = await evaluatedD01();
      const cell = cellOf(resultFor(s.e, 'drugq'));
      const count = await disputes();
      for (const extra of [{ guidelineVersion: '9' }, { guidelineContentSha256: 'a'.repeat(64) }, { createdBy: 'someone-else' }]) {
        await raise(s.rev, { ...cell, note: 'SYN: x', ...extra }).expect(400);
      }
      for (const bad of [
        { ...cell },
        { ...cell, note: '' },
        { ...cell, note: 'x'.repeat(1001) },
        { ...cell, locator: {}, note: 'x' },
        { guidelineId: '', locator: cell.locator, note: 'x' },
      ]) {
        await raise(s.rev, bad).expect(400);
      }
      expect(await disputes()).toBe(count);
    });

    it('refuses a guideline that is not loaded (404 unknown-guideline) and a cell it does not have (409 unknown-cell); each stores nothing', async () => {
      const s = await evaluatedD01();
      const cell = cellOf(resultFor(s.e, 'drugq'));
      const before = { disputes: await disputes(), events: await events() };
      const noGuideline = await raise(s.rev, { ...cell, guidelineId: 'no-such-guideline', note: 'SYN: x' }).expect(404);
      expect(noGuideline.body.error.details[0].reason).toBe('unknown-guideline');
      const noCell = await raise(s.rev, { ...cell, locator: { ...cell.locator, row: 'no such row' }, note: 'SYN: x' }).expect(409);
      expect(noCell.body.error.details[0].reason).toBe('unknown-cell');
      await raise(s.rev, { ...cell, locator: { ...cell.locator, column: 'no such column' }, note: 'SYN: x' }).expect(409);
      expect({ disputes: await disputes(), events: await events() }).toEqual(before);
      await raise(s.rev, { ...cell, note: 'SYN: control, the real cell' }).expect(201);
    });

    it('only a reviewer raises one: reader, clinician and an admin alone are 403, no token is 401; none stores anything', async () => {
      const s = await evaluatedD01();
      const cell = cellOf(resultFor(s.e, 'drugq'));
      const count = await disputes();
      for (const roles of [['reader'], ['clinician'], ['admin']]) await raise(await lab.person('x', roles), { ...cell, note: 'SYN: x' }).expect(403);
      await lab
        .api()
        .post('/api/v1/cell-disputes')
        .send({ ...cell, note: 'SYN: x' })
        .expect(401);
      expect(await disputes()).toBe(count);
      await raise(await lab.person('both', ['admin', 'reviewer']), { ...cell, note: 'SYN: control' }).expect(201);
    });
  });

  describe('what a dispute does to the next evaluation (the overlay)', () => {
    it('holds only the disputed cell, with its citation and NO wording; the other drug and the earlier evaluation are untouched', async () => {
      const s = await evaluatedD01();
      const cell = cellOf(resultFor(s.e, 'drugq'));
      await raise(s.rev, { ...cell, note: 'SYN: x' }).expect(201);

      // The same request again is a NEW evaluation: the effective knowledge is different, so it is not a replay.
      const after = await lab.evaluate(s.clin, s.reportId, body(s)).expect(201);
      expect(after.body.id).not.toBe(s.e.id);
      expect(resultFor(after.body, 'drugq')).toMatchObject({ outcome: 'held', reasonCode: 'cell-disputed', citation: { guidelineId: cell.guidelineId } });
      expect(resultFor(after.body, 'drugq').recommendationText).toBeNull();
      expect(resultFor(after.body, 'drugq').strength).toBeNull();
      expect(JSON.stringify(resultFor(after.body, 'drugq'))).not.toContain('Q intermediate.');
      expect(contentOf(resultFor(after.body, 'drugr'))).toEqual(contentOf(resultFor(s.e, 'drugr'))); // an unrelated drug is exactly as before
      expect(resultFor(after.body, 'drugr').id).not.toBe(resultFor(s.e, 'drugr').id); // in its own stored row
      expect(after.body.geneStates).toEqual(s.e.geneStates);
      expect(after.body.knowledgeSetId).not.toBe(knowledge.id);

      // The earlier evaluation is history: unchanged, still shown, and it says a dispute is active now.
      const old = (await lab.api().get(`/api/v1/evaluations/${s.e.id}`).set(bearer(s.clin.token)).expect(200)).body;
      expect(resultFor(old, 'drugq')).toMatchObject({ outcome: 'shown', recommendationText: 'Q intermediate.' });
      expect(old.advisory.activeDisputes).toBeGreaterThanOrEqual(1);
      expect(old.knowledgeSetId).toBe(knowledge.id);
    });

    it('records how to rebuild the effective set: the effective id, and the base id and the disputed cell keys inside the stored binding', async () => {
      const s = await evaluatedD01();
      const cited = resultFor(s.e, 'drugq');
      const cell = cellOf(cited);
      await raise(s.rev, { ...cell, note: 'SYN: x' }).expect(201);
      const after = (await lab.evaluate(s.clin, s.reportId, body(s)).expect(201)).body;
      const stored = (await lab.row<{ binding: Json; knowledge_set_id: string }>(`SELECT binding, knowledge_set_id FROM evaluations WHERE id = $1`, [after.id]))[0]!;
      const file = knowledge.files.find((f) => f.id === cell.guidelineId)!;
      const version = knowledge.allGuidelines().find((g) => g.id === cell.guidelineId)!.guidelineVersion;
      const keys = [[cell.guidelineId, version, file.contentSha256, cell.locator.table, cell.locator.row, cell.locator.column ?? null]];
      expect(stored.binding.overlay).toEqual({ version: 'overlay/1', baseKnowledgeSetId: knowledge.id, cellKeys: keys });
      expect(stored.knowledge_set_id).toBe(effectiveKnowledgeSetId(knowledge.id, keys as never));
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] }); // the binding is inside the hashed record
    });

    it('a report whose result does not use the disputed cell is evaluated exactly as without the dispute', async () => {
      const s = await evaluatedD01();
      await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugq')), note: 'SYN: x' }).expect(201);
      const d02 = await lab.reviewedCapture(fixturePdf('D02'));
      const e = (await lab.evaluate(d02.clinician, d02.reportId, body(d02)).expect(201)).body;
      expect(resultFor(e, 'drugq')).toMatchObject({ outcome: 'held', reasonCode: 'allele-not-in-definitions' }); // as the hand-written golden says
      expect(resultFor(e, 'drugr')).toMatchObject({ outcome: 'held', reasonCode: 'allele-not-in-definitions' });
    });

    it("one tenant's dispute never changes another tenant's evaluation", async () => {
      const mine = await evaluatedD01();
      await raise(mine.rev, { ...cellOf(resultFor(mine.e, 'drugq')), note: 'SYN: x' }).expect(201);
      const other = new LabPipeline(app, db.adminUrl);
      const theirs = await evaluatedD01(other); // asserts drugq is shown
      expect(theirs.e.knowledgeSetId).toBe(knowledge.id);
    });

    it('a dispute about a cell that is already unverified changes nothing: the overlay can only tighten', async () => {
      const unverified = knowledge.allGuidelines().flatMap((g) => g.recommendations.filter((r) => r.verification.state === 'unverified').map((r) => ({ g, r })))[0]!;
      const s = await evaluatedD01();
      const count = await disputes();
      await raise(s.rev, {
        guidelineId: unverified.g.id,
        locator: { table: unverified.r.locator.table, row: unverified.r.locator.row, ...(unverified.r.locator.column ? { column: unverified.r.locator.column } : {}) },
        note: 'SYN: x',
      }).expect(201);
      expect(await disputes()).toBe(count + 1);
      const replay = await lab.evaluate(s.clin, s.reportId, body(s));
      expect(replay.status).toBe(200); // the same effective knowledge, so the very same evaluation
      expect(replay.body.id).toBe(s.e.id);
    });

    it("dismissing restores the file's own state: the next request is the original evaluation again (a replay)", async () => {
      const s = await evaluatedD01();
      const raised = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugq')), note: 'SYN: x' }).expect(201)).body;
      const held = (await lab.evaluate(s.clin, s.reportId, body(s)).expect(201)).body;
      expect(resultFor(held, 'drugq').outcome).toBe('held');
      const other = await lab.person('rev-other', ['reviewer']);
      const decided = await decide(other, raised.id, { decision: 'dismissed', evidenceNote: 'SYN: the cell is right' }).expect(201);
      expect(decided.body).toMatchObject({ status: 'dismissed', inForce: false, decision: { decision: 'dismissed' } });
      const again = await lab.evaluate(s.clin, s.reportId, body(s));
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(s.e.id); // the effective knowledge is the base set again, so it is the original evaluation
      expect(resultFor(again.body, 'drugq').outcome).toBe('shown');
    });

    it('upholding keeps the cell held; the dispute stays in force', async () => {
      const s = await evaluatedD01();
      const raised = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugq')), note: 'SYN: x' }).expect(201)).body;
      const other = await lab.person('rev-other', ['reviewer']);
      const decided = await decide(other, raised.id, { decision: 'upheld', evidenceNote: 'SYN: the cell is wrong' }).expect(201);
      expect(decided.body).toMatchObject({ status: 'upheld', inForce: true });
      const held = (await lab.evaluate(s.clin, s.reportId, body(s)).expect(201)).body;
      expect(resultFor(held, 'drugq')).toMatchObject({ outcome: 'held', reasonCode: 'cell-disputed' });
      expect(held.advisory.activeDisputes).toBeGreaterThanOrEqual(1);
    });
  });

  describe('a dispute that appears while an evaluation is being made is never missed', () => {
    it('raised between the read of the disputes and the store: refused after the ledger lock, then evaluated once more with it, reading the report only once', async () => {
      const first = await evaluatedD01();
      const cell = cellOf(resultFor(first.e, 'drugq'));
      // A report that has no evaluation yet: an evaluation that is already stored is returned as a replay before this check, by design.
      const s = { ...(await lab.reviewedCapture(fixturePdf('D01'), { clinician: first.clin, reviewer: first.rev })), clin: first.clin };
      const ledger = app.get(LedgerRecordsRepository);
      const reader = app.get<ReportReader>(LAB_READER);
      const reads = jest.spyOn(reader, 'read');
      const real = ledger.listDisputes.bind(ledger); // taken BEFORE the spy replaces it
      const list = jest.spyOn(ledger, 'listDisputes');
      let raisedId = '';
      // The first look at the disputes returns the state BEFORE the dispute, which is then raised for real: exactly the race.
      list.mockImplementationOnce(async (tenantId: string) => {
        const stale = await real(tenantId);
        raisedId = (
          await ledger.raiseDispute(tenantId, 'syn-late-disputer', {
            ...cell,
            guidelineVersion: knowledge.allGuidelines().find((g) => g.id === cell.guidelineId)!.guidelineVersion,
            guidelineContentSha256: knowledge.files.find((f) => f.id === cell.guidelineId)!.contentSha256,
            locator: cell.locator,
            note: 'SYN: late',
          })
        ).record.id;
        return stale;
      });
      try {
        const res = await lab.evaluate(s.clin, s.reportId, body(s)).expect(201);
        expect(raisedId).not.toBe('');
        expect(resultFor(res.body, 'drugq')).toMatchObject({ outcome: 'held', reasonCode: 'cell-disputed' }); // the retry saw it
        expect(reads).toHaveBeenCalledTimes(1); // the reader was not run again
        expect(await evaluationsOf(s.reportId)).toBe(1); // this one only: the refused attempt left nothing
      } finally {
        list.mockRestore();
        reads.mockRestore();
      }
    });

    it('if it keeps changing: 409 dispute-changed after one retry, nothing stored, and the same request works afterwards', async () => {
      const first = await evaluatedD01();
      const cell = cellOf(resultFor(first.e, 'drugq'));
      const s = { ...(await lab.reviewedCapture(fixturePdf('D01'), { clinician: first.clin, reviewer: first.rev })), clin: first.clin };
      const ledger = app.get(LedgerRecordsRepository);
      const real = ledger.listDisputes.bind(ledger); // taken BEFORE the spy replaces it
      const list = jest.spyOn(ledger, 'listDisputes');
      const stale = async (tenantId: string) => {
        const seen = await real(tenantId);
        if (!(await real(tenantId)).some((d) => d.dispute.createdBy === 'syn-late-disputer')) {
          await ledger.raiseDispute(tenantId, 'syn-late-disputer', {
            ...cell,
            guidelineVersion: knowledge.allGuidelines().find((g) => g.id === cell.guidelineId)!.guidelineVersion,
            guidelineContentSha256: knowledge.files.find((f) => f.id === cell.guidelineId)!.contentSha256,
            locator: cell.locator,
            note: 'SYN: late',
          });
        }
        return seen.filter((d) => d.dispute.createdBy !== 'syn-late-disputer'); // always one dispute behind
      };
      list.mockImplementationOnce(stale).mockImplementationOnce(stale);
      const before = await evaluationsOf(s.reportId);
      try {
        const res = await lab.evaluate(s.clin, s.reportId, body(s)).expect(409);
        expect(res.body.error.details[0].reason).toBe('dispute-changed');
        expect(await evaluationsOf(s.reportId)).toBe(before);
      } finally {
        list.mockRestore();
      }
      const retry = await lab.evaluate(s.clin, s.reportId, body(s)).expect(201); // control: with the mock gone, the same request succeeds and holds the cell
      expect(resultFor(retry.body, 'drugq')).toMatchObject({ outcome: 'held', reasonCode: 'cell-disputed' });
    });
  });

  describe('deciding a dispute', () => {
    it('is final, by someone other than the raiser, with required evidence; the raiser, a second decision and a stranger are refused', async () => {
      const s = await evaluatedD01();
      const raised = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugq')), note: 'SYN: x' }).expect(201)).body;
      const before = { events: await events(), decisions: await lab.count('cell_dispute_decisions', 'tenant_id = $1', [lab.tenant]) };

      const self = await decide(s.rev, raised.id, { decision: 'dismissed', evidenceNote: 'SYN: mine' }).expect(409);
      expect(self.body.error.details[0].reason).toBe('self-decision');
      await decide(await lab.person('rev-other', ['reviewer']), raised.id, { decision: 'upheld' }).expect(400); // the evidence is required
      await decide(await lab.person('rev-other', ['reviewer']), raised.id, { decision: 'maybe', evidenceNote: 'SYN: x' }).expect(400);
      await decide(await lab.person('rev-other', ['reviewer']), randomUUID(), { decision: 'upheld', evidenceNote: 'SYN: x' }).expect(404);
      for (const roles of [['reader'], ['clinician'], ['admin']]) await decide(await lab.person('x', roles), raised.id, { decision: 'upheld', evidenceNote: 'SYN: x' }).expect(403);
      await decide(await lab.person('stranger', ['reviewer'], 'tenant-elsewhere'), raised.id, { decision: 'upheld', evidenceNote: 'SYN: x' }).expect(404);
      expect({ events: await events(), decisions: await lab.count('cell_dispute_decisions', 'tenant_id = $1', [lab.tenant]) }).toEqual(before);

      const other = await lab.person('rev-other', ['reviewer']);
      const decided = await decide(other, raised.id, { decision: 'upheld', evidenceNote: 'SYN: evidence text' }).expect(201); // control
      expect(disputeDtoSchema.safeParse(decided.body).success).toBe(true);
      expect(decided.body.decision).toMatchObject({ decision: 'upheld', evidence: { id: expect.any(String), bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
      expect(JSON.stringify(decided.body)).not.toContain('evidence text');

      const again = await decide(await lab.person('rev-third', ['reviewer']), raised.id, { decision: 'dismissed', evidenceNote: 'SYN: changed my mind' }).expect(409);
      expect(again.body.error.details[0].reason).toBe('already-decided');
      expect((await lab.api().get(`/api/v1/cell-disputes/${raised.id}`).set(bearer(s.clin.token))).body.status).toBe('upheld'); // the final decision stands
      expect(await verifier.verify(lab.tenant)).toMatchObject({ status: 'ok', failures: [] });
    });

    it('two reviewers deciding at the same moment: exactly one decision is stored', async () => {
      const s = await evaluatedD01();
      const raised = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugq')), note: 'SYN: x' }).expect(201)).body;
      const [a, b] = [await lab.person('rev-a', ['reviewer']), await lab.person('rev-b', ['reviewer'])];
      const results = await Promise.all([
        decide(a, raised.id, { decision: 'upheld', evidenceNote: 'SYN: a' }),
        decide(b, raised.id, { decision: 'dismissed', evidenceNote: 'SYN: b' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await lab.count('cell_dispute_decisions', 'dispute_id = $1', [raised.id])).toBe(1);
    });
  });

  describe('reading disputes', () => {
    it('every clinical role may list and read, an administrator or a member with no role may not; a status filter narrows; another tenant sees none of them', async () => {
      const s = await evaluatedD01();
      const raised = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugq')), note: 'SYN: x' }).expect(201)).body;
      const other = await lab.person('rev-other', ['reviewer']);
      const second = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugr')), note: 'SYN: y' }).expect(201)).body;
      await decide(other, second.id, { decision: 'dismissed', evidenceNote: 'SYN: z' }).expect(201);

      const noRole = await lab.person('x', []);
      await lab.api().get('/api/v1/cell-disputes').set(bearer(noRole.token)).expect(403); // finding I04
      await lab.api().get(`/api/v1/cell-disputes/${raised.id}`).set(bearer(noRole.token)).expect(403);
      const admin = await lab.person('x', ['admin']);
      await lab.api().get('/api/v1/cell-disputes').set(bearer(admin.token)).expect(403); // administration is not clinical access
      await lab.api().get(`/api/v1/cell-disputes/${raised.id}`).set(bearer(admin.token)).expect(403);
      for (const roles of [['reader'], ['clinician'], ['reviewer'], ['admin', 'reader']]) {
        const who = await lab.person('x', roles);
        const list = await lab.api().get('/api/v1/cell-disputes').set(bearer(who.token)).expect(200);
        expect(list.body.data.map((d: Json) => d.id)).toEqual(expect.arrayContaining([raised.id, second.id]));
        expect(list.body.data.every((d: Json) => disputeDtoSchema.safeParse(d).success)).toBe(true);
        await lab.api().get(`/api/v1/cell-disputes/${raised.id}`).set(bearer(who.token)).expect(200);
      }
      const open = await lab.api().get('/api/v1/cell-disputes?status=open').set(bearer(s.clin.token)).expect(200);
      expect(open.body.data.map((d: Json) => d.id)).toContain(raised.id);
      expect(open.body.data.map((d: Json) => d.id)).not.toContain(second.id);
      expect((await lab.api().get('/api/v1/cell-disputes?status=dismissed').set(bearer(s.clin.token)).expect(200)).body.data.map((d: Json) => d.id)).toContain(second.id);
      await lab.api().get('/api/v1/cell-disputes?status=nope').set(bearer(s.clin.token)).expect(400);

      const stranger = await lab.person('stranger', ['clinician'], 'tenant-elsewhere');
      expect((await lab.api().get('/api/v1/cell-disputes').set(bearer(stranger.token)).expect(200)).body.data).toEqual([]);
      await lab.api().get(`/api/v1/cell-disputes/${raised.id}`).set(bearer(stranger.token)).expect(404);
      await lab.api().get(`/api/v1/cell-disputes/${randomUUID()}`).set(bearer(s.clin.token)).expect(404);
    });
  });

  it('nothing the dispute routes write to the log contains a note or evidence text', async () => {
    const s = await evaluatedD01();
    const lines: string[] = [];
    const capture = new (class extends ConsoleLogger {
      override log(...args: unknown[]) {
        lines.push(JSON.stringify(args));
      }
      override warn(...args: unknown[]) {
        lines.push(JSON.stringify(args));
      }
      override error(...args: unknown[]) {
        lines.push(JSON.stringify(args));
      }
    })();
    Logger.overrideLogger(capture);
    try {
      const raised = (await raise(s.rev, { ...cellOf(resultFor(s.e, 'drugq')), note: 'SYN: zebra-91 note' }).expect(201)).body;
      await decide(s.rev, raised.id, { decision: 'upheld', evidenceNote: 'SYN: zebra-91 evidence' }).expect(409); // a refusal is logged too
      await decide(await lab.person('rev-other', ['reviewer']), raised.id, { decision: 'upheld', evidenceNote: 'SYN: zebra-91 evidence' }).expect(201);
      await lab.evaluate(s.clin, s.reportId, body(s)).expect(201);
    } finally {
      Logger.overrideLogger(['error', 'warn']);
    }
    expect(lines.join('\n')).not.toContain('zebra-91');
    expect(await lab.row(`SELECT 1 FROM ledger_events WHERE row_to_json(ledger_events)::text LIKE '%zebra-91%'`)).toEqual([]);
  });

  it('the ledger chain of every tenant used above verifies', async () => {
    expect(tenants.length).toBeGreaterThan(10);
    for (const tenant of tenants.slice(0, -1)) {
      const result = await verifier.verify(tenant);
      expect(result).toMatchObject({ status: 'ok', failures: [] });
      expect(result.eventsChecked).toBe(await events(tenant));
    }
  });

  it('is wired to the same loaded knowledge the evaluations use', () => {
    expect(app.get<KnowledgeSet>(LAB_KNOWLEDGE).id).toBe(knowledge.id);
  });
});
