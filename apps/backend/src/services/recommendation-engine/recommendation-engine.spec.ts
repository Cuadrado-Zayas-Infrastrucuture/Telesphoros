import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CPIC_STRENGTHS,
  type DrugResult,
  type EvaluationResult,
  evaluationResultSchema,
  type GeneInput,
  REASON_OUTCOME,
} from '@telesphoros/cpic-schema';
import { RECOMMENDATION_STRENGTHS } from '@telesphoros/shared-types';
import { loadKnowledge } from '../knowledge/knowledge-loader';
import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { cleanupTempDirs, SYNTHETIC_DIR, tempDir } from '../../../test/helpers/knowledge';
import { EngineInputError, evaluate } from './recommendation-engine';

let knowledge: KnowledgeSet;
beforeAll(async () => {
  knowledge = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: 'non-production' });
});
afterAll(cleanupTempDirs);

const canonical = (gene: string, phenotype: string): GeneInput => ({ gene, state: 'canonical', phenotype });
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

describe('evaluate: contract', () => {
  it('always returns a result that matches the published result schema, and names the knowledge it used', () => {
    const result = evaluate(knowledge, [canonical('GENEA', 'Synthetic Normal'), canonical('GENEE', 'Synthetic Fast')]);
    expect(evaluationResultSchema.safeParse(result).success).toBe(true);
    expect(result.knowledgeSetId).toBe(knowledge.id);
  });

  it('shares its strength vocabulary with the API types, so the two cannot drift apart', () => {
    expect([...CPIC_STRENGTHS]).toEqual([...RECOMMENDATION_STRENGTHS]);
  });

  it.each([
    ['a lower-case gene', [{ gene: 'genea', state: 'canonical', phenotype: 'x' }], {}],
    ['an unknown state', [{ gene: 'GENEA', state: 'absent' }], {}],
    ['an unknown key', [{ gene: 'GENEA', state: 'null', extra: 1 }], {}],
    ['a reason only the engine may give', [{ gene: 'GENEA', state: 'unresolved', reasonCode: 'gene-absent' }], {}],
    ['a badly written drug name', [], { drugs: ['Not A Drug!'] }],
    ['too many inputs', Array.from({ length: 201 }, () => canonical('GENEA', 'x')), {}],
  ])('refuses %s with an error that repeats none of the input', (_name, inputs, options) => {
    let thrown: unknown;
    try {
      evaluate(knowledge, inputs as never, options as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineInputError);
    expect(String((thrown as Error).message)).not.toMatch(/genea|Not A Drug/i);
  });
});

describe('evaluate: what may be shown, checked over EVERY combination of states for the combined table’s genes', () => {
  // Every way GENEA and GENEE can arrive, including the ways that must never produce a recommendation.
  const forGene = (gene: string, phenotypes: string[], diplotype?: string): GeneInput[][] => [
    [], // absent
    ...phenotypes.map((phenotype) => [canonical(gene, phenotype)]),
    [canonical(gene, 'Not A Canonical Term')],
    [{ gene, state: 'null' }],
    [{ gene, state: 'unresolved', reasonCode: 'other-gene-unresolved' }],
    [{ gene, state: 'unresolved', reasonCode: 'association-abstained' }],
    [canonical(gene, phenotypes[0]!), canonical(gene, phenotypes[0]!)], // duplicate, identical
    [canonical(gene, phenotypes[0]!), canonical(gene, phenotypes[1]!)], // duplicate, different
    ...(diplotype ? [[{ gene, state: 'diplotype', diplotype } as GeneInput], [{ gene, state: 'diplotype', diplotype: '*9/*9' } as GeneInput]] : []),
  ];
  const geneA = forGene('GENEA', ['Synthetic Normal', 'Synthetic Intermediate', 'Synthetic Poor'], '*1/*3');
  const geneE = forGene('GENEE', ['Synthetic Fast', 'Synthetic Slow']);
  let allWording: string[];
  let all: { inputs: GeneInput[]; result: EvaluationResult }[];
  let results: DrugResult[];
  beforeAll(() => {
    allWording = knowledge.drugs().flatMap((drug) =>
      knowledge.guidelinesForDrug(drug).flatMap((guideline) => guideline.recommendations.flatMap((row) => [row.recommendationText, ...(row.implication ? [row.implication] : [])])),
    );
    all = [];
    for (const a of geneA) for (const e of geneE) {
      const inputs = [...a, ...e];
      all.push({ inputs, result: evaluate(knowledge, inputs) });
    }
    results = all.flatMap(({ result }) => result.results);
  });

  it('the sweep is large enough to mean something, and reaches every outcome', () => {
    expect(all.length).toBeGreaterThan(100);
    const floors = { shown: 20, held: 100, abstained: 5, 'no-published-recommendation': 2 } as const;
    for (const [outcome, floor] of Object.entries(floors)) {
      expect(results.filter((r) => r.outcome === outcome).length).toBeGreaterThanOrEqual(floor);
    }
    expect(all.every(({ result }) => evaluationResultSchema.safeParse(result).success)).toBe(true);
  });

  it('a result is shown only for a verified cell found by an independent lookup, with every gene canonical', () => {
    const shown = results.filter((r): r is Extract<DrugResult, { outcome: 'shown' }> => r.outcome === 'shown');
    expect(shown.length).toBeGreaterThan(20);
    for (const result of shown) {
      const guideline = knowledge.guidelinesForDrug(result.drug).find((g) => g.id === result.citation.guidelineId)!;
      const row = guideline.recommendations.find((candidate) => result.geneStates.every((gene) => candidate.when[gene.gene] === gene.phenotype))!;
      expect(row).toBeDefined();
      expect(row.verification.state).toBe('verified');
      expect(result.citation.verification).toBe('verified');
      expect(result.recommendationText).toBe(row.recommendationText);
      expect(result.strength).toBe(row.strength);
      expect(row.strength).not.toBe('No recommendation');
      expect(result.citation.locator).toEqual({ table: row.locator.table, row: row.locator.row, column: row.locator.column ?? null });
      expect(result.geneStates.every((gene) => gene.state === 'canonical')).toBe(true);
    }
  });

  it('whenever any gene behind a result is not a clean canonical phenotype, the result is never shown or "no published recommendation"', () => {
    for (const result of results) {
      if (result.outcome === 'no-guideline') continue;
      if (result.geneStates.some((gene) => gene.state !== 'canonical')) {
        expect(['held', 'abstained']).toContain(result.outcome);
      }
    }
  });

  it('the wording of a held, abstained or unverified-cell result never appears anywhere in it', () => {
    for (const result of results) {
      if (result.outcome !== 'held' && result.outcome !== 'abstained') continue;
      const text = JSON.stringify(result);
      for (const wording of allWording) expect(text.includes(wording)).toBe(false);
    }
    // ...including the cells that exist but are not verified.
    const heldWithCell = results.filter((r): r is Extract<DrugResult, { outcome: 'held' }> => r.outcome === 'held' && r.citation !== null);
    expect(heldWithCell.some((r) => r.reasonCode === 'out-of-review-scope')).toBe(true);
    expect(heldWithCell.some((r) => r.reasonCode === 'cell-disputed')).toBe(true);
  });

  it('every non-shown result carries a reason whose outcome is the one it reports', () => {
    for (const result of results) {
      if (result.outcome === 'shown') continue;
      expect(REASON_OUTCOME[result.reasonCode]).toBe(result.outcome);
    }
  });

  it('a table replaced by a combined one is never shown on its own, whatever the genes do', () => {
    const drugv = results.filter((r) => r.drug === 'drugv');
    expect(drugv.length).toBe(all.length); // exactly one result per evaluation
    for (const result of drugv) {
      expect(result.genes).toEqual(['GENEA', 'GENEE']);
      if (result.outcome === 'shown' || result.outcome === 'held' || result.outcome === 'no-published-recommendation') {
        expect(result.citation?.guidelineId ?? 'drugv-genea-genee').toBe('drugv-genea-genee');
      }
    }
  });
});

describe('evaluate: determinism and purity', () => {
  const inputs: GeneInput[] = [canonical('GENEC', 'Synthetic Alpha'), canonical('GENEA', 'Synthetic Intermediate'), { gene: 'GENEB', state: 'diplotype', diplotype: '*2/*4' }];

  it('gives identical output for identical input, in a fixed order', () => {
    const first = evaluate(knowledge, inputs);
    for (let i = 0; i < 5; i += 1) expect(evaluate(knowledge, inputs)).toEqual(first);
    expect(first.geneStates.map((g) => g.gene)).toEqual([...first.geneStates.map((g) => g.gene)].sort());
    expect(first.results.map((r) => r.drug)).toEqual([...first.results.map((r) => r.drug)].sort());
  });

  it('does not depend on the order of inputs or of drugs, and a repeated drug is evaluated once', () => {
    const forward = evaluate(knowledge, inputs, { drugs: ['drugx', 'drugy'] });
    expect(evaluate(knowledge, [...inputs].reverse(), { drugs: ['drugy', 'drugx', 'drugx'] })).toEqual(forward);
  });

  it('does not change its inputs or the knowledge', () => {
    const frozen = deepFreeze(structuredClone(inputs));
    const before = JSON.stringify(knowledge.guidelinesForDrug('drugv'));
    expect(() => evaluate(knowledge, frozen, deepFreeze({ drugs: ['drugx', 'drugv'] }))).not.toThrow();
    expect(JSON.stringify(knowledge.guidelinesForDrug('drugv'))).toBe(before);
  });

  it('an empty drug list means "no drugs", not "all drugs"', () => {
    expect(evaluate(knowledge, inputs, { drugs: [] }).results).toEqual([]);
    expect(evaluate(knowledge, inputs).results.length).toBeGreaterThan(0);
  });
});

describe('evaluate: privacy', () => {
  it('never copies a value from the report into a result', () => {
    const result = evaluate(knowledge, [
      canonical('GENEA', 'SECRET-PHENOTYPE'),
      { gene: 'GENEC', state: 'diplotype', diplotype: '*SECRET-ONE|*1' },
      { gene: 'GENEB', state: 'diplotype', diplotype: '*SECRET-TWO/*1' },
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('evaluate: when no guidelines are loaded', () => {
  let empty: KnowledgeSet;
  beforeAll(async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'guidelines'));
    await writeFile(join(dir, 'guidelines/.gitkeep'), '');
    empty = await loadKnowledge({ directory: dir, mode: 'production' });
  });

  it('says so for a requested drug, and cannot interpret any gene', () => {
    const result = evaluate(empty, [canonical('GENEA', 'Synthetic Normal')], { drugs: ['drugx'] });
    expect(result.geneStates).toEqual([{ gene: 'GENEA', state: 'unresolved', phenotype: null, diplotype: null, activityScore: null, reasonCode: 'no-gene-definition' }]);
    expect(result.results).toEqual([{ outcome: 'no-guideline', drug: 'drugx', genes: [], geneStates: [], reasonCode: 'no-guideline-for-drug' }]);
  });

  it('has nothing to evaluate when no drug is named', () => {
    expect(evaluate(empty, [canonical('GENEA', 'Synthetic Normal')]).results).toEqual([]);
  });
});
