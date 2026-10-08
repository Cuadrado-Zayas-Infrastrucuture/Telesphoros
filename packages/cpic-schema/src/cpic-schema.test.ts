import { describe, expect, it } from 'vitest';
import {
  canonicalDiplotype,
  CALLER_REASON_CODES,
  geneCallSchema,
  geneMapFileSchema,
  guidelineFileSchema,
  hasAtMostTwoDecimals,
  INDETERMINATE_REASON_CODES,
  knowledgeFileSchema,
  REASON_MESSAGES,
  splitDiplotype,
  toHundredths,
} from './index';

const base = {
  schemaVersion: '1.0',
  synthetic: true,
  provenance: { source: 'SYNTHETIC TEST FIXTURE', sourceUrl: 'https://example.invalid/synthetic', retrievedAt: '2026-01-01', sourceVersion: 'test' },
  review: { status: 'unreviewed' },
} as const;

const makeAlleles = () => [
  { name: '*1', function: 'Normal function', activityValue: 1 },
  { name: '*2', function: 'No function', activityValue: 0 },
  { name: '*3', function: 'Decreased function', activityValue: 0.5 },
];

const functionPairMap = () => ({
  ...base,
  id: 'genea',
  kind: 'gene-phenotype-map',
  gene: 'GENEA',
  alleles: makeAlleles(),
  phenotypes: ['Normal', 'Intermediate', 'Poor'],
  method: {
    type: 'function-pair',
    rows: [
      { functions: ['Normal function', 'Normal function'], phenotype: 'Normal' },
      { functions: ['Normal function', 'No function'], phenotype: 'Intermediate' },
      { functions: ['No function', 'No function'], phenotype: 'Poor' },
    ],
  },
});

const activityMap = (ranges: unknown[]) => ({
  ...functionPairMap(),
  id: 'geneb',
  gene: 'GENEB',
  phenotypes: ['Low', 'High'],
  method: { type: 'activity-score', ranges },
});

const guideline = () => ({
  ...base,
  id: 'drugx-genea',
  kind: 'guideline',
  guidelineVersion: '2024.1',
  title: 'Synthetic drugx guideline',
  drug: 'drugx',
  gene: 'GENEA',
  recommendations: [{ phenotype: 'Normal', strength: 'Strong', recommendationText: 'Synthetic text.' }],
});

const issuesOf = (schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } } }, value: unknown) =>
  schema.safeParse(value).error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];

describe('diplotype helpers', () => {
  it('splits only "a/b"', () => {
    expect(splitDiplotype('*1/*2')).toEqual(['*1', '*2']);
    for (const bad of ['', '*1', '*1/', '/*2', '*1/*2/*3', '*1|*2', ' *1/*2', '*1/*2 ', '*1 /*2']) {
      expect(splitDiplotype(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
  it('gives one spelling regardless of order, and rejects unknown alleles', () => {
    expect(canonicalDiplotype(['*1', '*2', '*3'], '*3/*1')).toBe('*1/*3');
    expect(canonicalDiplotype(['*1', '*2', '*3'], '*1/*3')).toBe('*1/*3');
    expect(canonicalDiplotype(['*1', '*2', '*3'], '*1/*9')).toBeUndefined();
  });
  it('compares activity scores in whole hundredths', () => {
    expect(toHundredths(0.1) + toHundredths(0.2)).toBe(toHundredths(0.3));
    expect(hasAtMostTwoDecimals(0.25)).toBe(true);
    expect(hasAtMostTwoDecimals(0.255)).toBe(false);
    expect(hasAtMostTwoDecimals(Number.NaN)).toBe(false);
  });
});

describe('reason codes', () => {
  it('has a fixed message for every code, and none contains a placeholder or value', () => {
    for (const code of INDETERMINATE_REASON_CODES) {
      expect(REASON_MESSAGES[code], code).toBeTruthy();
      expect(REASON_MESSAGES[code]).not.toMatch(/[{}$%]|\*\d/);
    }
  });
  it('caller codes are a subset of all codes', () => {
    for (const code of CALLER_REASON_CODES) expect(INDETERMINATE_REASON_CODES).toContain(code);
  });
});

describe('gene call', () => {
  it('accepts a called diplotype and a caller-supplied reason', () => {
    expect(geneCallSchema.safeParse({ gene: 'GENEA', outcome: 'called', diplotype: '*1/*2' }).success).toBe(true);
    expect(geneCallSchema.safeParse({ gene: 'GENEA', outcome: 'indeterminate', reasonCode: 'UNPHASED_VCF' }).success).toBe(true);
  });
  it('refuses a reason only the engine may decide, extra keys, and a called gene with no diplotype', () => {
    expect(geneCallSchema.safeParse({ gene: 'GENEA', outcome: 'indeterminate', reasonCode: 'NO_MATCHING_GUIDELINE' }).success).toBe(false);
    expect(geneCallSchema.safeParse({ gene: 'GENEA', outcome: 'called', diplotype: '*1/*2', extra: 1 }).success).toBe(false);
    expect(geneCallSchema.safeParse({ gene: 'GENEA', outcome: 'called' }).success).toBe(false);
    expect(geneCallSchema.safeParse({ gene: 'genea', outcome: 'called', diplotype: '*1/*2' }).success).toBe(false);
  });
});

describe('gene map file', () => {
  it('accepts a valid function-pair map and a valid activity-score map', () => {
    expect(geneMapFileSchema.safeParse(functionPairMap()).success).toBe(true);
    expect(
      geneMapFileSchema.safeParse(
        activityMap([
          { min: 0, minInclusive: true, max: 0.5, maxInclusive: false, phenotype: 'Low' },
          { min: 0.5, minInclusive: true, max: 2, maxInclusive: true, phenotype: 'High' },
        ]),
      ).success,
    ).toBe(true);
  });

  it('rejects overlapping activity ranges, including a shared edge both ranges include', () => {
    const both = activityMap([
      { min: 0, minInclusive: true, max: 0.5, maxInclusive: true, phenotype: 'Low' },
      { min: 0.5, minInclusive: true, max: 2, maxInclusive: true, phenotype: 'High' },
    ]);
    expect(issuesOf(geneMapFileSchema, both).join('|')).toContain('overlaps');
    const contained = activityMap([
      { min: 0, minInclusive: true, max: 2, maxInclusive: true, phenotype: 'Low' },
      { min: 0.5, minInclusive: true, max: 1, maxInclusive: true, phenotype: 'High' },
    ]);
    expect(issuesOf(geneMapFileSchema, contained).join('|')).toContain('overlaps');
  });

  it('rejects an empty range and a missing activity value', () => {
    expect(issuesOf(geneMapFileSchema, activityMap([{ min: 1, minInclusive: false, max: 1, maxInclusive: true, phenotype: 'Low' }])).join('|')).toContain('empty');
    const noValue = activityMap([{ min: 0, minInclusive: true, max: 2, maxInclusive: true, phenotype: 'Low' }]);
    delete (noValue.alleles[1] as { activityValue?: number }).activityValue;
    expect(issuesOf(geneMapFileSchema, noValue).join('|')).toContain('activityValue');
  });

  it('rejects a phenotype outside the declared list, unknown functions and duplicate rows', () => {
    const wrongPhenotype = functionPairMap();
    wrongPhenotype.method.rows[0]!.phenotype = 'Ultra';
    expect(issuesOf(geneMapFileSchema, wrongPhenotype).join('|')).toContain('not in the phenotypes list');

    const wrongFunction = functionPairMap();
    wrongFunction.method.rows[0]!.functions = ['Normal function', 'Imaginary function'];
    expect(issuesOf(geneMapFileSchema, wrongFunction).join('|')).toContain('No allele has this function');

    const duplicate = functionPairMap();
    duplicate.method.rows.push({ functions: ['No function', 'Normal function'], phenotype: 'Poor' });
    expect(issuesOf(geneMapFileSchema, duplicate).join('|')).toContain('more than once');
  });

  it('rejects duplicate alleles and a diplotype-table with unknown or repeated diplotypes', () => {
    const duplicateAllele = functionPairMap();
    duplicateAllele.alleles.push({ ...duplicateAllele.alleles[0]! });
    expect(issuesOf(geneMapFileSchema, duplicateAllele).join('|')).toContain('unique');

    const table = (rows: unknown[]) => ({ ...functionPairMap(), method: { type: 'diplotype-table', rows } });
    expect(geneMapFileSchema.safeParse(table([{ diplotype: '*1/*2', phenotype: 'Normal' }])).success).toBe(true);
    expect(issuesOf(geneMapFileSchema, table([{ diplotype: '*1/*9', phenotype: 'Normal' }])).join('|')).toContain('two known alleles');
    expect(
      issuesOf(geneMapFileSchema, table([{ diplotype: '*1/*2', phenotype: 'Normal' }, { diplotype: '*2/*1', phenotype: 'Poor' }])).join('|'),
    ).toContain('more than once');
  });

  it('rejects activity values with more than two decimals and unknown keys', () => {
    const fine = functionPairMap();
    fine.alleles[0] = { ...fine.alleles[0]!, activityValue: 0.255 };
    expect(geneMapFileSchema.safeParse(fine).success).toBe(false);
    expect(geneMapFileSchema.safeParse({ ...functionPairMap(), surprise: true }).success).toBe(false);
  });
});

describe('guideline file', () => {
  it('accepts a valid guideline and refuses duplicates, bad strengths and bad drug names', () => {
    expect(guidelineFileSchema.safeParse(guideline()).success).toBe(true);
    const twice = guideline();
    twice.recommendations.push({ ...twice.recommendations[0]! });
    expect(issuesOf(guidelineFileSchema, twice).join('|')).toContain('more than once');
    const strength = guideline();
    (strength.recommendations[0] as { strength: string }).strength = 'Very strong';
    expect(guidelineFileSchema.safeParse(strength).success).toBe(false);
    for (const drug of ['Drugx', ' drugx', 'drugx ', 'drug_x', '']) {
      expect(guidelineFileSchema.safeParse({ ...guideline(), drug }).success, JSON.stringify(drug)).toBe(false);
    }
  });
  it('refuses control characters in guideline text but keeps line breaks and tabs', () => {
    const withBreaks = guideline();
    withBreaks.recommendations[0]!.recommendationText = 'Line one.\n\tLine two.';
    expect(guidelineFileSchema.safeParse(withBreaks).success).toBe(true);
    const withEscape = guideline();
    withEscape.recommendations[0]!.recommendationText = 'Bad \u001b[31m text';
    expect(guidelineFileSchema.safeParse(withEscape).success).toBe(false);
  });
});

describe('envelope', () => {
  it('requires an https source, a real date and the current schema version', () => {
    expect(guidelineFileSchema.safeParse({ ...guideline(), provenance: { ...base.provenance, sourceUrl: 'http://example.invalid/x' } }).success).toBe(false);
    expect(guidelineFileSchema.safeParse({ ...guideline(), provenance: { ...base.provenance, retrievedAt: '2026-13-40' } }).success).toBe(false);
    expect(guidelineFileSchema.safeParse({ ...guideline(), schemaVersion: '2.0' }).success).toBe(false);
  });
  it('every envelope field is required: a missing flag must not fall back to a default', () => {
    for (const key of ['schemaVersion', 'id', 'synthetic', 'provenance', 'review']) {
      const file = guideline() as Record<string, unknown>;
      delete file[key];
      expect(guidelineFileSchema.safeParse(file).success, key).toBe(false);
      const map = functionPairMap() as Record<string, unknown>;
      delete map[key];
      expect(geneMapFileSchema.safeParse(map).success, key).toBe(false);
    }
  });
  it('a reviewed file must say who, when, and carry a content hash', () => {
    const reviewed = { ...guideline(), review: { status: 'reviewed', reviewedBy: 'A. Reviewer', reviewedAt: '2026-02-01', contentSha256: 'a'.repeat(64) } };
    expect(guidelineFileSchema.safeParse(reviewed).success).toBe(true);
    expect(guidelineFileSchema.safeParse({ ...reviewed, review: { status: 'reviewed' } }).success).toBe(false);
    expect(guidelineFileSchema.safeParse({ ...reviewed, review: { ...reviewed.review, contentSha256: 'xyz' } }).success).toBe(false);
  });
  it('dispatches on kind', () => {
    expect(knowledgeFileSchema.safeParse(guideline()).success).toBe(true);
    expect(knowledgeFileSchema.safeParse(functionPairMap()).success).toBe(true);
    expect(knowledgeFileSchema.safeParse({ ...guideline(), kind: 'other' }).success).toBe(false);
  });
});

describe('gene call: diplotype text', () => {
  it('accepts any text up to 100 characters (including empty) so one bad value is reported per gene instead of aborting the whole report', () => {
    expect(geneCallSchema.safeParse({ gene: 'GENEA', outcome: 'called', diplotype: '' }).success).toBe(true);
    expect(geneCallSchema.safeParse({ gene: 'GENEA', outcome: 'called', diplotype: 'x'.repeat(100) }).success).toBe(true);
    expect(geneCallSchema.safeParse({ gene: 'GENEA', outcome: 'called', diplotype: 'x'.repeat(101) }).success).toBe(false);
  });
});
