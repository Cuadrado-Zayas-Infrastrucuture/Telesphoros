import { describe, expect, it } from 'vitest';
import {
  CALLER_REASON_CODES,
  canonicalDiplotype,
  drugResultSchema,
  geneInputSchema,
  geneMapFileSchema,
  geneStateResultSchema,
  guidelineFileSchema,
  hasAtMostTwoDecimals,
  knowledgeFileSchema,
  OUTCOMES,
  REASON_CODES,
  REASON_MESSAGES,
  REASON_OUTCOME,
  REASON_PRECEDENCE,
  RETIRED_REASON_CODES,
  REVIEWER_ACTIONS,
  splitDiplotype,
  toHundredths,
} from './index';

const base = {
  schemaVersion: '1.2',
  synthetic: true,
  provenance: {
    source: 'SYNTHETIC TEST FIXTURE',
    sourceUrl: 'https://example.invalid/synthetic',
    retrievedAt: '2026-01-01',
    sourceVersion: 'test',
    license: 'proprietary',
    redistribution: 'restricted',
  },
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

const cell = (when: Record<string, string>, over: Record<string, unknown> = {}) => ({
  when,
  locator: { table: 'Table 1', row: 'Row', column: 'Column' },
  verification: { state: 'verified', verifiedBy: 'SYNTHETIC TEST', verifiedAt: '2026-01-02' },
  strength: 'Strong',
  recommendationText: 'Synthetic text.',
  ...over,
});

const guideline = () => ({
  ...base,
  id: 'drugx-genea',
  kind: 'guideline',
  guidelineVersion: '2024.1',
  title: 'Synthetic drugx guideline',
  drug: 'drugx',
  genes: ['GENEA'],
  supersedes: [] as string[],
  recommendations: [cell({ GENEA: 'Normal' })],
});

const combined = () => ({
  ...guideline(),
  id: 'drugx-genea-geneb',
  genes: ['GENEA', 'GENEB'],
  supersedes: ['drugx-genea'],
  recommendations: [cell({ GENEA: 'Normal', GENEB: 'Fast' }), cell({ GENEA: 'Normal', GENEB: 'Slow' })],
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

describe('vocabulary (frozen: see docs/design/outcomes-and-reason-codes.md)', () => {
  it('every reason code has an outcome, a plain meaning and a reviewer action entry, with no placeholder or value in any text', () => {
    for (const code of REASON_CODES) {
      expect(OUTCOMES).toContain(REASON_OUTCOME[code]);
      expect(REASON_MESSAGES[code]).toBeTruthy();
      expect(REASON_MESSAGES[code]).not.toMatch(/[{}$%]|\*\d/);
      expect(code in REVIEWER_ACTIONS, code).toBe(true);
      const action = REVIEWER_ACTIONS[code];
      if (action !== null) expect(action).not.toMatch(/[{}$%]/);
    }
  });

  it('the held and abstained codes are all in the precedence list, and nothing else is', () => {
    const needsPrecedence = REASON_CODES.filter((code) => REASON_OUTCOME[code] === 'held' || REASON_OUTCOME[code] === 'abstained');
    // out-of-review-scope and cell-disputed belong to a CELL, not to a gene, so they never compete with gene problems.
    const cellLevel = ['out-of-review-scope', 'cell-disputed'];
    expect([...REASON_PRECEDENCE].sort()).toEqual(needsPrecedence.filter((c) => !cellLevel.includes(c)).sort());
    expect(REASON_PRECEDENCE[REASON_PRECEDENCE.length - 1]).toBe('association-abstained'); // holds win over abstention
  });

  it('every retired 5A code maps to a current code, or to nothing if its feature was dropped', () => {
    for (const [oldCode, target] of Object.entries(RETIRED_REASON_CODES)) {
      expect(oldCode).toMatch(/^[A-Z_]+$/);
      if (target !== null) expect(REASON_CODES).toContain(target);
    }
    expect(Object.keys(RETIRED_REASON_CODES)).toHaveLength(11); // the whole 5A vocabulary, none forgotten
  });

  it('maps each retired 5A code to exactly the code the spec names (docs/design/outcomes-and-reason-codes.md)', () => {
    expect(RETIRED_REASON_CODES).toEqual({
      CONFLICTING_CALLS: 'duplicate-gene-conflict',
      GENE_NOT_IN_REPORT: 'gene-absent',
      NO_MATCHING_GUIDELINE: 'no-guideline-for-drug',
      PHENOTYPE_NOT_IN_GUIDELINE: 'no-published-recommendation',
      MALFORMED_DIPLOTYPE: 'malformed-diplotype',
      ALLELE_NOT_IN_DEFINITIONS: 'allele-not-in-definitions',
      NO_PHENOTYPE_MAPPING: 'no-phenotype-mapping',
      NO_GENE_DEFINITION: 'no-gene-definition',
      UNPHASED_VCF: null,
      STRUCTURAL_VARIANT: null,
      MULTIALLELIC_SITE: null,
    });
  });

  it('each reason code belongs to the outcome the spec gives it', () => {
    expect(REASON_OUTCOME).toEqual({
      'duplicate-gene-conflict': 'held',
      'duplicate-identical': 'held',
      'sentinel-literal-in-source': 'held',
      'other-gene-unresolved': 'held',
      'out-of-review-scope': 'held',
      'cell-disputed': 'held',
      'gene-absent': 'held',
      'malformed-diplotype': 'held',
      'allele-not-in-definitions': 'held',
      'no-phenotype-mapping': 'held',
      'no-gene-definition': 'held',
      'association-abstained': 'abstained',
      'no-published-recommendation': 'no-published-recommendation',
      'no-guideline-for-drug': 'no-guideline',
    });
  });

  it('a reviewer can only be pointed at "nothing to do" where nothing can be done', () => {
    expect(REVIEWER_ACTIONS['out-of-review-scope']).toBeNull();
    expect(REVIEWER_ACTIONS['no-guideline-for-drug']).toBeNull();
    expect(REVIEWER_ACTIONS['no-published-recommendation']).toBeNull();
    expect(REVIEWER_ACTIONS['gene-absent']).toBeTruthy();
  });

  it('the caller may attach only the four reasons the adapter can know (the amendment of 2026-10-08 added the two duplicate codes)', () => {
    expect([...CALLER_REASON_CODES].sort()).toEqual(['association-abstained', 'duplicate-gene-conflict', 'duplicate-identical', 'other-gene-unresolved']);
  });
});

describe('gene input', () => {
  it('accepts the four states', () => {
    for (const input of [
      { gene: 'GENEA', state: 'canonical', phenotype: 'Normal' },
      { gene: 'GENEA', state: 'diplotype', diplotype: '*1/*2' },
      { gene: 'GENEA', state: 'null' },
      { gene: 'GENEA', state: 'unresolved', reasonCode: 'other-gene-unresolved' },
    ])
      expect(geneInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
  });

  it('refuses a reason only the engine may decide, extra keys, missing values and lower-case genes', () => {
    for (const input of [
      { gene: 'GENEA', state: 'unresolved', reasonCode: 'gene-absent' },
      { gene: 'GENEA', state: 'unresolved', reasonCode: 'cell-disputed' },
      { gene: 'GENEA', state: 'unresolved' },
      { gene: 'GENEA', state: 'canonical' },
      { gene: 'GENEA', state: 'null', phenotype: 'Normal' },
      { gene: 'GENEA', state: 'canonical', phenotype: 'Normal', extra: 1 },
      { gene: 'genea', state: 'canonical', phenotype: 'Normal' },
      { gene: 'GENEA', state: 'absent' },
    ])
      expect(geneInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('accepts a call source on every state, and still accepts the same inputs without one (evaluations stored before the field existed)', () => {
    for (const input of [
      { gene: 'GENEA', state: 'canonical', phenotype: 'Normal' },
      { gene: 'GENEA', state: 'diplotype', diplotype: '*1/*2' },
      { gene: 'GENEA', state: 'null' },
      { gene: 'GENEA', state: 'unresolved', reasonCode: 'other-gene-unresolved' },
    ]) {
      expect(geneInputSchema.safeParse({ ...input, callSource: 'lab-report' }).success, JSON.stringify(input)).toBe(true);
      expect(geneInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });

  it('refuses a call source it does not know (an external caller is added deliberately, with its own slice), whatever the case or spelling', () => {
    for (const callSource of ['pharmcat', 'LAB-REPORT', 'lab_report', '', 'lab-report ', null, 1, ['lab-report']]) {
      expect(geneInputSchema.safeParse({ gene: 'GENEA', state: 'null', callSource }).success, JSON.stringify(callSource)).toBe(false);
    }
  });

  it('accepts any diplotype text up to 100 characters (including empty) so one bad value is reported per gene instead of aborting the whole report', () => {
    expect(geneInputSchema.safeParse({ gene: 'GENEA', state: 'diplotype', diplotype: '' }).success).toBe(true);
    expect(geneInputSchema.safeParse({ gene: 'GENEA', state: 'diplotype', diplotype: 'x'.repeat(100) }).success).toBe(true);
    expect(geneInputSchema.safeParse({ gene: 'GENEA', state: 'diplotype', diplotype: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('results', () => {
  const citation = { guidelineId: 'g', guidelineVersion: 'v', sourceUrl: 'https://example.invalid/x', locator: { table: 'T', row: 'R', column: null }, verification: 'verified' };
  const evidence = [{ gene: 'GENEA', state: 'canonical', phenotype: 'Normal', reasonCode: null }];
  const shown = { outcome: 'shown', drug: 'drugx', genes: ['GENEA'], geneStates: evidence, strength: 'Strong', citation, recommendationText: 'Text.', implication: null };

  it('a shown result carries its wording, strength and a full citation', () => {
    expect(drugResultSchema.safeParse(shown).success).toBe(true);
    for (const missing of ['citation', 'strength', 'recommendationText']) {
      const copy: Record<string, unknown> = { ...shown };
      delete copy[missing];
      expect(drugResultSchema.safeParse(copy).success, missing).toBe(false);
    }
  });

  it('a held or abstained result can NEVER carry guideline wording or strength', () => {
    const held = { outcome: 'held', drug: 'drugx', genes: ['GENEA'], geneStates: evidence, reasonCode: 'cell-disputed', citation };
    expect(drugResultSchema.safeParse(held).success).toBe(true);
    for (const extra of [{ recommendationText: 'Text.' }, { strength: 'Strong' }, { implication: 'x' }]) {
      expect(drugResultSchema.safeParse({ ...held, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    const abstained = { outcome: 'abstained', drug: 'drugx', genes: ['GENEA'], geneStates: evidence, reasonCode: 'association-abstained' };
    expect(drugResultSchema.safeParse(abstained).success).toBe(true);
    expect(drugResultSchema.safeParse({ ...abstained, citation }).success).toBe(false);
    expect(drugResultSchema.safeParse({ ...abstained, reasonCode: 'gene-absent' }).success).toBe(false);
  });

  it('the five outcomes accept only their own reason codes', () => {
    const noRec = {
      outcome: 'no-published-recommendation',
      drug: 'drugx',
      genes: ['GENEA'],
      geneStates: evidence,
      reasonCode: 'no-published-recommendation',
      citation: null,
      strength: null,
      recommendationText: null,
      implication: null,
    };
    expect(drugResultSchema.safeParse(noRec).success).toBe(true);
    expect(drugResultSchema.safeParse({ ...noRec, reasonCode: 'gene-absent' }).success).toBe(false);
    const none = { outcome: 'no-guideline', drug: 'drugz', genes: [], geneStates: [], reasonCode: 'no-guideline-for-drug' };
    expect(drugResultSchema.safeParse(none).success).toBe(true);
    expect(drugResultSchema.safeParse({ ...none, genes: ['GENEA'] }).success).toBe(false);
  });

  it('a gene state is either canonical with a phenotype, or one of three problems with a reason', () => {
    expect(geneStateResultSchema.safeParse({ gene: 'GENEA', state: 'canonical', phenotype: 'Normal', diplotype: null, activityScore: null, reasonCode: null }).success).toBe(true);
    expect(geneStateResultSchema.safeParse({ gene: 'GENEA', state: 'absent', phenotype: null, diplotype: null, activityScore: null, reasonCode: 'gene-absent' }).success).toBe(
      true,
    );
    expect(geneStateResultSchema.safeParse({ gene: 'GENEA', state: 'absent', phenotype: null, diplotype: null, activityScore: null, reasonCode: null }).success).toBe(false);
    expect(
      geneStateResultSchema.safeParse({ gene: 'GENEA', state: 'canonical', phenotype: 'Normal', diplotype: null, activityScore: null, reasonCode: 'gene-absent' }).success,
    ).toBe(false);
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
      issuesOf(
        geneMapFileSchema,
        table([
          { diplotype: '*1/*2', phenotype: 'Normal' },
          { diplotype: '*2/*1', phenotype: 'Poor' },
        ]),
      ).join('|'),
    ).toContain('more than once');
  });

  it('rejects activity values with more than two decimals and unknown keys', () => {
    const fine = functionPairMap();
    fine.alleles[0] = { ...fine.alleles[0]!, activityValue: 0.255 };
    expect(geneMapFileSchema.safeParse(fine).success).toBe(false);
    expect(geneMapFileSchema.safeParse({ ...functionPairMap(), surprise: true }).success).toBe(false);
  });
});

describe('gene map file: phenotype-only genes', () => {
  const phenotypeOnly = () => ({ ...base, id: 'genee', kind: 'gene-phenotype-map', gene: 'GENEE', phenotypes: ['Fast', 'Slow'] });

  it('a gene a lab reports as a phenotype needs no alleles or method', () => {
    expect(geneMapFileSchema.safeParse(phenotypeOnly()).success).toBe(true);
  });

  it('but alleles and method come together or not at all, and phenotypes must still be unique', () => {
    const onlyAlleles = { ...phenotypeOnly(), alleles: makeAlleles() };
    expect(issuesOf(geneMapFileSchema, onlyAlleles).join('|')).toContain('both alleles and method');
    const { alleles: _a, ...noAlleles } = functionPairMap();
    void _a;
    expect(issuesOf(geneMapFileSchema, noAlleles).join('|')).toContain('both alleles and method');
    expect(issuesOf(geneMapFileSchema, { ...phenotypeOnly(), phenotypes: ['Fast', 'Fast'] }).join('|')).toContain('unique');
  });
});

describe('guideline file', () => {
  it('accepts a single-gene guideline and a combined (multi-gene) one', () => {
    expect(guidelineFileSchema.safeParse(guideline()).success).toBe(true);
    expect(guidelineFileSchema.safeParse(combined()).success).toBe(true);
  });

  it('a cell must name a phenotype for exactly the guideline’s genes', () => {
    for (const when of [{}, { GENEA: 'Normal', GENEB: 'Fast' }, { GENEB: 'Fast' }] as Record<string, string>[]) {
      const file = guideline();
      file.recommendations = [cell(when)];
      expect(issuesOf(guidelineFileSchema, file).join('|'), JSON.stringify(when)).toContain('exactly this guideline');
    }
    const two = combined();
    two.recommendations = [cell({ GENEA: 'Normal' })];
    expect(issuesOf(guidelineFileSchema, two).join('|')).toContain('exactly this guideline');
  });

  it('refuses the same combination of phenotypes twice, however the keys are ordered', () => {
    const file = combined();
    file.recommendations = [cell({ GENEA: 'Normal', GENEB: 'Fast' }), cell({ GENEB: 'Fast', GENEA: 'Normal' })];
    expect(issuesOf(guidelineFileSchema, file).join('|')).toContain('more than once');
  });

  it('refuses duplicate genes, a guideline that supersedes itself, and duplicate superseded ids', () => {
    expect(issuesOf(guidelineFileSchema, { ...combined(), genes: ['GENEA', 'GENEA'] }).join('|')).toContain('Genes must be unique');
    expect(issuesOf(guidelineFileSchema, { ...combined(), supersedes: ['drugx-genea-geneb'] }).join('|')).toContain('supersede itself');
    expect(issuesOf(guidelineFileSchema, { ...combined(), supersedes: ['a', 'a'] }).join('|')).toContain('Ids must be unique');
  });

  it('every cell needs a locator and a verification state, and each state needs what it implies', () => {
    for (const missing of ['locator', 'verification', 'strength', 'recommendationText']) {
      const file = guideline();
      delete (file.recommendations[0] as Record<string, unknown>)[missing];
      expect(guidelineFileSchema.safeParse(file).success, missing).toBe(false);
    }
    const withState = (verification: unknown) => {
      const file = guideline();
      file.recommendations = [cell({ GENEA: 'Normal' }, { verification })];
      return guidelineFileSchema.safeParse(file).success;
    };
    expect(withState({ state: 'unverified' })).toBe(true);
    expect(withState({ state: 'verified', verifiedBy: 'A. Reviewer', verifiedAt: '2026-02-01' })).toBe(true);
    expect(withState({ state: 'disputed', note: 'Position differs between sources.' })).toBe(true);
    expect(withState({ state: 'verified' })).toBe(false); // who and when are required
    expect(withState({ state: 'disputed' })).toBe(false); // a dispute must say what is disputed
    expect(withState({ state: 'unverified', verifiedBy: 'A. Reviewer' })).toBe(false);
    expect(withState({ state: 'green' })).toBe(false);
    expect(withState(undefined)).toBe(false);
  });

  it('a locator may omit the column (single-gene table) but not the table or row', () => {
    const withLocator = (locator: unknown) => {
      const file = guideline();
      file.recommendations = [cell({ GENEA: 'Normal' }, { locator })];
      return guidelineFileSchema.safeParse(file).success;
    };
    expect(withLocator({ table: 'T', row: 'R' })).toBe(true);
    expect(withLocator({ table: 'T' })).toBe(false);
    expect(withLocator({ row: 'R' })).toBe(false);
  });

  it('refuses bad strengths and drug names, and keeps line breaks and tabs in wording but refuses other control characters', () => {
    const strength = guideline();
    (strength.recommendations[0] as { strength: string }).strength = 'Very strong';
    expect(guidelineFileSchema.safeParse(strength).success).toBe(false);
    for (const drug of ['Drugx', ' drugx', 'drugx ', 'drug_x', '']) {
      expect(guidelineFileSchema.safeParse({ ...guideline(), drug }).success, JSON.stringify(drug)).toBe(false);
    }
    const withBreaks = guideline();
    withBreaks.recommendations = [cell({ GENEA: 'Normal' }, { recommendationText: 'Line one.\n\tLine two.' })];
    expect(guidelineFileSchema.safeParse(withBreaks).success).toBe(true);
    const withEscape = guideline();
    withEscape.recommendations = [cell({ GENEA: 'Normal' }, { recommendationText: 'Bad \u001b[31m text' })];
    expect(guidelineFileSchema.safeParse(withEscape).success).toBe(false);
  });
});

describe('license and redistribution', () => {
  const signed = { status: 'reviewed', reviewedBy: 'A. Reviewer', reviewedAt: '2026-02-01', contentSha256: 'a'.repeat(64) } as const;
  const real = <T extends object>(file: T, provenance: Record<string, string> = {}) => ({
    ...file,
    synthetic: false,
    provenance: { ...base.provenance, ...provenance },
    review: signed,
  });
  const files = [
    ['guideline', guidelineFileSchema, guideline],
    ['gene map', geneMapFileSchema, functionPairMap],
  ] as const;

  it.each(files)('requires both fields on a %s, with no default', (_name, schema, make) => {
    for (const key of ['license', 'redistribution']) {
      // structuredClone: `make()` shares the `base.provenance` object, and deleting from it would leak into every later test
      const file = structuredClone(make()) as { provenance: Record<string, unknown> };
      delete file.provenance[key];
      expect(schema.safeParse(file).success, key).toBe(false);
    }
  });

  it.each(files)('accepts only the listed values on a %s', (_name, schema, make) => {
    expect(schema.safeParse({ ...make(), provenance: { ...base.provenance, license: 'MIT' } }).success).toBe(false);
    expect(schema.safeParse({ ...make(), provenance: { ...base.provenance, license: 'CC0-1.0' } }).success).toBe(false);
    expect(schema.safeParse({ ...make(), provenance: { ...base.provenance, redistribution: 'yes' } }).success).toBe(false);
    for (const license of ['cc0-1.0', 'cc-by-4.0', 'cc-by-sa-4.0', 'proprietary', 'unknown']) {
      expect(schema.safeParse({ ...make(), provenance: { ...base.provenance, license } }).success, license).toBe(true);
    }
  });

  it.each(files)('refuses a reviewed, non-synthetic %s whose license or redistribution is "unknown"', (_name, schema, make) => {
    // control: the same file with both stated is accepted
    expect(schema.safeParse(real(make(), { license: 'cc0-1.0', redistribution: 'allowed' })).success).toBe(true);
    for (const [field, message] of [
      ['license', 'must state its license'],
      ['redistribution', 'may be redistributed'],
    ] as const) {
      const result = schema.safeParse(real(make(), { license: 'cc0-1.0', redistribution: 'allowed', [field]: 'unknown' }));
      expect(result.success, field).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')).toContain(message);
        expect(result.error.issues.some((issue) => issue.path.join('.') === `provenance.${field}`)).toBe(true);
      }
    }
  });

  it.each(files)('still allows "unknown" on a draft or a synthetic %s', (_name, schema, make) => {
    const unknown = { license: 'unknown', redistribution: 'unknown' };
    expect(schema.safeParse({ ...make(), synthetic: false, provenance: { ...base.provenance, ...unknown } }).success).toBe(true); // unreviewed draft
    expect(schema.safeParse({ ...make(), provenance: { ...base.provenance, ...unknown }, review: signed }).success).toBe(true); // synthetic
  });

  it.each(files)('refuses the previous schema version on a %s', (_name, schema, make) => {
    expect(schema.safeParse({ ...make(), schemaVersion: '1.1' }).success).toBe(false);
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
