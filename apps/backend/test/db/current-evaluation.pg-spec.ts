import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';

// "Current" (specification 4.5) and note reads, at the repository, where the SQL is. The HTTP behaviour is in lab-reports-corrections.e2e-spec.
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
let superuser: Database;
let bypassing: PostgresLedgerRecordsRepository;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
  // A superuser bypasses row-level security, so with it the repository's OWN tenant conditions are the only thing left standing.
  superuser = new Database({ url: pg.adminUrl, ssl: 'disable' });
  bypassing = new PostgresLedgerRecordsRepository(superuser);
});
afterAll(async () => {
  await superuser.onModuleDestroy();
  await database.onModuleDestroy();
  await pg.drop();
});

const tenant = () => `tenant-${randomUUID()}`;

/** A report with an accepted capture; `evaluate()` stores one more evaluation of it (each call differs in its knowledge set, so each is new). */
async function report(t: string) {
  const seeded = await seedLabReport(pg.adminUrl, t);
  const capture = captureFor(seeded);
  const c = await repo.insertCapture(t, seeded.uploader, capture);
  const a = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
  let n = 0;
  const evaluate = async () => (await repo.insertEvaluation(t, 'syn-system', evaluationFor(seeded, c.record.id, a.record.id, { knowledgeSetId: sha(`ks-${++n}`) }))).record.id;
  /** One more evaluation of it that is HELD (as evaluation-context.pg-spec stores one): no inputs, no results, a hold code. */
  const hold = async () =>
    (
      await repo.insertEvaluation(
        t,
        'syn-system',
        evaluationFor(seeded, c.record.id, a.record.id, {
          knowledgeSetId: sha(`ks-${++n}`),
          captureAcceptanceId: null,
          disposition: 'held',
          holdCode: 'source-limit',
          geneInputs: [],
          occurrences: [],
          results: [],
          geneStates: [],
        }),
      )
    ).record.id;
  return { reportId: seeded.reportId, evaluate, hold };
}
const retract = (t: string, evaluationId: string, previous?: string) =>
  repo.insertCorrection(t, 'syn-reviewer', { evaluationId, kind: 'retraction', reasonCode: 'software-defect', previousCorrectionId: previous }).then((r) => r.record.id);
const reinstate = (t: string, evaluationId: string, previous: string) =>
  repo.insertCorrection(t, 'syn-reviewer-2', { evaluationId, kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: previous }).then((r) => r.record.id);
const current = async (t: string, reportId: string) => (await repo.currentEvaluationIds(t, [reportId])).get(reportId);

describe('the current evaluation of a report', () => {
  it('is the NEWEST evaluation if it is active and otherwise none (an older active one is never promoted), through retraction, reinstatement and supersession', async () => {
    const t = tenant();
    const r = await report(t);
    expect(await current(t, r.reportId)).toBeNull(); // no evaluation yet: an entry, and it is null
    const e1 = await r.evaluate();
    expect(await current(t, r.reportId)).toBe(e1);
    const e2 = await r.evaluate();
    expect(await current(t, r.reportId)).toBe(e2);

    const retraction = await retract(t, e2);
    expect(await current(t, r.reportId)).toBeNull(); // the newest is retracted: e1 is still active, but it is NOT current (specification 22)
    const second = await retract(t, e1);
    expect(await current(t, r.reportId)).toBeNull();
    const reinstated = await reinstate(t, e2, retraction);
    expect(await current(t, r.reportId)).toBe(e2); // a reinstatement makes the newest current again
    await reinstate(t, e1, second);
    expect(await current(t, r.reportId)).toBe(e2); // e1 is active too, but e2 is the newer one

    const e3 = await r.evaluate();
    await repo.insertCorrection(t, 'syn-reviewer', {
      evaluationId: e2,
      kind: 'supersession',
      reasonCode: 'software-defect',
      previousCorrectionId: reinstated,
      replacementEvaluationId: e3,
    });
    expect(await current(t, r.reportId)).toBe(e3);
    const third = await retract(t, e3);
    expect(await current(t, r.reportId)).toBeNull(); // e2 is superseded (terminal) and e1 is active, yet neither is the newest: nothing is current
    await reinstate(t, e3, third);
    expect(await current(t, r.reportId)).toBe(e3); // control: the newest, active again, is current again

    const e4 = await r.evaluate();
    await retract(t, e4);
    expect(await current(t, r.reportId)).toBeNull();
    const e5 = await r.evaluate();
    expect(await current(t, r.reportId)).toBe(e5); // a fresh evaluation is what restores a current one after a retraction
  });

  it('never makes a superseded evaluation current, even if the database was handed a replacement that is OLDER (the service refuses that; the query must not depend on it)', async () => {
    const t = tenant();
    const r = await report(t);
    const e1 = await r.evaluate();
    const e2 = await r.evaluate();
    expect(await current(t, r.reportId)).toBe(e2); // control: before the supersession, e2 is current
    await repo.insertCorrection(t, 'syn-reviewer', { evaluationId: e2, kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId: e1 });
    expect(await current(t, r.reportId)).toBeNull(); // e2 is superseded and still the newest; e1 is not promoted either
  });

  it('is decided per report, and the list filter agrees with it', async () => {
    const t = tenant();
    const a = await report(t);
    const b = await report(t);
    const [a1, a2, b1] = [await a.evaluate(), await a.evaluate(), await b.evaluate()];
    expect([...(await repo.currentEvaluationIds(t, [a.reportId, b.reportId])).entries()].sort()).toEqual(
      [
        [a.reportId, a2],
        [b.reportId, b1],
      ].sort(),
    );
    await retract(t, a2);
    const listed = (await repo.listEvaluations(t, { current: true }, { offset: 0, limit: 100 })).items.map((e) => e.id).sort();
    expect(listed).toEqual([b1]); // a's newest is retracted, so a has no current evaluation (a1 is active but not promoted)
    expect((await repo.listEvaluations(t, {}, { offset: 0, limit: 100 })).items.map((e) => e.id).sort()).toEqual([a1, a2, b1].sort());
    expect((await repo.listEvaluations(t, { current: true, reportId: b.reportId }, { offset: 0, limit: 100 })).items.map((e) => e.id)).toEqual([b1]);
    expect((await repo.listEvaluations(t, { current: true, reportId: randomUUID() }, { offset: 0, limit: 100 })).items).toEqual([]);
  });

  it('gives a report the same answer whichever other reports are asked about with it', async () => {
    const t = tenant();
    const [a, b, c, d] = [await report(t), await report(t), await report(t), await report(t)];
    const [a1, a2, b1, c1, c2] = [await a.evaluate(), await a.evaluate(), await b.evaluate(), await c.evaluate(), await c.evaluate()];
    await retract(t, a2); // a: the newest is retracted, so none is current
    await retract(t, c1); // c: an older one is retracted, the newest stays current
    const everyone = [a, b, c, d].map((r) => r.reportId);
    const all = await repo.currentEvaluationIds(t, everyone);
    expect([...all.entries()]).toEqual([
      [a.reportId, null],
      [b.reportId, b1],
      [c.reportId, c2],
      [d.reportId, null], // no evaluation at all
    ]);
    const unknown = randomUUID();
    for (const subset of [[a], [b], [c], [d], [a, b], [b, c], [c, d, a], [d, c, b, a]]) {
      const asked = subset.map((r) => r.reportId);
      const answer = await repo.currentEvaluationIds(t, asked);
      expect([...answer.entries()]).toEqual(asked.map((id) => [id, all.get(id)]));
    }
    expect([...(await repo.currentEvaluationIds(t, [unknown, b.reportId])).entries()]).toEqual([
      [unknown, null],
      [b.reportId, b1],
    ]);
    expect((await repo.currentEvaluationIds(t, [])).size).toBe(0);
    // The list filter, which needs every report, agrees with the per-report answers.
    const listed = (await repo.listEvaluations(t, { current: true }, { offset: 0, limit: 100 })).items.map((e) => e.id).sort();
    expect(listed).toEqual([...all.values()].filter((id): id is string => id !== null).sort());
    expect(a1).not.toBe(a2);
  });

  it("never looks at another tenant's evaluations (checked as a superuser, where only the query's own conditions protect)", async () => {
    const ta = tenant();
    const tb = tenant();
    const a = await report(ta);
    const b = await report(tb);
    const [ea, eb] = [await a.evaluate(), await b.evaluate()];
    expect(await bypassing.currentEvaluationIds(ta, [a.reportId, b.reportId])).toEqual(
      new Map([
        [a.reportId, ea],
        [b.reportId, null],
      ]),
    );
    expect((await bypassing.listEvaluations(ta, {}, { offset: 0, limit: 100 })).items.map((e) => e.id)).toEqual([ea]); // the unfiltered list, too
    expect((await bypassing.listEvaluations(ta, { current: true }, { offset: 0, limit: 100 })).items.map((e) => e.id)).toEqual([ea]);
    expect((await bypassing.listEvaluations(tb, { current: true }, { offset: 0, limit: 100 })).items.map((e) => e.id)).toEqual([eb]);
    // A correction of tenant B's evaluation must not change tenant A's answer either (the subquery over corrections is tenant-scoped too).
    await retract(tb, eb);
    expect((await bypassing.listEvaluations(ta, { current: true }, { offset: 0, limit: 100 })).items.map((e) => e.id)).toEqual([ea]);
    expect((await bypassing.listEvaluations(tb, { current: true }, { offset: 0, limit: 100 })).items).toEqual([]);
  });
});

// Spec 049 W1: the worklist's "Held results" reads `disposition=held&current=true`. Hand-written expectations: which evaluation was stored held.
describe('the disposition filter', () => {
  const all = { offset: 0, limit: 100 };
  const ids = async (t: string, filter: Parameters<typeof repo.listEvaluations>[1]) => (await repo.listEvaluations(t, filter, all)).items.map((e) => e.id);

  it('keeps only held or only evaluated evaluations, composes with current and reportId, and counts the filtered set', async () => {
    const t = tenant();
    const a = await report(t); // evaluated only
    const h = await report(t); // held only: held and current
    const g = await report(t); // held, then evaluated: the held one is no longer current
    const a1 = await a.evaluate();
    const h1 = await h.hold();
    const g1 = await g.hold();
    const g2 = await g.evaluate();

    expect(await ids(t, { disposition: 'held' })).toEqual([h1, g1]);
    expect(await ids(t, { disposition: 'evaluated' })).toEqual([a1, g2]);
    expect(await ids(t, {})).toEqual([a1, h1, g1, g2]); // absent: both, as before
    expect(await ids(t, { disposition: 'held', current: true })).toEqual([h1]);
    expect(await ids(t, { disposition: 'evaluated', current: true })).toEqual([a1, g2]);
    expect(await ids(t, { disposition: 'held', reportId: g.reportId })).toEqual([g1]);
    expect(await ids(t, { disposition: 'held', current: true, reportId: g.reportId })).toEqual([]);

    // The total is the filtered set's, also when the page holds fewer.
    const first = await repo.listEvaluations(t, { disposition: 'held' }, { offset: 0, limit: 1 });
    expect(first.items.map((e) => e.id)).toEqual([h1]);
    expect(first.total).toBe(2);
    const page = await repo.evaluationPage(t, { disposition: 'held', current: true }, { offset: 0, limit: 1 });
    expect(page.items.map((e) => e.id)).toEqual([h1]);
    expect(page.total).toBe(1);
  });

  it("never lists another tenant's held evaluations (checked as a superuser, where only the query's own conditions protect)", async () => {
    const ta = tenant();
    const tb = tenant();
    const ha = await (await report(ta)).hold();
    const hb = await (await report(tb)).hold();
    expect((await bypassing.listEvaluations(ta, { disposition: 'held' }, all)).items.map((e) => e.id)).toEqual([ha]);
    expect((await bypassing.listEvaluations(tb, { disposition: 'held', current: true }, all)).items.map((e) => e.id)).toEqual([hb]);
    expect((await bypassing.listEvaluations(ta, { disposition: 'evaluated' }, all)).total).toBe(0);
  });
});

describe('reading a note', () => {
  it("returns the text to its own tenant and nothing to another (checked as a superuser, where only the query's own tenant condition protects)", async () => {
    const ta = tenant();
    const tb = tenant();
    const a = await report(ta);
    const ea = await a.evaluate();
    const noteText = 'SYN: a note';
    const { record } = await repo.insertCorrection(ta, 'syn-reviewer', { evaluationId: ea, kind: 'retraction', reasonCode: 'clinical-review-disagrees', note: noteText });
    const noteId = (record.note as { id: string }).id;
    expect(await repo.findNote(ta, noteId)).toMatchObject({ id: noteId, body: noteText, redacted: false });
    expect(await repo.findNote(tb, noteId)).toBeUndefined(); // row-level security
    expect(await bypassing.findNote(tb, noteId)).toBeUndefined(); // the query's own condition
    expect(await bypassing.findNote(ta, noteId)).toMatchObject({ id: noteId }); // control: the superuser connection can read it for its own tenant
    expect(await repo.findNote(ta, randomUUID())).toBeUndefined();
  });
});
