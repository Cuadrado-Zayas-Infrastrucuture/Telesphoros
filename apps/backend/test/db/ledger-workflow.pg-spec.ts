import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { LedgerIntegrityError } from '../../src/ledger/ledger-types';
import { LedgerVerifier } from '../../src/ledger/verifier';
import type { Projected } from '../../src/storage/ledger-records';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, heldResult, type SeededReport, seedLabReport, sha } from '../helpers/ledger-fixtures';

let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
let verifier: LedgerVerifier;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable', max: 20 });
  repo = new PostgresLedgerRecordsRepository(database);
  verifier = LedgerVerifier.connect(pg.verifierUrl);
});
afterAll(async () => {
  await verifier.close();
  await database.onModuleDestroy();
  await pg.drop();
});

const refused = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(LedgerIntegrityError);

/** A tenant with one accepted capture and one evaluation per call; `engineVersion` makes evaluations distinct. */
async function scene(tenantId = `tenant-${randomUUID()}`) {
  const report = await seedLabReport(pg.adminUrl, tenantId);
  const capture = captureFor(report);
  const c = await repo.insertCapture(tenantId, report.uploader, capture);
  const a = await repo.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture));
  const evaluate = (engineVersion: string) => repo.insertEvaluation(tenantId, 'syn-system', evaluationFor(report, c.record.id, a.record.id, { engineVersion }));
  const e1 = await evaluate('v1');
  return { tenantId, report, capture, c, a, evaluate, e1 };
}
const id = (r: { record: Projected }) => r.record.id;

describe('corrections: a chain with one child per node', () => {
  it('retract, then reinstate by a DIFFERENT person; the state follows', async () => {
    const s = await scene();
    expect(await repo.evaluationState(s.tenantId, id(s.e1))).toEqual({ state: 'active' });
    const retract = await repo.insertCorrection(s.tenantId, 'rev-1', { evaluationId: id(s.e1), kind: 'retraction', reasonCode: 'input-misread' });
    expect(await repo.evaluationState(s.tenantId, id(s.e1))).toEqual({ state: 'retracted' });
    await refused(repo.insertCorrection(s.tenantId, 'rev-1', { evaluationId: id(s.e1), kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: id(retract) }));
    const back = await repo.insertCorrection(s.tenantId, 'rev-2', { evaluationId: id(s.e1), kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: id(retract) });
    expect(await repo.evaluationState(s.tenantId, id(s.e1))).toEqual({ state: 'active' });
    // After a reinstatement the evaluation can be retracted again (a longer chain), but not reinstated twice.
    await refused(repo.insertCorrection(s.tenantId, 'rev-3', { evaluationId: id(s.e1), kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: id(back) }));
    const again = await repo.insertCorrection(s.tenantId, 'rev-3', { evaluationId: id(s.e1), kind: 'retraction', reasonCode: 'software-defect', previousCorrectionId: id(back) });
    expect(await repo.evaluationState(s.tenantId, id(s.e1))).toEqual({ state: 'retracted' });
    expect((await repo.listCorrections(s.tenantId, id(s.e1))).map((x) => x.id)).toEqual([id(retract), id(back), id(again)]);
  });

  it('supersession ends the chain, and its replacement must be an evaluation of the SAME report', async () => {
    const s = await scene();
    const e2 = await s.evaluate('v2');
    const other = await scene(s.tenantId); // same tenant, a different report
    await refused(repo.insertCorrection(s.tenantId, 'rev-1', { evaluationId: id(s.e1), kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId: id(other.e1) }));
    await refused(repo.insertCorrection(s.tenantId, 'rev-1', { evaluationId: id(s.e1), kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId: id(s.e1) }));
    const sup = await repo.insertCorrection(s.tenantId, 'rev-1', { evaluationId: id(s.e1), kind: 'supersession', reasonCode: 'software-defect', replacementEvaluationId: id(e2) });
    expect(await repo.evaluationState(s.tenantId, id(s.e1))).toEqual({ state: 'superseded', by: id(e2) });
    await refused(repo.insertCorrection(s.tenantId, 'rev-2', { evaluationId: id(s.e1), kind: 'retraction', reasonCode: 'input-misread', previousCorrectionId: id(sup) }));
    expect(await repo.evaluationState(s.tenantId, id(e2))).toEqual({ state: 'active' });
  });

  it('enforces the frozen vocabulary and the shape rules', async () => {
    const s = await scene();
    const base = { evaluationId: id(s.e1) };
    await refused(repo.insertCorrection(s.tenantId, 'rev-1', { ...base, kind: 'retraction', reasonCode: 'retraction-mistaken' })); // reason belongs to reinstatement
    await refused(repo.insertCorrection(s.tenantId, 'rev-1', { ...base, kind: 'supersession', reasonCode: 'wrong-patient', replacementEvaluationId: id(s.e1) })); // reason not allowed for supersession
    await refused(repo.insertCorrection(s.tenantId, 'rev-1', { ...base, kind: 'retraction', reasonCode: 'clinical-review-disagrees' })); // needs a note
    await refused(repo.insertCorrection(s.tenantId, 'rev-1', { ...base, kind: 'reinstatement', reasonCode: 'retraction-mistaken' })); // needs a previous correction
    await refused(repo.insertCorrection(s.tenantId, 'rev-1', { ...base, kind: 'retraction', reasonCode: 'input-misread', replacementEvaluationId: id(s.e1) }));
    await repo.insertCorrection(s.tenantId, 'rev-1', { ...base, kind: 'retraction', reasonCode: 'clinical-review-disagrees', note: 'the reviewer disagrees' }); // control: the right shape passes
  });

  it('a link must point at a correction ON THE SAME evaluation, and never across tenants', async () => {
    const s = await scene();
    const t = await scene();
    const mine = await repo.insertCorrection(s.tenantId, 'rev-1', { evaluationId: id(s.e1), kind: 'retraction', reasonCode: 'input-misread' });
    const theirs = await repo.insertCorrection(t.tenantId, 'rev-1', { evaluationId: id(t.e1), kind: 'retraction', reasonCode: 'input-misread' });
    await refused(repo.insertCorrection(s.tenantId, 'rev-2', { evaluationId: id(s.e1), kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: id(theirs) }));
    await refused(repo.insertCorrection(s.tenantId, 'rev-2', { evaluationId: id(t.e1), kind: 'retraction', reasonCode: 'input-misread' })); // another tenant's evaluation: not visible
    expect((await repo.listCorrections(t.tenantId, id(s.e1))).length).toBe(0);
    await repo.insertCorrection(s.tenantId, 'rev-2', { evaluationId: id(s.e1), kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: id(mine) }); // control
  });

  it('two reviewers acting at once cannot both extend the same node: exactly one wins', async () => {
    const s = await scene();
    const first = await repo.insertCorrection(s.tenantId, 'rev-1', { evaluationId: id(s.e1), kind: 'retraction', reasonCode: 'input-misread' });
    const attempts = await Promise.allSettled(
      ['rev-2', 'rev-3', 'rev-4', 'rev-5'].map((who) => repo.insertCorrection(s.tenantId, who, { evaluationId: id(s.e1), kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: id(first) })),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled').length).toBe(1);
    expect(attempts.filter((a) => a.status === 'rejected').every((a) => (a as PromiseRejectedResult).reason instanceof LedgerIntegrityError)).toBe(true);
    // And the same for the FIRST correction of an evaluation.
    const e2 = await s.evaluate('v2');
    const firsts = await Promise.allSettled(['a', 'b', 'c'].map((who) => repo.insertCorrection(s.tenantId, who, { evaluationId: id(e2), kind: 'retraction', reasonCode: 'input-misread' })));
    expect(firsts.filter((a) => a.status === 'fulfilled').length).toBe(1);
    expect(await verifier.verify(s.tenantId)).toMatchObject({ status: 'ok' });
  });

  it('a report with evaluations cannot be soft-deleted', async () => {
    const s = await scene();
    await withAdmin(pg.adminUrl, async (c) => {
      await expect(c.query(`UPDATE reports SET deleted_at = now() WHERE id = $1`, [s.report.reportId])).rejects.toMatchObject({ code: '23503' });
    });
  });
});

describe('disputes: raised by one person, decided by another, once', () => {
  const dispute = { guidelineId: 'syn-guideline', guidelineVersion: '1', guidelineContentSha256: 'b'.repeat(64), locator: { table: 'recommendations', row: 'poor', column: 'text' }, note: 'the cell is wrong' };

  it('lists open, upheld and dismissed disputes; the decider is never the raiser; one decision per dispute', async () => {
    const t = `tenant-${randomUUID()}`;
    const [d1, d2, d3] = [await repo.raiseDispute(t, 'rev-1', dispute), await repo.raiseDispute(t, 'rev-1', dispute), await repo.raiseDispute(t, 'rev-1', dispute)];
    await refused(repo.decideDispute(t, 'rev-1', { disputeId: id(d1), decision: 'upheld', evidenceNote: 'self-approval' }));
    await repo.decideDispute(t, 'rev-2', { disputeId: id(d1), decision: 'upheld', evidenceNote: 'confirmed against the source' });
    await refused(repo.decideDispute(t, 'rev-3', { disputeId: id(d1), decision: 'dismissed', evidenceNote: 'a second, conflicting decision' }));
    await repo.decideDispute(t, 'rev-2', { disputeId: id(d2), decision: 'dismissed', evidenceNote: 'the source agrees with the cell' });
    await refused(repo.decideDispute(t, 'rev-2', { disputeId: randomUUID(), decision: 'upheld', evidenceNote: 'no such dispute' }));
    const listed = await repo.listDisputes(t);
    expect(listed.map((x) => [x.dispute.id, x.status])).toEqual([[id(d1), 'upheld'], [id(d2), 'dismissed'], [id(d3), 'open']]);
    expect(listed[2]!.decision).toBeNull();
    expect(await verifier.verify(t)).toMatchObject({ status: 'ok' });
  });

  it('tenants never see each other\'s disputes, and cannot decide them', async () => {
    const [a, b] = [`tenant-${randomUUID()}`, `tenant-${randomUUID()}`];
    const d = await repo.raiseDispute(a, 'rev-1', dispute);
    expect(await repo.listDisputes(b)).toEqual([]);
    await refused(repo.decideDispute(b, 'rev-2', { disputeId: id(d), decision: 'upheld', evidenceNote: 'x' }));
  });
});

describe('captures and acceptances', () => {
  it('a capture must belong to an uploaded lab PDF and carry its hash', async () => {
    const t = `tenant-${randomUUID()}`;
    const r = await seedLabReport(pg.adminUrl, t);
    await refused(repo.insertCapture(t, r.uploader, captureFor(r, 'x', { pdfSha256: sha('some other file') })));
    await withAdmin(pg.adminUrl, (c) => c.query(`UPDATE reports SET type = 'vcf' WHERE id = $1`, [r.reportId]));
    await refused(repo.insertCapture(t, r.uploader, captureFor(r)));
    const [other] = [`tenant-${randomUUID()}`];
    await refused(repo.insertCapture(other, r.uploader, captureFor(r))); // another tenant's report
  });

  it('an acceptance repeats its capture\'s hash and version exactly; a rejection by the uploader is allowed, an acceptance is not', async () => {
    const t = `tenant-${randomUUID()}`;
    const r = await seedLabReport(pg.adminUrl, t);
    const capture = captureFor(r);
    const c = await repo.insertCapture(t, r.uploader, capture);
    await refused(repo.insertAcceptance(t, 'rev-1', acceptanceFor(id(c), capture, { textSha256: sha('another text') })));
    await refused(repo.insertAcceptance(t, 'rev-1', acceptanceFor(id(c), capture, { popplerVersion: '24.02.0' })));
    await refused(repo.insertAcceptance(t, r.uploader, acceptanceFor(id(c), capture)));
    const rejection = await repo.insertAcceptance(t, r.uploader, acceptanceFor(id(c), capture, { decision: 'rejected', note: 'wrong file' }));
    expect(rejection.created).toBe(true);
    expect((await repo.latestAcceptance(t, id(c)))?.id).toBe(id(rejection));
    expect(await repo.latestAcceptance(`tenant-${randomUUID()}`, id(c))).toBeUndefined();
  });
});

describe('evaluations: idempotence, immutability of inputs, and fidelity of what is stored', () => {
  it('concurrent identical requests produce one evaluation and one event', async () => {
    const s = await scene();
    const results = await Promise.all(Array.from({ length: 6 }, () => s.evaluate('same')));
    expect(new Set(results.map(id)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);
    const events = await withAdmin(pg.adminUrl, async (c) => Number((await c.query(`SELECT count(*) FROM ledger_events WHERE tenant_id = $1 AND event_type = 'evaluation'`, [s.tenantId])).rows[0].count));
    expect(events).toBe(2); // v1 from scene() and 'same'
  });

  it('key order inside the stored JSON does not make a different evaluation, and does not change what is hashed', async () => {
    const s = await scene();
    const a = await repo.insertEvaluation(s.tenantId, 'syn-system', evaluationFor(s.report, id(s.c), id(s.a), { engineVersion: 'order', binding: { zeta: 1, alpha: 2, mid: { y: 1, x: 2 } } }));
    const b = await repo.insertEvaluation(s.tenantId, 'syn-system', evaluationFor(s.report, id(s.c), id(s.a), { engineVersion: 'order', binding: { mid: { x: 2, y: 1 }, alpha: 2, zeta: 1 } }));
    expect([b.created, id(b)]).toEqual([false, id(a)]);
    expect(await verifier.verify(s.tenantId)).toMatchObject({ status: 'ok' });
  });

  it('round-trips awkward values exactly: microsecond timestamps, numeric scale, unicode and astral characters, stored order', async () => {
    const s = await scene();
    const r = await repo.insertEvaluation(s.tenantId, 'syn-system', evaluationFor(s.report, id(s.c), id(s.a), {
      engineVersion: 'fidelity',
      geneInputs: [{ gene: 'CYP2C19', state: 'diplotype', diplotype: '*2/*2' }],
      occurrences: [{ text: 'naïve — 日本語 😀 \u{1F9EC}', n: 0 }],
      results: [{ outcome: 'held', drug: 'drug-ß', genes: ['CYP2D6'], geneStates: heldResult.geneStates, reasonCode: 'gene-absent', citation: null }],
      geneStates: [
        { gene: 'CYP2D6', state: 'canonical', phenotype: 'Intermediate Metabolizer', diplotype: '*1/*4', activityScore: 1.5, reasonCode: null },
        { gene: 'CYP2C19', state: 'absent', phenotype: null, diplotype: null, activityScore: null, reasonCode: 'gene-absent' },
      ],
    }));
    const stored = r.record as unknown as { occurrences: Array<{ text: string }>; geneStates: Array<{ gene: string; activityScore: string | null }>; createdAt: string };
    expect(stored.occurrences[0].text).toBe('naïve — 日本語 😀 \u{1F9EC}');
    expect(stored.geneStates.map((g) => [g.gene, g.activityScore])).toEqual([['CYP2C19', null], ['CYP2D6', '1.50']]); // sorted by gene; numeric(6,2) keeps its scale
    expect(stored.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const dbValue = await withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t FROM evaluations WHERE id = $1`, [id(r)])).rows[0].t);
    expect(stored.createdAt).toBe(dbValue);
    expect(await verifier.verify(s.tenantId)).toMatchObject({ status: 'ok' });
  });

  it('a note is stored once as text and committed to by its UTF-8 digest only', async () => {
    const t = `tenant-${randomUUID()}`;
    const d = await repo.raiseDispute(t, 'rev-1', { guidelineId: 'g', guidelineVersion: '1', guidelineContentSha256: 'c'.repeat(64), locator: { table: 't', row: 'r' }, note: 'naïve 😀 note' });
    const digest = createHash('sha256').update('naïve 😀 note', 'utf8').digest('hex');
    expect((d.record.note as { bodySha256: string }).bodySha256).toBe(digest);
    expect(JSON.stringify(d.record)).not.toContain('naïve');
    await refused(repo.raiseDispute(t, 'rev-1', { guidelineId: 'g', guidelineVersion: '1', guidelineContentSha256: 'c'.repeat(64), locator: { table: 't', row: 'r' }, note: '' })); // empty note
    await refused(repo.raiseDispute(t, 'rev-1', { guidelineId: 'g', guidelineVersion: '1', guidelineContentSha256: 'c'.repeat(64), locator: { table: 't', row: 'r' }, note: 'x'.repeat(1001) }));
  });
});

describe('concurrency on one tenant\'s chain', () => {
  const batch = async (tenantId: string, reports: SeededReport[]) => {
    const started = process.hrtime.bigint();
    const timings: number[] = [];
    await Promise.all(reports.map(async (r) => {
      const t0 = process.hrtime.bigint();
      await repo.insertCapture(tenantId, r.uploader, captureFor(r));
      timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }));
    timings.sort((x, y) => x - y);
    return { wallMs: Number(process.hrtime.bigint() - started) / 1e6, p50: timings[Math.floor(timings.length / 2)]!, p95: timings[Math.floor(timings.length * 0.95)]! };
  };

  it.each([1, 4, 16])('%i concurrent writers: every write succeeds, the sequence has no gap, the chain verifies', async (writers) => {
    const tenantId = `tenant-${randomUUID()}`;
    const reports = await Promise.all(Array.from({ length: writers }, (_, i) => seedLabReport(pg.adminUrl, tenantId, 'syn-uploader', `SYN-${i}`)));
    const timing = await batch(tenantId, reports);
    const seqs = await withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT seq::int AS seq FROM ledger_events WHERE tenant_id = $1 ORDER BY seq`, [tenantId])).rows.map((r) => r.seq));
    expect(seqs).toEqual(Array.from({ length: writers }, (_, i) => i + 1));
    const verdict = await verifier.verify(tenantId);
    expect({ status: verdict.status, n: verdict.eventsChecked, failures: verdict.failures }).toEqual({ status: 'ok', n: writers, failures: [] });
    // Measured, not asserted against a number (a loaded CI machine is slower); printed so a regression is visible in the log.
    process.stdout.write(`[ledger contention] writers=${writers} wall=${timing.wallMs.toFixed(0)}ms p50=${timing.p50.toFixed(0)}ms p95=${timing.p95.toFixed(0)}ms\n`);
  }, 30_000);

  it('one tenant\'s open transaction does not delay another tenant, and a stuck head lock gives up after the lock timeout', async () => {
    const [a, b] = [`tenant-${randomUUID()}`, `tenant-${randomUUID()}`];
    const [ra, rb, ra2] = [await seedLabReport(pg.adminUrl, a), await seedLabReport(pg.adminUrl, b), await seedLabReport(pg.adminUrl, a, 'syn-uploader', 'SYN-2')];
    const holder = await database['pool'].connect(); // a transaction that has appended and not yet committed: it holds tenant A's head lock
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor', $2, true)`, [a, ra.uploader]);
      const [cid, ev] = [randomUUID(), randomUUID()];
      await holder.query(
        `INSERT INTO report_captures (id, tenant_id, created_by, ledger_event_id, report_id, pdf_sha256, text_storage_key, text_sha256, text_scalars, poppler_version, runner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5, '26.03.0', 'fake')`, [cid, a, ra.uploader, ev, ra.reportId, ra.pdfSha256, `text/${randomUUID()}`, sha('held')]);
      await holder.query(`SELECT ledger_append($1, 'capture', 'report_captures', $2, $3, 1::smallint)`, [ev, cid, sha('placeholder')]);

      const t0 = Date.now();
      await repo.insertCapture(b, rb.uploader, captureFor(rb)); // tenant B is not blocked
      expect(Date.now() - t0).toBeLessThan(2000);

      const t1 = Date.now();
      await expect(repo.insertCapture(a, ra2.uploader, captureFor(ra2))).rejects.toMatchObject({ code: '55P03' }); // lock_not_available
      const waited = Date.now() - t1;
      expect(waited).toBeGreaterThan(2500);
      expect(waited).toBeLessThan(6000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined); // intentional: the holder may already be gone
      holder.release();
    }
    await repo.insertCapture(a, ra2.uploader, captureFor(ra2)); // the lock is free again
    expect(await verifier.verify(a)).toMatchObject({ status: 'ok', eventsChecked: 1 });
  }, 20_000);
});
