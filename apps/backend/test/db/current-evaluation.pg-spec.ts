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
  return { reportId: seeded.reportId, evaluate };
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
    await repo.insertCorrection(t, 'syn-reviewer', { evaluationId: e2, kind: 'supersession', reasonCode: 'software-defect', previousCorrectionId: reinstated, replacementEvaluationId: e3 });
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
    expect([...(await repo.currentEvaluationIds(t, [a.reportId, b.reportId])).entries()].sort()).toEqual([[a.reportId, a2], [b.reportId, b1]].sort());
    await retract(t, a2);
    const listed = (await repo.listEvaluations(t, { current: true })).map((e) => e.id).sort();
    expect(listed).toEqual([b1]); // a's newest is retracted, so a has no current evaluation (a1 is active but not promoted)
    expect((await repo.listEvaluations(t, {})).map((e) => e.id).sort()).toEqual([a1, a2, b1].sort());
    expect((await repo.listEvaluations(t, { current: true, reportId: b.reportId })).map((e) => e.id)).toEqual([b1]);
    expect(await repo.listEvaluations(t, { current: true, reportId: randomUUID() })).toEqual([]);
  });

  it("never looks at another tenant's evaluations (checked as a superuser, where only the query's own conditions protect)", async () => {
    const ta = tenant();
    const tb = tenant();
    const a = await report(ta);
    const b = await report(tb);
    const [ea, eb] = [await a.evaluate(), await b.evaluate()];
    expect(await bypassing.currentEvaluationIds(ta, [a.reportId, b.reportId])).toEqual(new Map([[a.reportId, ea], [b.reportId, null]]));
    expect((await bypassing.listEvaluations(ta, {})).map((e) => e.id)).toEqual([ea]); // the unfiltered list, too
    expect((await bypassing.listEvaluations(ta, { current: true })).map((e) => e.id)).toEqual([ea]);
    expect((await bypassing.listEvaluations(tb, { current: true })).map((e) => e.id)).toEqual([eb]);
    // A correction of tenant B's evaluation must not change tenant A's answer either (the subquery over corrections is tenant-scoped too).
    await retract(tb, eb);
    expect((await bypassing.listEvaluations(ta, { current: true })).map((e) => e.id)).toEqual([ea]);
    expect(await bypassing.listEvaluations(tb, { current: true })).toEqual([]);
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
