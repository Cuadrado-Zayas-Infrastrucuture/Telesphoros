import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Client } from 'pg';
import type { DrugResult, GeneInput } from '@telesphoros/cpic-schema';
import { Database } from '../../src/db/database';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { loadKnowledge } from '../../src/services/knowledge/knowledge-loader';
import { evaluate } from '../../src/services/recommendation-engine/recommendation-engine';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { SYNTHETIC_DIR } from '../helpers/knowledge';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';
import { revertThrough } from '../helpers/migration-history';

// Audit DATA-01, migration 0074: a combination with no cell is stored as `held` / `knowledge-gap`, and a result stored before the change under
// `no-published-recommendation` with no citation stays valid. In data/fixtures/knowledge/synthetic-identifiers, drugz has no cell for GENEA
// "Synthetic Intermediate" + GENEB "Synthetic High".
jest.setTimeout(120_000);
const IDENTIFIERS_DIR = join(SYNTHETIC_DIR, '../synthetic-identifiers');

let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
let verifier: LedgerVerifier;
const tenant = () => `tenant-${randomUUID()}`;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
  verifier = LedgerVerifier.connect(pg.verifierUrl);
});
afterAll(async () => {
  await verifier.close();
  await database.onModuleDestroy();
  await pg.drop();
});

const canonical = (gene: string, phenotype: string): GeneInput => ({ gene, state: 'canonical', phenotype, callSource: 'lab-report' });

/** Stores an evaluation through the repository, as the pipeline does; `edit` may replace the engine's results before they are stored. */
async function store(t: string, a: string, b: string, edit: (results: DrugResult[]) => DrugResult[] = (results) => results) {
  const report = await seedLabReport(pg.adminUrl, t);
  const capture = captureFor(report);
  const c = await repo.insertCapture(t, report.uploader, capture);
  const acc = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
  const knowledge = await loadKnowledge({ directory: IDENTIFIERS_DIR, mode: 'non-production' });
  const geneInputs = [canonical('GENEA', a), canonical('GENEB', b)];
  const result = evaluate(knowledge, geneInputs);
  return repo.insertEvaluation(
    t,
    'syn-system',
    evaluationFor(report, c.record.id, acc.record.id, {
      knowledgeSetId: result.knowledgeSetId,
      geneInputs,
      occurrences: [
        { gene: 'GENEA', offset: 10 },
        { gene: 'GENEB', offset: 40 },
      ],
      results: edit(result.results),
      geneStates: result.geneStates,
    }),
  );
}

const storedDrugz = (t: string, evaluationId: string) =>
  withAdmin(
    pg.adminUrl,
    async (c: Client) =>
      (
        await c.query(
          `SELECT outcome, reason_code, citation, strength, recommendation_text FROM evaluation_results WHERE tenant_id = $1 AND evaluation_id = $2 AND drug = 'drugz'`,
          [t, evaluationId],
        )
      ).rows,
  );

it('stores a combination with no cell as held / knowledge-gap, with no citation or wording, and the ledger walks clean', async () => {
  const t = tenant();
  const e = await store(t, 'Synthetic Intermediate', 'Synthetic High');
  expect(await storedDrugz(t, e.record.id)).toEqual([{ outcome: 'held', reason_code: 'knowledge-gap', citation: null, strength: null, recommendation_text: null }]);
  expect(await verifier.verify(t, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
});

it('still accepts a result stored before the change: no-published-recommendation with no citation', async () => {
  const t = tenant();
  const historical = (results: DrugResult[]) =>
    results.map((r): DrugResult =>
      r.drug === 'drugz'
        ? {
            outcome: 'no-published-recommendation',
            drug: r.drug,
            genes: r.genes,
            geneStates: r.geneStates,
            reasonCode: 'no-published-recommendation',
            citation: null,
            strength: null,
            recommendationText: null,
            implication: null,
          }
        : r,
    );
  const e = await store(t, 'Synthetic Intermediate', 'Synthetic High', historical);
  expect(await storedDrugz(t, e.record.id)).toEqual([
    { outcome: 'no-published-recommendation', reason_code: 'no-published-recommendation', citation: null, strength: null, recommendation_text: null },
  ]);
});

it('refuses held / knowledge-gap with wording: the held shape stays wording-free', async () => {
  const t = tenant();
  const worded = (results: DrugResult[]) => results.map((r) => (r.drug === 'drugz' ? ({ ...r, strength: 'Strong', recommendationText: 'Invented.' } as unknown as DrugResult) : r));
  await expect(store(t, 'Synthetic Intermediate', 'Synthetic High', worded)).rejects.toThrow();
});

it('reverting 0074 is refused while a knowledge-gap result exists, and goes through and back up once none does', async () => {
  const { steps, reverted } = revertThrough('knowledge_gap_reason'); // 0074 and every migration above it, newest first
  const t = tenant();
  await store(t, 'Synthetic Intermediate', 'Synthetic High');
  // The migrations above 0074 go first, so the refusal below is 0074's own guard and not a later migration's down.
  if (steps > 1) expect(await withAdmin(pg.adminUrl, (c) => migrateDown(c, steps - 1))).toEqual(reverted.slice(0, -1));
  await expect(withAdmin(pg.adminUrl, (c) => migrateDown(c, 1))).rejects.toThrow(/Refusing to revert: stored results carry knowledge-gap/);
  await withAdmin(pg.adminUrl, async (c) => {
    // The test administrator removes the synthetic rows to exercise the empty path; nothing else may delete evaluation results.
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query("DELETE FROM evaluation_results WHERE reason_code = 'knowledge-gap'");
    await c.query('COMMIT');
    expect(await migrateDown(c, 1)).toEqual(['0074']);
    expect(await migrateUp(c)).toEqual([...reverted].reverse());
  });
});
