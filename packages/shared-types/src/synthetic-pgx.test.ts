import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSyntheticPgxPackage, syntheticPgxPackageSchema, SYNTHETIC_PGX_MAX_BYTES } from './index';

const fixture = (name = 'resolved'): any => JSON.parse(readFileSync(new URL(`../../../data/fixtures/pgx-contracts/${name}/package.json`, import.meta.url), 'utf8'));
const check = (change: (p: any) => void) => {
  const value = fixture();
  change(value);
  expect(syntheticPgxPackageSchema.safeParse(value).success).toBe(false);
};

describe('synthetic laboratory package contract', () => {
  it.each(['resolved', 'uncertain', 'amended'])('preserves the independent %s example exactly', (name) => {
    const value = fixture(name);
    expect(parseSyntheticPgxPackage(JSON.stringify(value))).toEqual(value);
    expect(syntheticPgxPackageSchema.parse(value)).toEqual(value);
  });
  it.each<[string, (p: any) => void]>([
    ['version', (p: any) => (p.schemaVersion = 'production-1')],
    ['synthetic flag', (p: any) => (p.synthetic = false)],
    ['approval', (p: any) => (p.clinicalUse = 'approved')],
    ['actionable', (p: any) => (p.actionable = true)],
    ['unknown field', (p: any) => (p.report.approved = true)],
    ['duplicate finding', (p: any) => p.report.findings.push(p.report.findings[0])],
    ['duplicate target', (p: any) => p.report.assay.manifest.targets.push(p.report.assay.manifest.targets[0])],
    ['duplicate target finding', (p: any) => p.report.findings.push({ ...p.report.findings[0], id: 'syn-other-finding' })],
    ['uncovered copy number', (p: any) => (p.report.findings[0].reportedCall.copyNumber = 3)],
    ['wrong laboratory', (p: any) => (p.report.assay.manifest.laboratoryId = 'syn-other')],
    ['unknown target', (p: any) => (p.report.findings[0].targetId = 'syn-other')],
    ['wrong target gene', (p: any) => (p.report.findings[0].gene = 'GENEB')],
    ['wrong specimen type', (p: any) => (p.report.specimen.type = 'synthetic-blood')],
    ['wrong source', (p: any) => (p.assessment.sourceReport.id = 'syn-other')],
    ['wrong revision', (p: any) => (p.assessment.sourceReport.revision = 2)],
    ['wrong patient', (p: any) => (p.assessment.context.patientId = 'syn-other')],
    ['unknown finding', (p: any) => (p.assessment.results[0].findingIds = ['syn-other'])],
    ['duplicate result', (p: any) => p.assessment.results.push(p.assessment.results[0])],
    ['unknown medication', (p: any) => (p.assessment.results[0].medicationId = 'syn-other')],
    ['wrong drug', (p: any) => (p.assessment.results[0].drug = 'synthetic-drug-b')],
    ['unknown rule', (p: any) => (p.assessment.results[0].sourceRuleId = 'syn-other')],
    ['missing joint target', (p: any) => p.assessment.knowledge.rules[0].requiredTargetIds.push('syn-target-b')],
    ['wrong route', (p: any) => (p.assessment.context.medications[0].route = 'intravenous')],
    ['missing indication', (p: any) => (p.assessment.context.medications[0].indication = null)],
    ['unverified medication', (p: any) => (p.assessment.context.medications[0].verifiedAt = null)],
    ['future verification', (p: any) => (p.assessment.context.medications[0].verifiedAt = '2027-01-01T00:00:00Z')],
    ['missing call', (p: any) => (p.report.findings[0].reportedCall = null)],
    ['untested call', (p: any) => (p.report.findings[0].coverage = 'not-tested')],
    ['ambiguous resolved call', (p: any) => (p.report.findings[0].reportedCall.phase = 'unresolved')],
    ['unknown coverage', (p: any) => (p.report.findings[0].coverage = 'unknown')],
    ['unsupported interpretation', (p: any) => (p.report.findings[0].interpretationState = 'unsupported-definition')],
    ['empty limitation', (p: any) => (p.report.limitations = [''])],
    ['preliminary report', (p: any) => (p.report.status = 'preliminary')],
    [
      'missing amendment link',
      (p: any) => {
        p.report.status = 'amended';
        p.report.revision = 2;
      },
    ],
    [
      'self amendment',
      (p: any) => {
        p.report.status = 'amended';
        p.report.revision = 2;
        p.report.previousRevisionId = p.report.id;
      },
    ],
    ['first revision with predecessor', (p: any) => (p.report.previousRevisionId = 'syn-before')],
    ['date reversal', (p: any) => (p.report.issuedAt = '2026-10-01T00:00:00Z')],
    ['assessment before receipt', (p: any) => (p.assessment.generatedAt = '2026-11-01T00:00:00Z')],
  ])('refuses %s', (_name, mutate) => check(mutate));
  it.each(['no-recommendation', 'missing-prerequisites', 'outside-scope', 'retired', 'held-conflict'])('never allows prescribing wording for %s', (disposition) => {
    check((p) => {
      p.assessment.results[0].disposition = disposition;
      p.assessment.results[0].missingPrerequisites = ['Unresolved input'];
    });
  });
  it('preserves no-call, untested, unknown and absent target states without normal defaults', () => {
    for (const coverage of ['tested', 'not-tested', 'outside-coverage', 'unknown']) {
      const p = fixture();
      p.assessment = null;
      Object.assign(p.report.findings[0], {
        coverage,
        analyticalState: coverage === 'tested' ? 'no-call' : 'not-applicable',
        interpretationState: 'not-assessed',
        reportedCall: null,
        laboratoryInterpretation: null,
        limitations: ['No usable result.'],
      });
      expect(syntheticPgxPackageSchema.parse(p)).toEqual(p);
    }
    const p = fixture();
    p.assessment = null;
    p.report.findings = [];
    expect(syntheticPgxPackageSchema.parse(p).report.findings).toEqual([]);
  });
  it('keeps an unavailable manifest explicit and refuses an applicable assessment', () => {
    const p = fixture();
    p.report.assay = { state: 'unavailable', reason: 'Not supplied.' };
    expect(syntheticPgxPackageSchema.safeParse(p).success).toBe(false);
    p.assessment = null;
    p.report.findings[0].coverage = 'unknown';
    expect(syntheticPgxPackageSchema.parse(p)).toEqual(p);
  });
  it('allows a preliminary source to be stored without an assessment', () => {
    const p = fixture();
    p.report.status = 'preliminary';
    p.assessment = null;
    expect(syntheticPgxPackageSchema.parse(p)).toEqual(p);
  });
  it('accepts a standard-prescribing synthetic cell without conflating it with no recommendation', () => {
    const p = fixture();
    p.assessment.results[0].disposition = 'standard-prescribing';
    expect(syntheticPgxPackageSchema.parse(p).assessment?.results[0].disposition).toBe('standard-prescribing');
    p.assessment.results[0].disposition = 'no-recommendation';
    p.assessment.results[0].recommendationText = null;
    expect(syntheticPgxPackageSchema.parse(p).assessment?.results[0].disposition).toBe('no-recommendation');
  });
  it('refuses oversized input before JSON parsing, including UTF-8 expansion', () => {
    expect(() => parseSyntheticPgxPackage(' '.repeat(SYNTHETIC_PGX_MAX_BYTES + 1))).toThrow(/size/i);
    expect(() => parseSyntheticPgxPackage('é'.repeat(SYNTHETIC_PGX_MAX_BYTES / 2 + 1))).toThrow(/size/i);
    expect(() => parseSyntheticPgxPackage('{')).toThrow();
    check((p) => (p.report.limitations = ['x'.repeat(501)]));
    check((p) => (p.report.findings = Array.from({ length: 51 }, (_, i) => ({ ...p.report.findings[0], id: `syn-finding-${i}` }))));
  });
});

describe('typed evidence and joint synthetic rules', () => {
  it.each([
    { kind: 'allele', originalText: 'synthetic allele A', value: 'A', nomenclatureVersion: 'synthetic-1' },
    { kind: 'variant', originalText: 'synthetic variant A', reference: 'synthetic-reference', hgvs: 'synthetic-change', zygosity: 'synthetic-heterozygous' },
    { kind: 'activity', originalText: '10 synthetic units', value: 10, unit: 'synthetic units', method: 'synthetic-method', measuredAt: '2026-11-01T10:00:00Z' },
  ])('preserves a $kind call without requiring a diplotype', (call) => {
    const p = fixture();
    p.assessment = null;
    p.report.findings[0].reportedCall = call;
    if (call.kind === 'activity') p.report.assay.manifest.targets[0].variantClasses = ['activity'];
    expect(syntheticPgxPackageSchema.parse(p).report.findings[0].reportedCall).toEqual(call);
  });
  it('requires both targets for a joint cell, then accepts the complete independent pair', () => {
    const p = fixture();
    p.assessment.knowledge.rules[0].requiredTargetIds.push('syn-target-b');
    expect(syntheticPgxPackageSchema.safeParse(p).success).toBe(false);
    p.report.assay.manifest.targets.push({ ...p.report.assay.manifest.targets[0], id: 'syn-target-b', gene: 'GENEB' });
    p.report.findings.push({ ...p.report.findings[0], id: 'syn-finding-b', targetId: 'syn-target-b', gene: 'GENEB' });
    p.assessment.results[0].findingIds.push('syn-finding-b');
    expect(syntheticPgxPackageSchema.parse(p)).toEqual(p);
  });
  it('refuses a patient mismatch even when context and assessment agree with each other', () => {
    check((p) => {
      p.assessment.sourceReport.patientId = 'syn-other-patient';
      p.assessment.context.patientId = 'syn-other-patient';
    });
  });
  it.each(['ambiguous', 'no-call'])('cannot promote a structurally valid %s report into an applicable result', (state) => {
    const p = fixture('uncertain');
    if (state === 'no-call') Object.assign(p.report.findings[0], { analyticalState: 'no-call', reportedCall: null });
    expect(syntheticPgxPackageSchema.safeParse(p).success).toBe(true);
    Object.assign(p.assessment.results[0], { disposition: 'applicable', missingPrerequisites: [], recommendationText: 'Invalid invented recommendation.' });
    expect(syntheticPgxPackageSchema.safeParse(p).success).toBe(false);
  });
  it('rejects real gene names in this deliberately synthetic contract', () => {
    check((p) => {
      p.report.findings[0].gene = 'CYP2D6';
      p.report.assay.manifest.targets[0].gene = 'CYP2D6';
    });
  });
  it('preserves a no-call and its held result without inferred wording', () => {
    const p = fixture('uncertain');
    Object.assign(p.report.findings[0], { analyticalState: 'no-call', reportedCall: null, interpretationState: 'indeterminate' });
    expect(syntheticPgxPackageSchema.parse(p)).toEqual(p);
  });
});
