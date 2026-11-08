import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Client } from 'pg';
import type { GeneInput } from '@telesphoros/cpic-schema';
import { Database } from '../../src/db/database';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { loadKnowledge } from '../../src/services/knowledge/knowledge-loader';
import { evaluate } from '../../src/services/recommendation-engine/recommendation-engine';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { SYNTHETIC_DIR } from '../helpers/knowledge';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';

// Spec 033 K2-7 and K2-8: the identifiers of the cell a result came from are stored on the result row and are inside the ledger hash when present.
// Expected values are written by hand from data/fixtures/knowledge/synthetic-identifiers, never read back from the engine or the repository.
const IDENTIFIERS_DIR = join(SYNTHETIC_DIR, '../synthetic-identifiers');
/** The keys every result projection had before migration 0071. A result without identifiers must hash over exactly these. */
const PRE_0071_RESULT_KEYS = [
  'citation',
  'drug',
  'geneEvidence',
  'genes',
  'guidelineId',
  'guidelineVersion',
  'id',
  'implication',
  'ordinal',
  'outcome',
  'reasonCode',
  'recommendationText',
  'strength',
];

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

/** Stores an evaluation of GENEA and GENEB against the schema 1.3 fixtures through the repository, as the pipeline does. */
async function storeIdentified(t: string, a: string, b: string) {
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
      results: result.results,
      geneStates: result.geneStates,
    }),
  );
}

const storedIdentifiers = (t: string, evaluationId: string) =>
  withAdmin(
    pg.adminUrl,
    async (c: Client) =>
      (
        await c.query(
          `SELECT drug, outcome, drug_rxcui, gene_hgnc_ids, pharmvar_versions, cell_origin FROM evaluation_results WHERE tenant_id = $1 AND evaluation_id = $2 ORDER BY ordinal`,
          [t, evaluationId],
        )
      ).rows,
  );

describe('evaluation results: standard identifiers (spec 033)', () => {
  it('stores the identifiers of each cell from schema 1.3 knowledge, and the ledger walks clean', async () => {
    const t = tenant();
    const e = await storeIdentified(t, 'Synthetic Normal', 'Synthetic Low');
    expect(await storedIdentifiers(t, e.record.id)).toEqual([
      { drug: 'drugq', outcome: 'shown', drug_rxcui: 'syn-rxcui-drugq', gene_hgnc_ids: ['syn-hgnc-genea'], pharmvar_versions: ['syn-pharmvar-1.0'], cell_origin: 'cpic' },
      {
        drug: 'drugz',
        outcome: 'shown',
        drug_rxcui: 'syn-rxcui-drugz',
        gene_hgnc_ids: ['syn-hgnc-genea', 'syn-hgnc-geneb'],
        pharmvar_versions: ['syn-pharmvar-1.0', 'syn-pharmvar-1.0'],
        cell_origin: 'cpic',
      },
    ]);
    expect(await verifier.verify(t, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
  });

  it('stores identifiers for a held cell, and none where no cell applies', async () => {
    const t = tenant();
    // GENEA intermediate + GENEB low is an unverified drugz cell (origin "unknown"); GENEA intermediate alone is a verified drugq cell.
    const held = await storeIdentified(t, 'Synthetic Intermediate', 'Synthetic Low');
    expect(await storedIdentifiers(t, held.record.id)).toEqual([
      { drug: 'drugq', outcome: 'shown', drug_rxcui: 'syn-rxcui-drugq', gene_hgnc_ids: ['syn-hgnc-genea'], pharmvar_versions: ['syn-pharmvar-1.0'], cell_origin: 'pharmgkb' },
      {
        drug: 'drugz',
        outcome: 'held',
        drug_rxcui: 'syn-rxcui-drugz',
        gene_hgnc_ids: ['syn-hgnc-genea', 'syn-hgnc-geneb'],
        pharmvar_versions: ['syn-pharmvar-1.0', 'syn-pharmvar-1.0'],
        cell_origin: 'unknown',
      },
    ]);
    // GENEA intermediate + GENEB high has no drugz cell at all: held as a knowledge gap (audit DATA-01), with nothing to identify
    const none = await storeIdentified(t, 'Synthetic Intermediate', 'Synthetic High');
    expect((await storedIdentifiers(t, none.record.id))[1]).toEqual({
      drug: 'drugz',
      outcome: 'held',
      drug_rxcui: null,
      gene_hgnc_ids: null,
      pharmvar_versions: null,
      cell_origin: null,
    });
    expect(await verifier.verify(t, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
  });

  it('puts the identifiers inside the hashed projection, so changing one breaks the ledger walk', async () => {
    const t = tenant();
    const e = await storeIdentified(t, 'Synthetic Normal', 'Synthetic Low');
    const results = e.record.results as Record<string, unknown>[];
    expect(results[0]).toMatchObject({ drugRxcui: 'syn-rxcui-drugq', geneHgncIds: ['syn-hgnc-genea'], pharmvarVersions: ['syn-pharmvar-1.0'], cellOrigin: 'cpic' });
    // Rewrite the stored origin behind the append-only trigger, as only the cluster superuser could.
    await withAdmin(pg.adminUrl, async (c: Client) => {
      await c.query('SET session_replication_role = replica');
      await c.query(`UPDATE evaluation_results SET cell_origin = 'pharmvar' WHERE tenant_id = $1 AND evaluation_id = $2 AND drug = 'drugq'`, [t, e.record.id]);
    });
    const after = await verifier.verify(t, { mode: 'full' });
    expect(after.status).not.toBe('ok');
    expect(after.failures.length).toBeGreaterThan(0);
  });

  it('leaves a result without identifiers hashed over exactly the keys it had before migration 0071', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const capture = captureFor(report);
    const c = await repo.insertCapture(t, report.uploader, capture);
    const acc = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
    const e = await repo.insertEvaluation(t, 'syn-system', evaluationFor(report, c.record.id, acc.record.id));
    for (const result of e.record.results as Record<string, unknown>[]) expect(Object.keys(result).sort()).toEqual(PRE_0071_RESULT_KEYS);
    expect(await verifier.verify(t, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
  });
});

describe('evaluation results: the identifier constraints (spec 033 K2-7)', () => {
  // Inserted as the owner with triggers and foreign keys off, so only the table's own checks decide.
  const insert = (columns: Record<string, unknown>) =>
    withAdmin(pg.adminUrl, async (c: Client) => {
      await c.query('SET session_replication_role = replica');
      const row = {
        tenant_id: 'syn-constraints',
        evaluation_id: randomUUID(),
        ordinal: 0,
        drug: 'drugq',
        genes: ['GENEA'],
        outcome: 'held',
        reason_code: 'out-of-review-scope',
        citation: '{}',
        guideline_id: 'drugq-genea',
        guideline_version: 'synthetic-1',
        gene_evidence: '[]',
        drug_rxcui: 'syn-rxcui-drugq',
        gene_hgnc_ids: ['syn-hgnc-genea'],
        pharmvar_versions: ['syn-pharmvar-1.0'],
        cell_origin: 'cpic',
        ...columns,
      };
      const keys = Object.keys(row);
      await c.query(`INSERT INTO evaluation_results (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
    });

  it('accepts a complete row in the real or the invented form, and a gene reported as a phenotype only', async () => {
    await expect(insert({})).resolves.toBeUndefined();
    // Real-form values beyond any range the registries have assigned.
    await expect(insert({ drug_rxcui: '999999999999', gene_hgnc_ids: ['HGNC:9999999'], pharmvar_versions: ['999.0.0'] })).resolves.toBeUndefined();
    await expect(insert({ pharmvar_versions: [null] })).resolves.toBeUndefined();
  });

  it.each([
    ['only some identifiers', { cell_origin: null }, 'evaluation_results_identifiers_all_or_none'],
    ['identifiers without a citation', { citation: null, guideline_id: null, guideline_version: null }, 'evaluation_results_identifiers_need_citation'],
    ['a malformed RxCUI', { drug_rxcui: 'RxNorm:2670' }, 'evaluation_results_drug_rxcui'],
    ['an HGNC id per gene missing', { genes: ['GENEA', 'GENEB'], pharmvar_versions: [null, null] }, 'evaluation_results_gene_hgnc_ids'],
    ['a malformed HGNC id', { gene_hgnc_ids: ['hgnc:12'] }, 'evaluation_results_gene_hgnc_ids'],
    ['a NULL HGNC id', { gene_hgnc_ids: [null] }, 'evaluation_results_gene_hgnc_ids'],
    ['a PharmVar release per gene missing', { pharmvar_versions: [] }, 'evaluation_results_pharmvar_versions'],
    ['a malformed PharmVar release', { pharmvar_versions: ['v6'] }, 'evaluation_results_pharmvar_versions'],
    ['an origin outside the list', { cell_origin: 'clinpgx' }, 'evaluation_results_cell_origin'],
  ])('refuses %s', async (_name, columns, constraint) => {
    await expect(insert(columns)).rejects.toMatchObject({ constraint });
  });
});
