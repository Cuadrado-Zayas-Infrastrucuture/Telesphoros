import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import type { DisputeInput } from '../../src/storage/ledger-records';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/database';
import { acceptanceFor, captureFor, citation, evaluationFor, seedLabReport, sha, shownResult } from '../helpers/ledger-fixtures';

let pg: EphemeralDatabase;
let db: Database;
let admin: Database;
let repo: PostgresLedgerRecordsRepository;
let bypass: PostgresLedgerRecordsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase(); db = new Database({ url: pg.appUrl, ssl: 'disable' }); admin = new Database({ url: pg.adminUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(db); bypass = new PostgresLedgerRecordsRepository(admin);
});
afterAll(async () => { await db.onModuleDestroy(); await admin.onModuleDestroy(); await pg.drop(); });
const cell: DisputeInput = { guidelineId: citation.guidelineId, guidelineVersion: citation.guidelineVersion, guidelineContentSha256: sha('file'), locator: { table: citation.locator.table, row: citation.locator.row }, note: '' };

it('bounds and orders candidates, includes corrected history, and explicitly scopes both query tables even with RLS bypassed', async () => {
  const t = `syn-${randomUUID()}`;
  const seed = await seedLabReport(pg.adminUrl, t);
  const cap = captureFor(seed); const c = await repo.insertCapture(t, seed.uploader, cap);
  const a = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, cap));
  const first = (await repo.insertEvaluation(t, 'syn-system', evaluationFor(seed, c.record.id, a.record.id))).record;
  const second = (await repo.insertEvaluation(t, 'syn-system', evaluationFor(seed, c.record.id, a.record.id, { knowledgeSetId: sha('next') }))).record;
  await repo.insertCorrection(t, 'syn-reviewer', { evaluationId: first.id, kind: 'retraction', reasonCode: 'knowledge-error-found' });
  expect((await repo.cellEvaluationCandidates(t, cell, '0', 1)).map((x) => x.id)).toEqual([first.id]);
  expect((await repo.cellEvaluationCandidates(t, cell, first.seq, 10)).map((x) => x.id)).toEqual([second.id]);
  expect((await bypass.cellEvaluationCandidates(t, cell, '0', 10)).map((x) => x.id)).toEqual([first.id, second.id]);
  expect(await bypass.cellEvaluationCandidates('syn-foreign', cell, '0', 10)).toEqual([]);
  for (const change of [{ guidelineId: 'wrong' }, { guidelineVersion: 'wrong' }, { locator: { table: 'wrong', row: cell.locator.row } }, { locator: { table: cell.locator.table, row: 'wrong' } }, { locator: { ...cell.locator, column: 'wrong' } }]) {
    expect(await repo.cellEvaluationCandidates(t, { ...cell, ...change }, '0', 10)).toEqual([]);
  }
  // A held result without a citation is not a usage candidate; same report and knowledge are insufficient.
  if (shownResult.outcome !== 'shown') throw new Error('Fixture must be shown');
  await repo.insertEvaluation(t, 'syn-system', evaluationFor(seed, c.record.id, a.record.id, { knowledgeSetId: sha('no-citation'), results: [{ ...shownResult, citation: { ...citation, guidelineId: 'other' } }] }));
  expect((await repo.cellEvaluationCandidates(t, cell, '0', 10)).map((x) => x.id)).toEqual([first.id, second.id]);
});
