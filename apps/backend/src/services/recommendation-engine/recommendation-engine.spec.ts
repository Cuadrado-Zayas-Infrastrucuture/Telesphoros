import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CALLER_REASON_CODES,
  CPIC_STRENGTHS,
  type EvaluationResult,
  evaluationResultSchema,
  type GeneCall,
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

const called = (gene: string, diplotype: string): GeneCall => ({ gene, outcome: 'called', diplotype });
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

describe('evaluate: contract', () => {
  it('always returns a result that matches the published result schema, and names the knowledge it used', () => {
    const result = evaluate(knowledge, [called('GENEA', '*1/*3'), called('GENEB', '*1/*5')]);
    expect(evaluationResultSchema.safeParse(result).success).toBe(true);
    expect(result.knowledgeSetId).toBe(knowledge.id);
  });

  it('shares its strength vocabulary with the API types, so the two cannot drift apart', () => {
    expect([...CPIC_STRENGTHS]).toEqual([...RECOMMENDATION_STRENGTHS]);
  });

  it.each(CALLER_REASON_CODES)('passes the parser reason %s through unchanged', (reasonCode) => {
    const result = evaluate(knowledge, [{ gene: 'GENEA', outcome: 'indeterminate', reasonCode }], { drugs: ['drugw'] });
    expect(result.phenotypes).toEqual([{ status: 'indeterminate', gene: 'GENEA', reasonCode }]);
    expect(result.recommendations).toEqual([{ status: 'indeterminate', drug: 'drugw', gene: 'GENEA', reasonCode }]);
  });

  it.each([
    ['a lower-case gene', [{ gene: 'genea', outcome: 'called', diplotype: '*1/*1' }], {}],
    ['an unknown key', [{ gene: 'GENEA', outcome: 'called', diplotype: '*1/*1', extra: 1 }], {}],
    ['a reason only the engine may give', [{ gene: 'GENEA', outcome: 'indeterminate', reasonCode: 'NO_MATCHING_GUIDELINE' }], {}],
    ['a badly written drug name', [], { drugs: ['Not A Drug!'] }],
    ['too many calls', Array.from({ length: 201 }, () => called('GENEA', '*1/*1')), {}],
  ])('refuses %s with an error that repeats none of the input', (_name, calls, options) => {
    let thrown: unknown;
    try {
      evaluate(knowledge, calls as never, options as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineInputError);
    expect(String((thrown as Error).message)).not.toMatch(/genea|Not A Drug/i);
  });
});

describe('evaluate: it only ever repeats the guideline, and only for a determined phenotype', () => {
  // Exhaustive over the fixtures: every diplotype of every gene, written both ways round, plus junk.
  const genes = ['GENEA', 'GENEB', 'GENEC', 'GENED'];
  const diplotypes: string[] = [];
  for (let a = 1; a <= 5; a += 1) for (let b = 1; b <= 5; b += 1) diplotypes.push(`*${a}/*${b}`);
  diplotypes.push('*1', '*1|*2', '', '*9/*9', ' *1/*1');

  it('every recommendation matches an independent lookup in the guideline file, and nothing else is recommended', () => {
    let recommendations = 0;
    for (const gene of genes) {
      for (const diplotype of diplotypes) {
        const result = evaluate(knowledge, [called(gene, diplotype)]);
        const phenotype = result.phenotypes.find((p) => p.gene === gene)!;
        for (const rec of result.recommendations) {
          if (rec.status !== 'recommendation') continue;
          recommendations += 1;
          // Independent oracle: read the guideline straight from the loaded file.
          const guideline = knowledge.guidelinesForDrug(rec.drug).find((g) => g.gene === rec.gene)!;
          const row = guideline.recommendations.find((r) => r.phenotype === rec.phenotype)!;
          expect(row).toBeDefined();
          expect(rec.recommendationText).toBe(row.recommendationText);
          expect(rec.strength).toBe(row.strength);
          expect(rec.guidelineVersion).toBe(guideline.guidelineVersion);
          expect(rec.guidelineId).toBe(guideline.id);
          expect(rec.implication).toBe(row.implication ?? null);
          // ...and only for the gene that was called, with a determined phenotype.
          expect(rec.gene).toBe(gene);
          expect(phenotype.status).toBe('determined');
          expect(phenotype.status === 'determined' && phenotype.phenotype).toBe(rec.phenotype);
        }
      }
    }
    expect(recommendations).toBeGreaterThan(40); // the loop really exercised the happy path
  });

  it('never recommends anything for a gene that was not called or could not be called', () => {
    const none = evaluate(knowledge, []);
    expect(none.recommendations.every((r) => r.status === 'indeterminate')).toBe(true);
    const unphased = evaluate(knowledge, [{ gene: 'GENEA', outcome: 'indeterminate', reasonCode: 'UNPHASED_VCF' }]);
    expect(unphased.recommendations.filter((r) => r.status === 'recommendation' && r.gene === 'GENEA')).toEqual([]);
  });
});

describe('evaluate: determinism and purity', () => {
  const calls = [called('GENEC', '*2/*1'), called('GENEA', '*1/*3'), called('GENEB', '*2/*4')];

  it('gives identical output for identical input, in a fixed order', () => {
    const first = evaluate(knowledge, calls);
    for (let i = 0; i < 5; i += 1) expect(evaluate(knowledge, calls)).toEqual(first);
    expect(first.phenotypes.map((p) => p.gene)).toEqual(['GENEA', 'GENEB', 'GENEC']);
    expect(first.recommendations.map((r) => r.drug)).toEqual([...first.recommendations.map((r) => r.drug)].sort());
  });

  it('does not depend on the order of calls or of drugs, and a repeated drug is evaluated once', () => {
    const forward = evaluate(knowledge, calls, { drugs: ['drugx', 'drugy'] });
    expect(evaluate(knowledge, [...calls].reverse(), { drugs: ['drugy', 'drugx', 'drugx'] })).toEqual(forward);
  });

  it('does not change its inputs', () => {
    const frozenCalls = deepFreeze(structuredClone(calls));
    const frozenOptions = deepFreeze({ drugs: ['drugx'] });
    const before = JSON.stringify(knowledge.guidelinesForDrug('drugx'));
    expect(() => evaluate(knowledge, frozenCalls, frozenOptions)).not.toThrow();
    expect(JSON.stringify(knowledge.guidelinesForDrug('drugx'))).toBe(before);
  });

  it('an empty drug list means "no drugs", not "all drugs"', () => {
    expect(evaluate(knowledge, calls, { drugs: [] }).recommendations).toEqual([]);
    expect(evaluate(knowledge, calls).recommendations.length).toBeGreaterThan(0);
  });
});

describe('evaluate: privacy', () => {
  it('never copies a value from the report into an indeterminate result', () => {
    const result = evaluate(knowledge, [called('GENEA', '*SECRET-ONE/*1'), called('GENEC', '*SECRET-TWO|*1')]);
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

  it('says so for a requested drug, and invents nothing', () => {
    const result: EvaluationResult = evaluate(empty, [called('GENEA', '*1/*1')], { drugs: ['drugx'] });
    expect(result.phenotypes).toEqual([{ status: 'indeterminate', gene: 'GENEA', reasonCode: 'NO_GENE_DEFINITION' }]);
    expect(result.recommendations).toEqual([{ status: 'indeterminate', drug: 'drugx', gene: null, reasonCode: 'NO_MATCHING_GUIDELINE' }]);
  });
  it('has nothing to evaluate when no drug is named', () => {
    expect(evaluate(empty, [called('GENEA', '*1/*1')]).recommendations).toEqual([]);
  });
});
