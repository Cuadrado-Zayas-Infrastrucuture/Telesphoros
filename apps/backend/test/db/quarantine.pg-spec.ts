import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { acceptanceFor, captureFor, evaluationFor, type SeededReport, seedLabReport, sha } from '../helpers/ledger-fixtures';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * Wrong-chart quarantine at the repository, where the SQL is (M2.1c-1). The HTTP behaviour is in patient-quarantine.e2e-spec.
 * A report is quarantined when the newest link decision names the file and patient it holds now and says `rejected`.
 */
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
  await superuser?.onModuleDestroy();
  await database?.onModuleDestroy();
  await pg?.drop();
});

const tenant = () => `tenant-${randomUUID().slice(0, 8)}`;
const bindings = (r: SeededReport) => ({ patientId: r.patientId, sha256: r.pdfSha256, objectVersion: r.objectVersion });

/** A report with an accepted capture; `evaluate()` stores one more evaluation of it (each differs in its knowledge set, so each is new). */
async function report(t: string) {
  const r = await seedLabReport(pg.adminUrl, t);
  const capture = captureFor(r);
  const c = await repo.insertCapture(t, r.uploader, capture);
  const a = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
  let n = 0;
  const evaluate = async () => (await repo.insertEvaluation(t, 'syn-system', evaluationFor(r, c.record.id, a.record.id, { knowledgeSetId: sha(`ks-${r.reportId}-${++n}`) }))).record.id;
  const decide = (decision: 'verified' | 'rejected', by = 'syn-verifier') =>
    repo.insertPatientDecision(t, by, {
      reportId: r.reportId, expectedReport: bindings(r), decision, method: 'person-confirmed',
      basisCode: decision === 'verified' ? 'no-identifier-on-report' : 'different-person',
    }).then((x) => x.record.id);
  const replaceFile = () =>
    withAdmin(pg.adminUrl, async (cl) => {
      await cl.query('BEGIN');
      await cl.query('ALTER TABLE reports DISABLE TRIGGER USER'); // the product refuses to change an uploaded file; the owner can, once, on purpose
      await cl.query(`UPDATE reports SET object_version = 'replaced-' || object_version WHERE id = $1`, [r.reportId]);
      await cl.query('ALTER TABLE reports ENABLE TRIGGER USER');
      await cl.query('COMMIT');
    });
  return { r, evaluate, decide, replaceFile };
}
const retract = (t: string, evaluationId: string, previous?: string) =>
  repo.insertCorrection(t, 'syn-reviewer', { evaluationId, kind: 'retraction', reasonCode: 'wrong-patient', previousCorrectionId: previous }).then((x) => x.record.id);
const state = async (t: string, reportId: string) => (await repo.patientLinkStates(t, [reportId])).get(reportId);
const current = async (t: string, reportId: string) => (await repo.currentEvaluationIds(t, [reportId])).get(reportId);
const queue = async (t: string, r = repo) => (await r.pageQuarantine(t, { offset: 0, limit: 100 })).items;

describe('the link state of a report', () => {
  it('is unverified with no decision (including every evaluation made before the link existed), verified, or rejected, following the newest decision', async () => {
    const t = tenant();
    const x = await report(t);
    await x.evaluate(); // a "legacy" evaluation: stored with no decision at all
    expect(await state(t, x.r.reportId)).toBe('unverified');
    await x.decide('verified');
    expect(await state(t, x.r.reportId)).toBe('verified');
    await x.decide('rejected', 'syn-second');
    expect(await state(t, x.r.reportId)).toBe('rejected');
    await x.decide('verified', 'syn-third');
    expect(await state(t, x.r.reportId)).toBe('verified');
  });

  it('is unverified again after the file is replaced, whatever the old decision said', async () => {
    const t = tenant();
    for (const decision of ['verified', 'rejected'] as const) {
      const x = await report(t);
      await x.decide(decision);
      expect(await state(t, x.r.reportId)).toBe(decision);
      await x.replaceFile();
      expect(await state(t, x.r.reportId)).toBe('unverified');
    }
  });

  it('answers for every asked report, says unverified for an unknown one or another organization\'s (no leak), and an empty ask gives an empty answer', async () => {
    const a = tenant();
    const b = tenant();
    const x = await report(a);
    await x.decide('rejected');
    const unknown = randomUUID();
    const asked = await repo.patientLinkStates(b, [x.r.reportId, unknown]);
    expect([...asked.entries()]).toEqual([[x.r.reportId, 'unverified'], [unknown, 'unverified']]);
    expect([...(await bypassing.patientLinkStates(b, [x.r.reportId])).entries()]).toEqual([[x.r.reportId, 'unverified']]); // even without row-level security
    expect((await repo.patientLinkStates(a, [])).size).toBe(0);
    expect((await repo.patientLinkStates(a, [x.r.reportId])).get(x.r.reportId)).toBe('rejected'); // control
  });
});

describe('"current" for a quarantined report', () => {
  it('is none while the link is rejected for this file, and the newest evaluation again once it is verified or the file is replaced', async () => {
    const t = tenant();
    const x = await report(t);
    await x.evaluate();
    const e2 = await x.evaluate();
    expect(await current(t, x.r.reportId)).toBe(e2);
    await x.decide('rejected');
    expect(await current(t, x.r.reportId)).toBeNull();
    expect((await repo.listEvaluations(t, { current: true }, { offset: 0, limit: 50 })).total).toBe(0);
    expect((await repo.listEvaluations(t, {}, { offset: 0, limit: 50 })).total).toBe(2); // history is intact
    await x.decide('verified', 'syn-second');
    expect(await current(t, x.r.reportId)).toBe(e2);
    await x.decide('rejected', 'syn-third');
    expect(await current(t, x.r.reportId)).toBeNull();
    await x.replaceFile();
    expect(await current(t, x.r.reportId)).toBe(e2);
  });

  it('is unchanged for an organization\'s other reports and for another organization', async () => {
    const t = tenant();
    const other = tenant();
    const bad = await report(t);
    const good = await report(t);
    const foreign = await report(other);
    await bad.evaluate();
    const goodEval = await good.evaluate();
    const foreignEval = await foreign.evaluate();
    await bad.decide('rejected');
    expect(await current(t, good.r.reportId)).toBe(goodEval);
    expect(await current(other, foreign.r.reportId)).toBe(foreignEval);
  });
});

describe('the quarantine list', () => {
  it('lists a rejected report with its ACTIVE evaluations only, through retraction, reinstatement and supersession', async () => {
    const t = tenant();
    const x = await report(t);
    const e1 = await x.evaluate();
    const e2 = await x.evaluate();
    const e3 = await x.evaluate();
    expect(await queue(t)).toEqual([]); // not rejected yet
    await x.decide('rejected');
    expect((await queue(t))[0]).toMatchObject({ reportId: x.r.reportId, patientId: x.r.patientId, basisCode: 'different-person', activeEvaluationIds: [e1, e2, e3] });
    const r2 = await retract(t, e2);
    expect((await queue(t))[0]!.activeEvaluationIds).toEqual([e1, e3]);
    const reinstated = (await repo.insertCorrection(t, 'syn-independent', { evaluationId: e2, kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: r2 })).record.id;
    expect((await queue(t))[0]!.activeEvaluationIds).toEqual([e1, e2, e3]); // reinstated: active again
    await repo.insertCorrection(t, 'syn-reviewer', { evaluationId: e1, kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId: e3 });
    expect((await queue(t))[0]!.activeEvaluationIds).toEqual([e2, e3]); // superseded is not active
    await retract(t, e2, reinstated); // a correction names the one before it on the same evaluation
    await retract(t, e3);
    expect(await queue(t)).toEqual([]); // nothing left to act on
  });

  it('leaves out a report that is verified again, one rejected for an earlier file, and one with no evaluation at all', async () => {
    const t = tenant();
    const verified = await report(t);
    const replaced = await report(t);
    const empty = await report(t);
    await verified.evaluate();
    await replaced.evaluate();
    await verified.decide('rejected');
    await replaced.decide('rejected');
    await empty.decide('rejected');
    expect((await queue(t)).map((e) => e.reportId).sort()).toEqual([verified.r.reportId, replaced.r.reportId].sort());
    await verified.decide('verified', 'syn-second');
    await replaced.replaceFile();
    expect(await queue(t)).toEqual([]);
  });

  it('is ordered by the rejection, oldest first, with exact totals across pages, and never shows another organization\'s reports (even with row-level security out of the way)', async () => {
    const t = tenant();
    const other = tenant();
    const first = await report(t);
    const second = await report(t);
    const third = await report(t);
    const foreign = await report(other);
    for (const x of [first, second, third, foreign]) await x.evaluate();
    await second.decide('rejected'); // rejected first, though created second
    await first.decide('rejected');
    await third.decide('rejected');
    await foreign.decide('rejected');
    const pageOf = (offset: number, limit: number, r = repo) => r.pageQuarantine(t, { offset, limit });
    expect((await pageOf(0, 100)).items.map((e) => e.reportId)).toEqual([second.r.reportId, first.r.reportId, third.r.reportId]);
    const p1 = await pageOf(0, 2);
    const p2 = await pageOf(2, 2);
    const p3 = await pageOf(4, 2);
    expect([p1.items.length, p2.items.length, p3.items.length, p1.total, p2.total, p3.total]).toEqual([2, 1, 0, 3, 3, 3]);
    expect((await pageOf(0, 100, bypassing)).items.map((e) => e.reportId)).not.toContain(foreign.r.reportId);
    expect((await repo.pageQuarantine(other, { offset: 0, limit: 10 })).items.map((e) => e.reportId)).toEqual([foreign.r.reportId]);
  });

  it('gives an exact zero total for an organization with nothing quarantined', async () => {
    const page = await repo.pageQuarantine(tenant(), { offset: 0, limit: 10 });
    expect(page).toEqual({ items: [], total: 0 });
  });
});
