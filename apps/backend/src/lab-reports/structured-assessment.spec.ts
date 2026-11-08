import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSyntheticPgxPackage, type StructuredPreview } from '@telesphoros/shared-types';
import type { StoredFindingReview, StoredSourceResolution, StoredStructuredRevision, StructuredSnapshot } from '../storage/structured-revisions.repository';
import { loadKnowledge, KnowledgeLoadError } from '../services/knowledge/knowledge-loader';
import { evaluate } from '../services/recommendation-engine/recommendation-engine';
import { planStructuredAssessment, type StructuredAssessmentPlan } from './structured-assessment';
import { STRUCTURED_HOLD_ACTIONS, STRUCTURED_HOLD_CODES, STRUCTURED_HOLD_MESSAGES } from './structured-hold-codes';

// The expected plan for each case below is written from the rules in the slice plan (docs/design/plans/pgx-synthetic-assessment.md), not read back from
// the function: a revision is assessed only when every finding was independently accepted and is a resolved, tested, interpretable diplotype.
const REPO = resolve(__dirname, '../../../..');
type SyntheticPgxLabReport = StructuredPreview['laboratoryReport'];
const base: SyntheticPgxLabReport = parseSyntheticPgxPackage(readFileSync(resolve(REPO, 'data/fixtures/pgx-contracts/resolved/package.json'), 'utf8')).report;
const findingA = base.findings[0]!;
// The lineage reader parses what it is given, so tenant, patient and revision ids are real UUIDs and every report is a valid S1 report.
const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const REV1 = '33333333-3333-4333-8333-333333333331';
const REV2 = '33333333-3333-4333-8333-333333333332';

const finding = (over: Record<string, unknown> = {}) => ({ ...findingA, ...over }) as SyntheticPgxLabReport['findings'][number];
/** A valid report: the manifest names a target for every finding, with the classes every kind of call needs. */
const withFindings = (findings: SyntheticPgxLabReport['findings'], over: Record<string, unknown> = {}): SyntheticPgxLabReport => {
  if (base.assay.state !== 'provided') throw new Error('The S1 fixture is expected to carry its assay manifest.');
  const manifest = base.assay.manifest;
  const targets = findings.map((f) => ({
    id: f.targetId,
    gene: f.gene,
    variantClasses: ['sequence', 'copy-number', 'activity'] as const,
    alleles: ['*A', '*B'],
    limitations: ['Invented target.'],
  }));
  return { ...base, assay: { state: 'provided', manifest: { ...manifest, targets } }, findings, ...over } as unknown as SyntheticPgxLabReport;
};
const revision = (report: SyntheticPgxLabReport, over: Partial<StoredStructuredRevision> = {}): StoredStructuredRevision => ({
  id: REV1,
  reportId: 'rep-1',
  patientId: PATIENT,
  sha256: 'a'.repeat(64),
  objectVersion: 'v1',
  patientLinkDecisionId: 'dec-1',
  createdAt: '2026-11-03T00:00:00.000Z',
  laboratoryReport: report,
  currentBinding: true,
  ...over,
});
const review = (revisionId: string, findingId: string, decision: StoredFindingReview['decision'] = 'accepted-as-evidence'): StoredFindingReview => ({
  id: `rv-${revisionId}-${findingId}`,
  revisionId,
  findingId,
  decision,
  reasonCode: { 'accepted-as-evidence': 'matches-source', rejected: 'does-not-match-source', held: 'needs-clarification' }[decision],
  createdAt: '2026-11-03T00:00:01.000Z',
});
const snapshot = (revisions: StoredStructuredRevision[], reviews: StoredFindingReview[] = [], resolutions: StoredSourceResolution[] = []): StructuredSnapshot => ({
  revisions,
  reviews,
  resolutions,
});
const plan = (s: StructuredSnapshot, reportId = 'rep-1'): StructuredAssessmentPlan => planStructuredAssessment(TENANT, { id: reportId, patientId: PATIENT }, s);
const held = (p: StructuredAssessmentPlan) => {
  if (p.kind !== 'held') throw new Error(`expected a held plan, got ${p.kind}`);
  return { holdCode: p.holdCode, detail: p.detail };
};

describe('planStructuredAssessment', () => {
  it('holds a report with no findings: nothing was reviewed, so "every finding was reviewed" must not pass on an empty list', () => {
    const noFindings = { ...base, findings: [] } as unknown as SyntheticPgxLabReport; // the manifest stays: a valid report that simply lists nothing
    expect(held(plan(snapshot([revision(noFindings)])))).toEqual({ holdCode: 'unsupported-source', detail: ['no-findings'] });
  });

  it('is ready only when every finding is an accepted, tested, resolved, interpretable diplotype, and reads the diplotype, not the lab phenotype', () => {
    const p = plan(snapshot([revision(withFindings([finding()]))], [review(REV1, findingA.id)]));
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') return;
    // The call's own value is passed on; "Synthetic category A" (the laboratory's phenotype) appears nowhere in the engine input.
    expect(p.geneInputs).toEqual([{ gene: 'GENEA', state: 'diplotype', diplotype: '*A/*A' }]);
    expect(JSON.stringify(p.geneInputs)).not.toContain('category');
    expect(p.reviewIds).toEqual([`rv-${REV1}-${findingA.id}`]);
  });

  it('accepts a diplotype whose copy number is unstated (null) or exactly two, and holds any other copy number as unsupported', () => {
    const call = (copyNumber: number | null) => ({ reportedCall: { ...(findingA.reportedCall as object), copyNumber } });
    const planFor = (copyNumber: number | null) => plan(snapshot([revision(withFindings([finding(call(copyNumber))]))], [review(REV1, findingA.id)]));
    expect(planFor(null).kind).toBe('ready');
    expect(planFor(2).kind).toBe('ready');
    expect(held(planFor(3))).toEqual({ holdCode: 'unsupported-source', detail: [`${findingA.id}:copy-number`] });
    expect(held(planFor(1))).toEqual({ holdCode: 'unsupported-source', detail: [`${findingA.id}:copy-number`] });
  });

  describe('holds, and what each one names', () => {
    it('findings no second person has reviewed', () => {
      expect(held(plan(snapshot([revision(withFindings([finding()]))])))).toEqual({ holdCode: 'findings-not-reviewed', detail: [`${findingA.id}:unreviewed`] });
    });
    it('a finding the reviewer held for clarification', () => {
      expect(held(plan(snapshot([revision(withFindings([finding()]))], [review(REV1, findingA.id, 'held')])))).toEqual({
        holdCode: 'findings-not-reviewed',
        detail: [`${findingA.id}:held`],
      });
    });
    it('a finding the reviewer rejected', () => {
      expect(held(plan(snapshot([revision(withFindings([finding()]))], [review(REV1, findingA.id, 'rejected')])))).toEqual({
        holdCode: 'unresolved-finding',
        detail: [`${findingA.id}:rejected`],
      });
    });
    it('an uncertain finding, even when a reviewer accepted it as evidence (an acceptance never removes uncertainty)', () => {
      const ambiguous = finding({
        analyticalState: 'ambiguous',
        interpretationState: 'indeterminate',
        reportedCall: { kind: 'unresolved', originalText: '*A or *B', candidates: ['*A/*A', '*A/*B'] },
        laboratoryInterpretation: null,
      });
      expect(held(plan(snapshot([revision(withFindings([ambiguous]))], [review(REV1, findingA.id)])))).toEqual({
        holdCode: 'unresolved-finding',
        detail: [`${findingA.id}:ambiguous/indeterminate`],
      });
    });
    it('a finding that was not tested', () => {
      const notTested = finding({
        coverage: 'not-tested',
        analyticalState: 'not-applicable',
        interpretationState: 'not-assessed',
        reportedCall: null,
        laboratoryInterpretation: null,
      });
      expect(held(plan(snapshot([revision(withFindings([notTested]))], [review(REV1, findingA.id)])))).toEqual({
        holdCode: 'unresolved-finding',
        detail: [`${findingA.id}:not-applicable/not-assessed`],
      });
    });
    it('a call the engine cannot read: an allele, a variant or an activity value is not a diplotype', () => {
      for (const reportedCall of [
        { kind: 'allele', originalText: '*A', value: '*A', nomenclatureVersion: 'v1' },
        { kind: 'variant', originalText: 'x', reference: 'r', hgvs: 'h', zygosity: 'het' },
        { kind: 'activity', originalText: '1', value: 1, unit: 'u', method: 'm', measuredAt: base.specimen.collectedAt },
      ]) {
        expect(held(plan(snapshot([revision(withFindings([finding({ reportedCall })]))], [review(REV1, findingA.id)])))).toEqual({
          holdCode: 'unsupported-source',
          detail: [`${findingA.id}:${reportedCall.kind}`],
        });
      }
    });
    it('a report whose latest status is not final, amended or corrected', () => {
      expect(held(plan(snapshot([revision(withFindings([finding()], { status: 'preliminary' }))], [review(REV1, findingA.id)])))).toEqual({
        holdCode: 'unsupported-source',
        detail: ['latest-status-ineligible'],
      });
    });
    it('an assay that was not provided', () => {
      const unknown = finding({ coverage: 'unknown', analyticalState: 'not-applicable', interpretationState: 'not-assessed', reportedCall: null, laboratoryInterpretation: null });
      const noAssay = withFindings([unknown], { assay: { state: 'unavailable', reason: 'No assay manifest was supplied.' } });
      expect(held(plan(snapshot([revision(noAssay)], [review(REV1, findingA.id)])))).toEqual({
        holdCode: 'unsupported-source',
        detail: ['assay:not-provided'],
      });
    });
  });

  describe('ranking: the first rule that applies names the hold', () => {
    const allele = finding({ id: 'syn-f-allele', targetId: 'syn-t-allele', reportedCall: { kind: 'allele', originalText: '*A', value: '*A', nomenclatureVersion: 'v1' } });
    const ambiguous = finding({
      id: 'syn-f-ambiguous',
      targetId: 'syn-t-ambiguous',
      analyticalState: 'ambiguous',
      interpretationState: 'indeterminate',
      reportedCall: { kind: 'unresolved', originalText: '?', candidates: ['*A/*A', '*A/*B'] },
      laboratoryInterpretation: null,
    });
    it('an unreviewed finding outranks an unsupported one', () => {
      expect(held(plan(snapshot([revision(withFindings([allele]))]))).holdCode).toBe('findings-not-reviewed');
    });
    it('an unsupported finding outranks an uncertain one', () => {
      const s = snapshot([revision(withFindings([allele, ambiguous]))], [review(REV1, 'syn-f-allele'), review(REV1, 'syn-f-ambiguous')]);
      expect(held(plan(s))).toEqual({ holdCode: 'unsupported-source', detail: ['syn-f-allele:allele'] });
    });
    it('one finding that is not usable stops the whole revision, even beside a usable one', () => {
      const s = snapshot([revision(withFindings([finding(), ambiguous]))], [review(REV1, findingA.id), review(REV1, 'syn-f-ambiguous')]);
      expect(held(plan(s)).holdCode).toBe('unresolved-finding');
    });
  });

  describe('refusals: nothing is stored', () => {
    it('no stored revision for this report', () => {
      expect(plan(snapshot([]))).toEqual({ kind: 'refused', reason: 'not-recorded' });
      expect(plan(snapshot([revision(withFindings([finding()]))]), 'rep-other')).toEqual({ kind: 'refused', reason: 'not-recorded' });
    });
    it('the stored evidence no longer matches the report file or the patient link', () => {
      const s = snapshot([revision(withFindings([finding()]), { currentBinding: false })], [review(REV1, findingA.id)]);
      expect(plan(s)).toEqual({ kind: 'refused', reason: 'source-changed' });
    });
  });

  describe('two conflicting stored sources of one laboratory revision', () => {
    const second = withFindings([finding()], { limitations: ['A changed source at the same laboratory revision.'] });
    const sources = () => [revision(withFindings([finding()])), revision(second, { id: REV2, reportId: 'rep-2', sha256: 'b'.repeat(64) })];
    const reviews = [review(REV1, findingA.id), review(REV2, findingA.id)];
    const choice = (chosen: string): StoredSourceResolution => ({
      id: 'res-1',
      laboratoryId: base.laboratoryId,
      seriesId: base.seriesId,
      revision: base.revision,
      revisionIds: [REV1, REV2],
      outcome: 'use-revision',
      chosenRevisionId: chosen,
      reasonCode: 'chosen-by-reviewer',
      createdAt: '2026-11-03T00:00:02.000Z',
    });
    it('is held as a source conflict until someone chooses, even though every finding was reviewed', () => {
      const result = held(plan(snapshot(sources(), reviews)));
      expect(result.holdCode).toBe('source-conflict');
      expect(result.detail).toContain('duplicate-revision-content');
    });
    it('after a choice, the chosen revision is assessed and the other is refused as not the one under review', () => {
      const s = snapshot(sources(), reviews, [choice(REV2)]);
      expect(plan(s, 'rep-2').kind).toBe('ready');
      expect(plan(s, 'rep-1')).toEqual({ kind: 'refused', reason: 'superseded' });
    });
  });
});

describe('the hold vocabulary a structured source may use', () => {
  const migration = readFileSync(resolve(REPO, 'apps/backend/migrations/0070_evaluations_structured_source.up.sql'), 'utf8');
  it('is exactly the codes this slice raises, and every one is a code migration 0070 allows for a structured source', () => {
    expect([...STRUCTURED_HOLD_CODES]).toEqual(['findings-not-reviewed', 'source-conflict', 'unresolved-finding', 'unsupported-source']);
    for (const code of STRUCTURED_HOLD_CODES) expect(migration).toContain(`'${code}'`);
  });
  it('has fixed wording for each code, which quotes nothing from a report', () => {
    expect(Object.keys(STRUCTURED_HOLD_MESSAGES).sort()).toEqual([...STRUCTURED_HOLD_CODES].sort());
    expect(Object.keys(STRUCTURED_HOLD_ACTIONS).sort()).toEqual([...STRUCTURED_HOLD_CODES].sort());
    for (const code of STRUCTURED_HOLD_CODES) for (const text of [STRUCTURED_HOLD_MESSAGES[code], STRUCTURED_HOLD_ACTIONS[code]]) expect(text).toMatch(/^[A-Z][A-Za-z ,.;-]+\.$/);
  });
});

describe('the synthetic knowledge set for structured assessment', () => {
  const dir = resolve(REPO, 'data/fixtures/knowledge/synthetic-structured');
  const baseDir = resolve(REPO, 'data/fixtures/knowledge/synthetic');
  it('shares its two gene maps byte for byte with the base synthetic set, so they cannot drift apart', () => {
    for (const gene of ['genea', 'geneb']) {
      expect(readFileSync(resolve(dir, 'phenotypes', `${gene}.json`)).equals(readFileSync(resolve(baseDir, 'phenotypes', `${gene}.json`)))).toBe(true);
    }
  });
  it('loads outside production, and is refused in production because every file is synthetic (control: the same directory loads when allowed)', async () => {
    const set = await loadKnowledge({ directory: dir, mode: 'non-production' });
    expect(
      set
        .allGuidelines()
        .map((g) => g.id)
        .sort(),
    ).toEqual(['drugq-genea', 'drugz-genea', 'drugz-genea-geneb']);
    await expect(loadKnowledge({ directory: dir, mode: 'production' })).rejects.toBeInstanceOf(KnowledgeLoadError);
  });
  it('holds, and never guesses, a diplotype the knowledge does not define (the S1 demonstration packages report "*A/*A", which no map here knows)', async () => {
    const set = await loadKnowledge({ directory: dir, mode: 'non-production' });
    const { results } = evaluate(set, [{ gene: 'GENEA', state: 'diplotype', diplotype: '*A/*A' }]);
    expect(results.map((r) => [r.drug, r.outcome, 'reasonCode' in r ? r.reasonCode : null]).sort()).toEqual([
      ['drugq', 'held', 'allele-not-in-definitions'],
      ['drugz', 'held', 'allele-not-in-definitions'],
    ]);
  });
  it('leaves the base synthetic set alone: its content hash is part of every PDF evaluation test', async () => {
    expect(
      (await loadKnowledge({ directory: baseDir, mode: 'non-production' }))
        .allGuidelines()
        .map((g) => g.id)
        .sort(),
    ).toEqual(['drugv-genea', 'drugv-genea-genee', 'drugw-genea', 'drugx-genea', 'drugx-genec', 'drugy-geneb']);
  });
});

describe('the structured demonstration package', () => {
  const demoPath = resolve(REPO, 'data/fixtures/pgx-structured-demo/package.json');
  const demo = () => parseSyntheticPgxPackage(readFileSync(demoPath, 'utf8')).report;

  it('is a valid S1 package whose findings are assessable once a second person accepts them (control: unreviewed, it is held)', () => {
    const report = demo();
    expect(report.findings.map((f) => [f.id, f.gene, f.reportedCall?.kind])).toEqual([
      ['syn-finding-a', 'GENEA', 'diplotype'],
      ['syn-finding-b', 'GENEB', 'diplotype'],
    ]);
    expect(held(plan(snapshot([revision(report)])))).toMatchObject({ holdCode: 'findings-not-reviewed' });
    const ready = plan(snapshot([revision(report)], [review(REV1, 'syn-finding-a'), review(REV1, 'syn-finding-b')]));
    expect(ready.kind).toBe('ready');
    if (ready.kind === 'ready')
      expect(ready.geneInputs).toEqual([
        { gene: 'GENEA', state: 'diplotype', diplotype: '*1/*1' },
        { gene: 'GENEB', state: 'diplotype', diplotype: '*3/*3' },
      ]);
  });

  it('gives the expected synthetic cells against the structured knowledge, written by hand: GENEA *1/*1 is Normal and GENEB *3/*3 (activity 0) is Low', async () => {
    const set = await loadKnowledge({ directory: resolve(REPO, 'data/fixtures/knowledge/synthetic-structured'), mode: 'non-production' });
    const plan_ = plan(snapshot([revision(demo())], [review(REV1, 'syn-finding-a'), review(REV1, 'syn-finding-b')]));
    if (plan_.kind !== 'ready') throw new Error('expected a ready plan');
    const text = Object.fromEntries(evaluate(set, plan_.geneInputs).results.map((r) => [r.drug, 'recommendationText' in r ? r.recommendationText : null]));
    expect(text).toEqual({ drugq: 'Q normal.', drugz: 'Z normal-low.' });
  });
});
