import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { evaluationDtoSchema, genomicProfileDtoSchema } from '@telesphoros/shared-types';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types/drug-list-data';
import request from 'supertest';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { cleanupTempDirs, MODIFIER_TEST_IDS, signedModifierCopy, signerKeysJson } from './helpers/knowledge';
import { LabPipeline, type Person } from './helpers/lab-pipeline';
import { structuredFixtures } from './helpers/structured-fixtures';
import { bearer, signToken } from './helpers/tokens';

// Spec 044 slice A: GET /patients/:id/genomic-profile. Synthetic data only. The rules the profile applies are proved by hand-written cases in
// src/genomic-profile/genomic-profile.builder.spec.ts; these specs prove the route: its gate, roles and tenancy, and that over the real stores
// it reads a stored assessment and a recorded medication and writes nothing.

const REVIEWS = { 'syn-finding-a': 'accepted-as-evidence', 'syn-finding-b': 'accepted-as-evidence' } as const;
const medicationBody = () => ({
  requestId: randomUUID(),
  rxcui: '5470',
  listVersion: BUNDLED_DRUG_LIST!.version,
  status: 'active',
  source: 'clinician-entered',
  startMonth: '2026-01',
  stopMonth: null,
});

describe('the genomic profile with both evaluation switches off (the default)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).get(path);
    return token ? call.set(bearer(token)) : call;
  };
  const tokenWith = (roles: string[]) => signToken({ sub: 'someone', roles, tenant: 'tenant-genomic-gate' });
  const PATH = `/api/v1/patients/${randomUUID()}/genomic-profile`;

  it('answers 503 PIPELINE_DISABLED to a clinical reader, as the evaluation reads do', async () => {
    const res = await get(PATH, await tokenWith(['reader']));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PIPELINE_DISABLED');
  });
  it('answers 401 without a token and 403 to an administrator alone, never 503', async () => {
    expect((await get(PATH)).status).toBe(401);
    const res = await get(PATH, await tokenWith(['admin']));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
  it('answers 503 before it looks at the request: a malformed id is still 503, not 400', async () => {
    expect((await get('/api/v1/patients/not-a-uuid/genomic-profile?rxcui=syn-rxcui-x', await tokenWith(['clinician']))).status).toBe(503);
  });
});

(usingPostgres() && usingS3() ? describe : describe.skip)('the genomic profile over HTTP (real PostgreSQL/S3, the synthetic assessment on)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let prepare: ReturnType<typeof structuredFixtures>['prepare'];

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl, syntheticAssessment: true, medicationWrites: 'enabled' });
    lab = new LabPipeline(app, db.adminUrl);
    prepare = structuredFixtures(lab).prepare;
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const profile = (patientId: string, who: Person, query = '') => lab.api().get(`/api/v1/patients/${patientId}/genomic-profile${query}`).set(bearer(who.token));

  it('builds the profile from the stored assessment, answers the recorded medication, checks a drug, and writes nothing', async () => {
    const s = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: REVIEWS });
    const assessed = await lab.api().post(`/api/v1/reports/${s.reportId}/structured-assessment`).set(bearer(s.uploader.token)).expect(201);
    const evaluation = evaluationDtoSchema.parse(assessed.body);
    await lab.api().post(`/api/v1/patients/${s.patientId}/medications`).set(bearer(s.uploader.token)).send(medicationBody()).expect(201);
    const evaluationsBefore = await lab.count('evaluations', 'patient_id = $1', [s.patientId]);
    const medicationsBefore = await lab.count('patient_medications', 'patient_id = $1', [s.patientId]);

    const reader = await lab.person('reader', ['reader']);
    const body = genomicProfileDtoSchema.parse((await profile(s.patientId, reader).expect(200)).body);
    expect(body).toMatchObject({ patientId: s.patientId, clinicalUse: 'not-approved', capped: false, awaitingLinkReview: [], check: null });
    // A consistency check against the stored evaluation: every gene it holds, once, from that one source.
    expect(body.genes.map((g) => g.gene)).toEqual([...new Set(evaluation.geneStates.map((g) => g.gene))].sort());
    for (const gene of body.genes) expect(gene.sources.map((source) => source.evaluationId)).toEqual([evaluation.id]);
    // The synthetic knowledge is schema 1.2, so its results carry no RxCUI and no real medication can match one (GP-6).
    expect(body.medications).toHaveLength(1);
    expect(body.medications[0]).toMatchObject({ rxcui: '5470', word: 'no-guideline-loaded', knowledgeChanged: false, conflict: false, results: [] });

    const checked = genomicProfileDtoSchema.parse((await profile(s.patientId, reader, '?rxcui=5470').expect(200)).body);
    expect(checked.check).toMatchObject({ rxcui: '5470', name: null, word: 'no-guideline-loaded', results: [] });

    // GP-7: reading stored nothing.
    expect(await lab.count('evaluations', 'patient_id = $1', [s.patientId])).toBe(evaluationsBefore);
    expect(await lab.count('patient_medications', 'patient_id = $1', [s.patientId])).toBe(medicationsBefore);
  });

  it('answers each clinical read role and refuses an administrator alone', async () => {
    const s = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
    for (const roles of [['reader'], ['clinician'], ['reviewer']]) await profile(s.patientId, await lab.person(`role-${roles[0]}`, roles)).expect(200);
    await profile(s.patientId, await lab.person('admin', ['admin'])).expect(403);
  });

  it('is 404 for an unknown patient and for a patient of another tenant, and 400 for a synthetic or malformed RxCUI', async () => {
    const s = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
    const reader = await lab.person('reader', ['reader']);
    await profile(randomUUID(), reader).expect(404);
    const outsider = await lab.person('outsider', ['reader'], `${lab.tenant}-other`);
    // Control: the outsider is a working member of their own tenant, so the 404 below is the tenant boundary, not a refused caller.
    await lab.api().get('/api/v1/patients').set(bearer(outsider.token)).expect(200);
    await profile(s.patientId, outsider).expect(404);
    await profile(s.patientId, reader, '?rxcui=syn-rxcui-drugq').expect(400);
    await profile(s.patientId, reader, '?rxcui=0123').expect(400);
  });
});

// Spec 045 N2 over the real stores: a signed gene modifier list loaded under the production rules (test signers only). The list names an invented
// gene, GENEA, so no drug here is said to affect a real one; the drug is the bundled list's, because a medication can only record a listed drug.
(usingPostgres() && usingS3() ? describe : describe.skip)('the genomic profile with a signed gene modifier list (spec 045 N2)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let prepare: ReturnType<typeof structuredFixtures>['prepare'];

  beforeAll(async () => {
    const dir = await signedModifierCopy({
      edit: (file) => {
        if (file.id !== 'syn-modifiers-a') return;
        const listed = { ingredient: 'hydralazine', rxcui: '5470', gene: 'GENEA', hgncId: MODIFIER_TEST_IDS.hgncId.GENEA, effect: 'inhibitor', strength: 'strong' } as const;
        file.entries = [{ ...listed, locator: { table: 'Synthetic Table 1' } }];
      },
    });
    db = await createEphemeralDatabase();
    const geneModifiers = { dir, signerKeys: signerKeysJson() };
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl, syntheticAssessment: true, medicationWrites: 'enabled', geneModifiers });
    lab = new LabPipeline(app, db.adminUrl);
    prepare = structuredFixtures(lab).prepare;
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
    await cleanupTempDirs();
  });

  it('names the recorded medication on the card of the gene it is listed against, and nowhere else, and writes nothing', async () => {
    const s = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: REVIEWS });
    await lab.api().post(`/api/v1/reports/${s.reportId}/structured-assessment`).set(bearer(s.uploader.token)).expect(201);
    await lab.api().post(`/api/v1/patients/${s.patientId}/medications`).set(bearer(s.uploader.token)).send(medicationBody()).expect(201);
    const evaluationsBefore = await lab.count('evaluations', 'patient_id = $1', [s.patientId]);
    const medicationsBefore = await lab.count('patient_medications', 'patient_id = $1', [s.patientId]);

    const reader = await lab.person('reader', ['reader']);
    const response = await lab.api().get(`/api/v1/patients/${s.patientId}/genomic-profile`).set(bearer(reader.token)).expect(200);
    const body = genomicProfileDtoSchema.parse(response.body);
    expect(body.modifierLists).toEqual({ loaded: true });
    expect(body.genes.find((gene) => gene.gene === 'GENEA')!.contextNotices).toEqual([
      {
        kind: 'gene-modifier',
        gene: 'GENEA',
        medication: { rxcui: '5470', name: 'hydralazine', startRecorded: true },
        effect: 'inhibitor',
        strength: 'strong',
        source: {
          listId: 'syn-modifiers-a',
          source: 'SYNTHETIC TEST FIXTURE - not FDA content',
          sourceVersion: 'synthetic-1',
          sourceUrl: 'https://example.invalid/synthetic',
          table: 'Synthetic Table 1',
          row: null,
        },
      },
    ]);
    expect(body.genes.find((gene) => gene.gene === 'GENEB')!.contextNotices).toEqual([]);
    // The synthetic knowledge is schema 1.2: no result matches the medication, so its row has no gene to rest on and no notice (rule 3).
    expect(body.medications).toMatchObject([{ rxcui: '5470', word: 'no-guideline-loaded', contextNotices: [] }]);

    // PN-8: reading stored nothing.
    expect(await lab.count('evaluations', 'patient_id = $1', [s.patientId])).toBe(evaluationsBefore);
    expect(await lab.count('patient_medications', 'patient_id = $1', [s.patientId])).toBe(medicationsBefore);
  });
});
