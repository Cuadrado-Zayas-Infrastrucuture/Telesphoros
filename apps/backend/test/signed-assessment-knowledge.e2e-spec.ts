import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { evaluationDtoSchema } from '@telesphoros/shared-types';
import { LedgerVerifier } from '../src/ledger/verifier';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { cleanupTempDirs, reviewedCopyOf, signerKeysJson } from './helpers/knowledge';
import { LabPipeline } from './helpers/lab-pipeline';
import { type Prepared, structuredFixtures } from './helpers/structured-fixtures';
import { bearer } from './helpers/tokens';

// Spec 044 K2a. With ASSESSMENT_KNOWLEDGE=signed the synthetic assessment reads a signed set under the production rules (here a signed copy of the synthetic
// structured set, signed by this run's test keys only), and a phenotype-only gene map takes the laboratory's phenotype as the input, exactly as the map
// names it. The patients, laboratories and reports stay synthetic. Every expected value is written by hand from the fixtures.
const SYNTHETIC_STRUCTURED = resolve(__dirname, '../../../data/fixtures/knowledge/synthetic-structured');
const ACCEPT_A = { 'syn-finding-a': 'accepted-as-evidence' } as const;
const labPhenotype = (phenotype: string) => (pkg: { report: { findings: Record<string, unknown>[] } }) => {
  pkg.report.findings[0]!.laboratoryInterpretation = { phenotype, activityScore: null, translationVersion: 'synthetic-lab-translation-1' };
};

(usingPostgres() && usingS3() ? describe : describe.skip)('the synthetic assessment with signed knowledge (real PostgreSQL/S3)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let prepare: ReturnType<typeof structuredFixtures>['prepare'];
  let verifier: LedgerVerifier;

  beforeAll(async () => {
    // GENEA's map is made phenotype-only in the signed copy: no alleles, no method, so no PharmVar release either.
    const signed = await reviewedCopyOf(SYNTHETIC_STRUCTURED, (file) => {
      if (file.kind !== 'gene-phenotype-map' || file.gene !== 'GENEA') return;
      delete file.alleles;
      delete file.method;
      delete file.pharmvarVersion;
    });
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl, syntheticAssessment: true, signedKnowledge: { dir: signed, signerKeys: signerKeysJson() } });
    lab = new LabPipeline(app, db.adminUrl);
    prepare = structuredFixtures(lab).prepare;
    verifier = LedgerVerifier.connect(db.verifierUrl);
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
    await cleanupTempDirs();
  });

  const assess = (s: Prepared) => lab.api().post(`/api/v1/reports/${s.reportId}/structured-assessment`).set(bearer(s.uploader.token));

  it('assesses on the laboratory phenotype through the phenotype-only map, names the signed scope, and records the lab phenotype in the binding', async () => {
    const s = await prepare({ a: '*1/*1' }, { reviews: ACCEPT_A, mutate: labPhenotype('Synthetic Normal') });
    const dto = evaluationDtoSchema.parse((await assess(s).expect(201)).body);
    expect(dto).toMatchObject({ disposition: 'evaluated', holdCode: null, scope: 'synthetic-patient-signed-knowledge', clinicalUse: 'not-approved' });
    // "Synthetic Normal" is a GENEA term; drugq-genea reads "Q normal." for it.
    const drugq = dto.results.find((r) => r.drug === 'drugq');
    expect(drugq).toMatchObject({ outcome: 'shown', recommendationText: 'Q normal.' });
    expect(dto.geneStates.find((g) => g.gene === 'GENEA')).toMatchObject({ phenotype: 'Synthetic Normal' });
    const where = "id = $1 AND binding -> 'labPhenotypes' -> 0 ->> 'translationVersion' = 'synthetic-lab-translation-1'";
    expect(await lab.count('evaluations', where, [dto.id])).toBe(1);
    expect(await verifier.verify(lab.tenant, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
  });

  it('holds when the laboratory phenotype is not exactly one of the map terms, and stores no result', async () => {
    const s = await prepare({ a: '*1/*1' }, { reviews: ACCEPT_A, mutate: labPhenotype('synthetic normal') });
    const dto = evaluationDtoSchema.parse((await assess(s).expect(201)).body);
    expect(dto).toMatchObject({ disposition: 'held', holdCode: 'unsupported-source', results: [], scope: 'synthetic-patient-signed-knowledge' });
  });
});
