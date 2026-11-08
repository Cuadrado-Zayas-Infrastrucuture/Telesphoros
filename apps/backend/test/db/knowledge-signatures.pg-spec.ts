import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { GeneInput } from '@telesphoros/cpic-schema';
import { Database } from '../../src/db/database';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { loadKnowledge } from '../../src/services/knowledge/knowledge-loader';
import { evaluate } from '../../src/services/recommendation-engine/recommendation-engine';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { cleanupTempDirs, reviewedCopyOf, SYNTHETIC_DIR, TEST_SIGNER_KEYS } from '../helpers/knowledge';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';

// Audit CLIN-01: the signers of a cited knowledge file are stored with the result, inside the hashed projection, so the evaluation record says who signed
// the cell it used. Knowledge is the synthetic fixtures turned into a signed real-looking copy (test keys only).
jest.setTimeout(120_000);

let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
let verifier: LedgerVerifier;

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
  await cleanupTempDirs();
});

it('stores the signers in the citation of a result from a signed file, and the ledger walks clean', async () => {
  const t = `tenant-${randomUUID()}`;
  const knowledge = await loadKnowledge({ directory: await reviewedCopyOf(SYNTHETIC_DIR), mode: 'production', signerKeys: TEST_SIGNER_KEYS });
  const geneInputs: GeneInput[] = [{ gene: 'GENEA', state: 'canonical', phenotype: 'Synthetic Normal', callSource: 'lab-report' }];
  const result = evaluate(knowledge, geneInputs, { drugs: ['drugx'] });
  const report = await seedLabReport(pg.adminUrl, t);
  const capture = captureFor(report);
  const c = await repo.insertCapture(t, report.uploader, capture);
  const acc = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
  const e = await repo.insertEvaluation(
    t,
    'syn-system',
    evaluationFor(report, c.record.id, acc.record.id, {
      knowledgeSetId: result.knowledgeSetId,
      geneInputs,
      occurrences: [{ gene: 'GENEA', offset: 10 }],
      results: result.results,
      geneStates: result.geneStates,
    }),
  );
  const stored = await withAdmin(
    pg.adminUrl,
    async (client: Client) =>
      (await client.query(`SELECT citation->'signedBy' AS signed_by FROM evaluation_results WHERE tenant_id = $1 AND evaluation_id = $2 AND outcome = 'shown'`, [t, e.record.id]))
        .rows,
  );
  expect(stored).toEqual([{ signed_by: ['test-signer-a', 'test-signer-b'] }]);
  expect(await verifier.verify(t, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
  // Rewrite the stored signers behind the append-only trigger, as only the cluster superuser could: the walk must notice.
  await withAdmin(pg.adminUrl, async (client: Client) => {
    await client.query('SET session_replication_role = replica');
    await client.query(
      `UPDATE evaluation_results SET citation = jsonb_set(citation, '{signedBy}', '["test-signer-a","someone-else"]') WHERE tenant_id = $1 AND evaluation_id = $2 AND outcome = 'shown'`,
      [t, e.record.id],
    );
  });
  const after = await verifier.verify(t, { mode: 'full' });
  expect(after.status).not.toBe('ok');
  expect(after.failures.length).toBeGreaterThan(0);
});
