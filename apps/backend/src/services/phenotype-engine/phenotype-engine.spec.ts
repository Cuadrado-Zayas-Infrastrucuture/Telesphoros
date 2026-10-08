import { mapPhenotype } from './phenotype-engine';
import { loadKnowledge } from '../knowledge/knowledge-loader';
import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { SYNTHETIC_DIR } from '../../../test/helpers/knowledge';

let knowledge: KnowledgeSet;
beforeAll(async () => {
  knowledge = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: 'non-production' });
});
const map = (gene: string) => knowledge.gene(gene)!;

describe('mapPhenotype: function-pair', () => {
  it.each([
    ['*1/*1', 'Synthetic Normal'],
    ['*1/*3', 'Synthetic Intermediate'],
    ['*3/*1', 'Synthetic Intermediate'],
    ['*1/*2', 'Synthetic Intermediate'],
    ['*3/*3', 'Synthetic Intermediate'],
    ['*3/*2', 'Synthetic Poor'],
    ['*2/*2', 'Synthetic Poor'],
  ])('%s -> %s', (diplotype, phenotype) => {
    const result = mapPhenotype(map('GENEA'), diplotype);
    expect(result).toMatchObject({ status: 'determined', gene: 'GENEA', phenotype, activityScore: null });
  });

  it('returns the canonical spelling', () => {
    expect(mapPhenotype(map('GENEA'), '*3/*1')).toMatchObject({ diplotype: '*1/*3' });
  });
});

describe('mapPhenotype: activity score', () => {
  it.each([
    ['*3/*3', 0, 'Synthetic Low'],
    ['*3/*4', 0.25, 'Synthetic Low'],
    ['*4/*4', 0.5, 'Synthetic Low'], // 0.25 + 0.25: exact edge, inclusive
    ['*2/*3', 0.5, 'Synthetic Low'],
    ['*2/*4', 0.75, 'Synthetic Medium'],
    ['*2/*2', 1, 'Synthetic Medium'],
    ['*1/*2', 1.5, 'Synthetic Medium'],
    ['*1/*1', 2, 'Synthetic High'],
  ])('%s scores %s -> %s', (diplotype, activityScore, phenotype) => {
    expect(mapPhenotype(map('GENEB'), diplotype)).toMatchObject({ status: 'determined', phenotype, activityScore });
  });

  it('a score in the gap between ranges has no phenotype', () => {
    expect(mapPhenotype(map('GENEB'), '*1/*5')).toEqual({ status: 'indeterminate', gene: 'GENEB', reasonCode: 'NO_PHENOTYPE_MAPPING' });
  });

  it('is exact where floating point would not be: 0.1 + 0.2 is 0.3', () => {
    const base = map('GENEB');
    const custom = {
      ...base,
      alleles: [
        { name: '*1', function: 'Normal function', activityValue: 0.1 },
        { name: '*2', function: 'Normal function', activityValue: 0.2 },
      ],
      phenotypes: ['Exactly point three'],
      method: { type: 'activity-score' as const, ranges: [{ min: 0.3, minInclusive: true, max: 0.3, maxInclusive: true, phenotype: 'Exactly point three' }] },
    };
    expect(mapPhenotype(custom, '*1/*2')).toMatchObject({ status: 'determined', phenotype: 'Exactly point three', activityScore: 0.3 });
  });
});

describe('mapPhenotype: activity-score edges do not depend on the order of the ranges', () => {
  const custom = (ranges: { min: number; minInclusive: boolean; max: number; maxInclusive: boolean; phenotype: string }[]) => ({
    ...map('GENEB'),
    alleles: [
      { name: '*1', function: 'f', activityValue: 0.5 },
      { name: '*2', function: 'f', activityValue: 0.25 },
      { name: '*3', function: 'f', activityValue: 0.29 },
      { name: '*4', function: 'f', activityValue: 0 },
    ],
    phenotypes: ['Lower', 'Upper'],
    method: { type: 'activity-score' as const, ranges },
  });
  const lower = { min: 0, minInclusive: true, max: 1, maxInclusive: true, phenotype: 'Lower' };
  const upper = { min: 1, minInclusive: false, max: 2, maxInclusive: true, phenotype: 'Upper' };

  it('an exclusive lower bound excludes the edge score, whichever range is listed first', () => {
    for (const ranges of [[lower, upper], [upper, lower]]) {
      expect(mapPhenotype(custom(ranges), '*1/*1')).toMatchObject({ phenotype: 'Lower', activityScore: 1 });
    }
    // Only the exclusive range exists: the edge itself is in no range.
    expect(mapPhenotype(custom([upper]), '*1/*1')).toMatchObject({ status: 'indeterminate', reasonCode: 'NO_PHENOTYPE_MAPPING' });
  });

  it('an exclusive upper bound excludes the edge score', () => {
    const below = { min: 0, minInclusive: true, max: 1, maxInclusive: false, phenotype: 'Lower' };
    expect(mapPhenotype(custom([below]), '*1/*1')).toMatchObject({ status: 'indeterminate', reasonCode: 'NO_PHENOTYPE_MAPPING' });
    expect(mapPhenotype(custom([below]), '*2/*2')).toMatchObject({ phenotype: 'Lower', activityScore: 0.5 });
  });

  it('adds values that floating point gets wrong (0 + 0.29 is 28.999999999999996 when multiplied by 100)', () => {
    const exact = { min: 0.29, minInclusive: true, max: 0.29, maxInclusive: true, phenotype: 'Lower' };
    expect(mapPhenotype(custom([exact]), '*3/*4')).toMatchObject({ status: 'determined', activityScore: 0.29 });
  });
});

describe('mapPhenotype: diplotype table', () => {
  it('matches a row written in the other order', () => {
    expect(mapPhenotype(map('GENEC'), '*1/*2')).toMatchObject({ phenotype: 'Synthetic Alpha', diplotype: '*1/*2' });
    expect(mapPhenotype(map('GENEC'), '*2/*1')).toMatchObject({ phenotype: 'Synthetic Alpha', diplotype: '*1/*2' });
  });
  it('a combination with no row has no phenotype', () => {
    for (const diplotype of ['*1/*3', '*2/*2', '*2/*3']) {
      expect(mapPhenotype(map('GENEC'), diplotype)).toMatchObject({ status: 'indeterminate', reasonCode: 'NO_PHENOTYPE_MAPPING' });
    }
  });
});

describe('mapPhenotype: input it will not guess about', () => {
  it.each(['', '*1', '*1/', '/*1', '*1/*1/*1', '*1|*1', ' *1/*1', '*1/*1 ', '*1 /*1', '*1/ *1'])('malformed %j', (diplotype) => {
    expect(mapPhenotype(map('GENEA'), diplotype)).toEqual({ status: 'indeterminate', gene: 'GENEA', reasonCode: 'MALFORMED_DIPLOTYPE' });
  });
  it.each(['*1/*9', '*9/*9', '*1/*10', '*1/1', '*1/*1.0'])('unknown allele %j', (diplotype) => {
    expect(mapPhenotype(map('GENEA'), diplotype)).toEqual({ status: 'indeterminate', gene: 'GENEA', reasonCode: 'ALLELE_NOT_IN_DEFINITIONS' });
  });
  it('allele names are case sensitive', () => {
    expect(mapPhenotype(map('GENEA'), '*1/*1')).toMatchObject({ status: 'determined' });
    const lower = { ...map('GENEA'), alleles: map('GENEA').alleles.map((a) => ({ ...a, name: a.name.replace('*', 'x') })) };
    expect(mapPhenotype(lower, '*1/*1')).toMatchObject({ reasonCode: 'ALLELE_NOT_IN_DEFINITIONS' });
  });
});

describe('mapPhenotype: privacy and purity', () => {
  it('never copies the input into an indeterminate result', () => {
    const secret = '*SECRET-ALLELE-9/*1';
    expect(JSON.stringify(mapPhenotype(map('GENEA'), secret))).not.toContain('SECRET');
    expect(JSON.stringify(mapPhenotype(map('GENEA'), '*SECRET|*1'))).not.toContain('SECRET');
  });
  it('does not change its inputs, and gives the same answer every time', () => {
    const frozen = structuredClone(map('GENEB'));
    const deepFreeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
      }
    };
    deepFreeze(frozen);
    const first = mapPhenotype(frozen, '*2/*4');
    for (let i = 0; i < 5; i += 1) expect(mapPhenotype(frozen, '*2/*4')).toEqual(first);
  });
});
