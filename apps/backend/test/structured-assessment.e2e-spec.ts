import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { evaluationDtoSchema, type EvaluationDto } from '@telesphoros/shared-types';
import { AppException } from '../src/common/app-exception';
import { ENV, type Env } from '../src/config/env';
import { DataOriginError } from '../src/ledger/data-origin';
import { EvaluationsService } from '../src/lab-reports/evaluations.service';
import { toEvaluationDto } from '../src/lab-reports/lab-report.mapper';
import { ReaderLimiter } from '../src/lab-reports/reader-limiter';
import { STRUCTURED_HOLD_ACTIONS, STRUCTURED_HOLD_MESSAGES, type StructuredHoldCode } from '../src/lab-reports/structured-hold-codes';
import { LedgerStatus } from '../src/ledger/ledger-status';
import { LedgerVerifier } from '../src/ledger/verifier';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { loadKnowledge } from '../src/services/knowledge/knowledge-loader';
import type { KnowledgeSet } from '../src/services/knowledge/knowledge-set';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { ReportsRepository } from '../src/storage/reports.repository';
import { StructuredRevisionsRepository } from '../src/storage/structured-revisions.repository';
import { createTestApp, usingPostgres, usingS3 } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { LabPipeline } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';
import { structuredFixtures, type Decision, type Package, type Prepared } from './helpers/structured-fixtures';

// 032 S3, PR 2b: a stored structured revision, independently reviewed finding by finding, is assessed against the synthetic structured knowledge set. The
// expected cells below are written by hand from data/fixtures/knowledge/synthetic-structured and the two gene maps, never read back from the engine:
//   GENEA (function pairs):   *1/*1 Normal | *1/*3 Intermediate | *2/*2 Poor            (*1 normal, *2 no function, *3 decreased)
//   GENEB (activity score):   *3/*3 = 0 Low | *1/*3 = 1 Medium | *1/*1 = 2 High        (*1 = 1, *3 = 0)
const REPO = resolve(__dirname, '../../..');
const KNOWLEDGE_DIR = resolve(REPO, 'data/fixtures/knowledge/synthetic-structured');

(usingPostgres() && usingS3() ? describe : describe.skip)('assessing a stored structured revision (real PostgreSQL/S3)', () => {
  let app: NestExpressApplication;
  let db: EphemeralDatabase;
  let lab: LabPipeline;
  let prepare: ReturnType<typeof structuredFixtures>['prepare'];
  let verifier: LedgerVerifier;
  let knowledge: KnowledgeSet;
  let service: EvaluationsService;
  let unnamedOrigin: EvaluationsService;
  let noBuildVersion: EvaluationsService;
  const principal = () => ({ sub: 'syn-system', tenantId: lab.tenant, roles: [] });

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
    lab = new LabPipeline(app, db.adminUrl);
    prepare = structuredFixtures(lab).prepare;
    verifier = LedgerVerifier.connect(db.verifierUrl);
    knowledge = await loadKnowledge({ directory: KNOWLEDGE_DIR, mode: 'non-production' });
    const get = <T>(token: abstract new (...args: never[]) => T) => app.get(token, { strict: false });
    const real = app.get(ENV, { strict: false }) as Env;
    // The routes that would call this are gated behind the report-reader pipeline (a later slice lifts that), so the service is built with exactly
    // what a structured assessment needs: the stores and the synthetic knowledge, and no reader, text runner or pipeline knowledge. Naming a record's data origin "synthetic" needs the
    // pipeline switched on (spec 020 E1a), which this checkout cannot boot without the reader engine, so the service is given an environment that says so
    // and a second service keeps the real one to prove the refusal.
    const build = (env: Env) =>
      new EvaluationsService(
        get(ReportsRepository),
        get(ObjectStorage),
        get(ReaderLimiter),
        env,
        get(LedgerRecordsRepository),
        undefined,
        undefined,
        undefined,
        get(LedgerStatus),
        get(StructuredRevisionsRepository),
        knowledge,
      );
    service = build({ ...real, LAB_REPORT_PIPELINE: 'enabled', BUILD_VERSION: 'test-build-1' } as Env);
    noBuildVersion = build({ ...real, LAB_REPORT_PIPELINE: 'enabled' } as Env);
    unnamedOrigin = build(real);
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const both: Record<string, Decision> = { 'syn-finding-a': 'accepted-as-evidence', 'syn-finding-b': 'accepted-as-evidence' };
  const assess = (s: Prepared) => service.storeStructured(principal(), s.reportId);
  async function dtoOf(id: string): Promise<EvaluationDto> {
    const view = await app.get(LedgerRecordsRepository).evaluationView(lab.tenant, id);
    expect(view).toBeDefined();
    return evaluationDtoSchema.parse(
      toEvaluationDto(view!.record, { ...view!.context, current: view!.current, activeDisputes: view!.activeDisputes, patientLink: view!.patientLink }),
    );
  }
  const evaluations = (reportId: string) => lab.count('evaluations', 'report_id = $1', [reportId]);
  const resultFor = (dto: EvaluationDto, drug: string) => {
    const found = dto.results.filter((r) => r.drug === drug);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const cell = (r: EvaluationDto['results'][number]) => ({ outcome: r.outcome, strength: r.strength, text: r.recommendationText, reason: r.reasonCode });

  describe('a complete, reviewed revision', () => {
    const CASES = [
      {
        name: 'Normal and Low: the verified combined cell',
        a: '*1/*1',
        b: '*3/*3',
        z: { outcome: 'shown', strength: 'Strong', text: 'Z normal-low.', reason: null },
        q: { outcome: 'shown', strength: 'Strong', text: 'Q normal.', reason: null },
      },
      {
        name: 'Poor and Low: a verified combined cell; the single-gene table says no recommendation for Poor',
        a: '*2/*2',
        b: '*3/*3',
        z: { outcome: 'shown', strength: 'Strong', text: 'Z poor-low.', reason: null },
        q: { outcome: 'no-published-recommendation', strength: 'No recommendation', text: 'Q poor: no recommendation.', reason: 'no-published-recommendation' },
      },
      {
        name: 'Poor and High: an explicit no-recommendation cell, with its citation',
        a: '*2/*2',
        b: '*1/*1',
        z: { outcome: 'no-published-recommendation', strength: 'No recommendation', text: 'Z poor-high: no recommendation.', reason: 'no-published-recommendation' },
        q: { outcome: 'no-published-recommendation', strength: 'No recommendation', text: 'Q poor: no recommendation.', reason: 'no-published-recommendation' },
      },
      {
        name: 'Intermediate and Medium: no cell exists, so it is held as a knowledge gap and nothing is borrowed from a nearby row',
        a: '*1/*3',
        b: '*1/*3',
        z: { outcome: 'held', strength: null, text: null, reason: 'knowledge-gap' },
        q: { outcome: 'shown', strength: 'Moderate', text: 'Q intermediate.', reason: null },
      },
      {
        name: 'Intermediate and Low: the cell is unverified, so its wording is never shown',
        a: '*1/*3',
        b: '*3/*3',
        z: { outcome: 'held', strength: null, text: null, reason: 'out-of-review-scope' },
        q: { outcome: 'shown', strength: 'Moderate', text: 'Q intermediate.', reason: null },
      },
    ];
    for (const c of CASES) {
      it(`${c.name}`, async () => {
        const s = await prepare({ a: c.a, b: c.b }, { reviews: both });
        const stored = await assess(s);
        expect(stored.created).toBe(true);
        const dto = await dtoOf(stored.record.id);
        expect(dto).toMatchObject({
          disposition: 'evaluated',
          holdCode: null,
          hold: null,
          captureId: null,
          acceptance: null,
          scope: 'synthetic-structured-assessment',
          reportId: s.reportId,
          patientId: s.patientId,
        });
        // One result per drug: the single-gene drugz table is superseded by the combined one and never answers on its own.
        expect(dto.results.map((r) => r.drug).sort()).toEqual(['drugq', 'drugz']);
        expect(cell(resultFor(dto, 'drugz'))).toEqual(c.z);
        expect(cell(resultFor(dto, 'drugq'))).toEqual(c.q);
      });
    }

    it('shows the cited cell and what the engine received, and the ledger walks clean', async () => {
      const s = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: both });
      const dto = await dtoOf((await assess(s)).record.id);
      expect(resultFor(dto, 'drugz').citation).toMatchObject({
        guidelineId: 'drugz-genea-geneb',
        guidelineVersion: 'synthetic-1',
        locator: { table: 'Synthetic Table 3', row: 'Synthetic Normal', column: 'Synthetic Low' },
        verification: 'verified',
      });
      // The engine's own mapping from the diplotype, not the laboratory's phenotype.
      expect(dto.geneStates.map((g) => [g.gene, g.state, g.phenotype, g.diplotype])).toEqual([
        ['GENEA', 'canonical', 'Synthetic Normal', '*1/*1'],
        ['GENEB', 'canonical', 'Synthetic Low', '*3/*3'],
      ]);
      expect(dto.geneInputs).toEqual([
        { gene: 'GENEA', state: 'diplotype', diplotype: '*1/*1' },
        { gene: 'GENEB', state: 'diplotype', diplotype: '*3/*3' },
      ]);
      expect(await verifier.verify(lab.tenant, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
    });

    it('is the same evaluation when assessed twice, and records the revision and each review it relied on', async () => {
      const s = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: both });
      const first = await assess(s);
      const again = await assess(s);
      expect(again).toMatchObject({ created: false });
      expect(again.record.id).toBe(first.record.id);
      const [row] = await lab.row<{ source_kind: string; structured_revision_id: string; binding: Record<string, unknown> }>(
        'SELECT source_kind, structured_revision_id::text, binding FROM evaluations WHERE id = $1',
        [first.record.id],
      );
      expect(row).toMatchObject({ source_kind: 'structured-revision', structured_revision_id: s.revisionId });
      expect(row!.binding).toMatchObject({
        scope: 'synthetic-structured-assessment',
        synthetic: true,
        clinicalUse: 'not-approved',
        revisionId: s.revisionId,
        patientLinkDecisionId: s.binding.patientLinkDecisionId,
      });
      expect(row!.binding.reviewIds).toHaveLength(2);
    });

    it('holds the drug whose table needs a gene that was not tested; no narrower row answers, and a drug that needs only the tested gene still does', async () => {
      const s = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      const dto = await dtoOf((await assess(s)).record.id);
      expect(dto.disposition).toBe('evaluated');
      expect(dto.results.filter((r) => r.drug === 'drugz')).toHaveLength(1);
      expect(cell(resultFor(dto, 'drugz'))).toEqual({ outcome: 'held', strength: null, text: null, reason: 'gene-absent' });
      expect(cell(resultFor(dto, 'drugq'))).toEqual({ outcome: 'shown', strength: 'Strong', text: 'Q normal.', reason: null });
    });
  });

  describe('a revision that is held: stored with no result, and never quoting the report', () => {
    async function held(code: StructuredHoldCode, s: Prepared, detail: string[]) {
      const stored = await assess(s);
      expect(stored.created).toBe(true);
      const dto = await dtoOf(stored.record.id);
      expect(dto).toMatchObject({
        disposition: 'held',
        holdCode: code,
        results: [],
        geneStates: [],
        geneInputs: [],
        hold: { message: STRUCTURED_HOLD_MESSAGES[code], reviewerAction: STRUCTURED_HOLD_ACTIONS[code] },
      });
      const [row] = await lab.row<{ binding: Record<string, unknown> }>('SELECT binding FROM evaluations WHERE id = $1', [stored.record.id]);
      expect(row!.binding.holdDetail).toEqual(detail);
      // Codes and finding ids only: no diplotype, laboratory phenotype or other value from the report is in the stored record.
      const text = JSON.stringify(row!.binding);
      for (const value of ['*1/*1', '*3/*3', 'Synthetic category']) expect(text).not.toContain(value);
    }

    it('findings no second person has reviewed', async () => {
      await held('findings-not-reviewed', await prepare({ a: '*1/*1', b: '*3/*3' }), ['syn-finding-a:unreviewed', 'syn-finding-b:unreviewed']);
    });
    it('one finding unreviewed beside one accepted', async () => {
      await held('findings-not-reviewed', await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } }), ['syn-finding-b:unreviewed']);
    });
    it('a finding the reviewer held for clarification', async () => {
      await held('findings-not-reviewed', await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'held' } }), ['syn-finding-a:held']);
    });
    it('a finding the reviewer rejected', async () => {
      await held('unresolved-finding', await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'rejected' } }), ['syn-finding-a:rejected']);
    });
    it('an ambiguous finding, even though a reviewer accepted it as matching its source', async () => {
      const mutate = (pkg: Package) => {
        Object.assign(pkg.report.findings[0], {
          analyticalState: 'ambiguous',
          interpretationState: 'indeterminate',
          reportedCall: { kind: 'unresolved', originalText: 'unclear', candidates: ['*1/*1', '*1/*3'] },
          laboratoryInterpretation: null,
        });
      };
      await held('unresolved-finding', await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' }, mutate }), ['syn-finding-a:ambiguous/indeterminate']);
    });
    it('a call that is not a diplotype', async () => {
      const mutate = (pkg: Package) => {
        pkg.report.findings[0].reportedCall = { kind: 'allele', originalText: '*1', value: '*1', nomenclatureVersion: 'synthetic-names-1' };
      };
      await held('unsupported-source', await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' }, mutate }), ['syn-finding-a:allele']);
    });
    it('a preliminary report', async () => {
      await held('unsupported-source', await prepare({ a: '*1/*1' }, { mutate: (pkg) => (pkg.report.status = 'preliminary') }), ['latest-status-ineligible']);
    });
    it('two conflicting stored sources of one laboratory revision, even when every finding of each was accepted', async () => {
      const first = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      // Reviews of a conflicting set are closed, so review the first source before the second arrives; then the second changes the set.
      const second = await prepare({ a: '*1/*1' }, { same: first, mutate: (pkg) => (pkg.report.limitations = ['A changed source at the same laboratory revision.']) });
      const stored = await assess(second);
      const dto = await dtoOf(stored.record.id);
      expect(dto).toMatchObject({ disposition: 'held', holdCode: 'source-conflict', results: [] });
      const [row] = await lab.row<{ binding: { holdDetail: string[] } }>('SELECT binding FROM evaluations WHERE id = $1', [stored.record.id]);
      expect(row!.binding.holdDetail).toContain('duplicate-revision-content');
    });
  });

  describe('refusals: nothing is stored', () => {
    it('a report whose patient link is no longer verified (control: the same report was assessable before)', async () => {
      const s = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      // Control: while the link is verified an assessment is stored for this report, so the refusal below is about the link and nothing else.
      expect(await evaluations(s.reportId)).toBe(0);
      await expect(assess(s)).resolves.toMatchObject({ created: true });
      const other = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      await lab
        .api()
        .post(`/api/v1/reports/${other.reportId}/structured-preview/patient-link`)
        .set(bearer(other.reviewer.token))
        .send({
          patientId: other.binding.patientId,
          sha256: other.binding.sha256,
          objectVersion: other.binding.objectVersion,
          sourcePatientReference: other.binding.sourcePatientReference,
          decision: 'rejected',
          basisCode: 'different-person',
        })
        .expect(201);
      await expect(assess(other)).rejects.toMatchObject({ details: [{ reason: 'patient-link-unverified' }] });
      expect(await evaluations(other.reportId)).toBe(0);
    });
    it('an environment that cannot name the data as synthetic (control: the same report is assessed when it can)', async () => {
      const s = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      await expect(unnamedOrigin.storeStructured(principal(), s.reportId)).rejects.toBeInstanceOf(DataOriginError);
      expect(await evaluations(s.reportId)).toBe(0);
      await expect(assess(s)).resolves.toMatchObject({ created: true });
    });
    it('an environment with no build version, which every evaluation records (control: the same report is assessed when it has one)', async () => {
      const s = await prepare({ a: '*1/*1' }, { reviews: { 'syn-finding-a': 'accepted-as-evidence' } });
      await expect(noBuildVersion.storeStructured(principal(), s.reportId)).rejects.toBeInstanceOf(AppException);
      expect(await evaluations(s.reportId)).toBe(0);
      await expect(assess(s)).resolves.toMatchObject({ created: true });
    });
    it('a structured report with no stored revision', async () => {
      const s = await prepare({ a: '*1/*1' }, { save: false });
      await expect(assess(s)).rejects.toMatchObject({ details: [{ reason: 'structured-not-recorded' }] });
      expect(await evaluations(s.reportId)).toBe(0);
    });
    it('a report that is not a structured report, and one that does not exist', async () => {
      const s = await prepare({ a: '*1/*1' }, { save: false });
      const pdf = (
        await lab.api().post('/api/v1/reports').set(bearer(s.uploader.token)).send({ patientId: s.patientId, type: 'lab-pdf', filename: 'x.pdf', sizeBytes: 10 }).expect(201)
      ).body;
      await expect(service.storeStructured(principal(), pdf.id)).rejects.toMatchObject({ details: [{ reason: 'wrong-type' }] });
      await expect(service.storeStructured(principal(), randomUUID())).rejects.toBeInstanceOf(AppException);
      expect(await evaluations(pdf.id)).toBe(0);
    });
  });

  // Last: a dispute is tenant-wide, so it would change every assessment made after it.
  describe('a disputed cell', () => {
    it('holds only the disputed cell, with its citation and no wording, and keeps every other cell (control: the same inputs showed it before)', async () => {
      const before = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: both });
      expect(cell(resultFor(await dtoOf((await assess(before)).record.id), 'drugz'))).toMatchObject({ outcome: 'shown', text: 'Z normal-low.' });

      const file = knowledge.files.find((f) => f.kind === 'guideline' && f.id === 'drugz-genea-geneb')!;
      await app.get(LedgerRecordsRepository).raiseDispute(lab.tenant, 'syn-disputer', {
        guidelineId: 'drugz-genea-geneb',
        guidelineVersion: 'synthetic-1',
        guidelineContentSha256: file.contentSha256,
        locator: { table: 'Synthetic Table 3', row: 'Synthetic Normal', column: 'Synthetic Low' },
        note: 'Synthetic dispute for a test.',
      });

      const disputed = await prepare({ a: '*1/*1', b: '*3/*3' }, { reviews: both });
      const stored = await assess(disputed);
      const dto = await dtoOf(stored.record.id);
      expect(cell(resultFor(dto, 'drugz'))).toEqual({ outcome: 'held', strength: null, text: null, reason: 'cell-disputed' });
      expect(resultFor(dto, 'drugz').citation).toMatchObject({ guidelineId: 'drugz-genea-geneb', locator: { row: 'Synthetic Normal', column: 'Synthetic Low' } });
      expect(cell(resultFor(dto, 'drugq'))).toMatchObject({ outcome: 'shown', text: 'Q normal.' });
      const [row] = await lab.row<{ binding: Record<string, unknown> }>('SELECT binding FROM evaluations WHERE id = $1', [stored.record.id]);
      expect(row!.binding.overlay).toMatchObject({ baseKnowledgeSetId: knowledge.id });

      // A cell that was not disputed is unaffected.
      const other = await prepare({ a: '*2/*2', b: '*3/*3' }, { reviews: both });
      expect(cell(resultFor(await dtoOf((await assess(other)).record.id), 'drugz'))).toMatchObject({ outcome: 'shown', text: 'Z poor-low.' });
      expect(await verifier.verify(lab.tenant, { mode: 'full' })).toMatchObject({ status: 'ok', failures: [] });
    });
  });
});
