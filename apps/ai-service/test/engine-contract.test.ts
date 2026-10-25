import { drugResultSchema } from '@telesphoros/cpic-schema';
import { expect, test } from 'vitest';
import { RESULTS } from '../evals/golden/results';
import { explainableResultSchema } from '../src/evaluators/types';

// The harness reads a narrow view of the engine's `shown` result. If the engine renames or drops a field the view depends on, this goes red.
test('a real `shown` DrugResult carries every field the explainable view needs, with matching values', () => {
  const r = RESULTS.dose;
  const shown = drugResultSchema.parse({
    outcome: 'shown', drug: r.drug, genes: ['GENEB'], geneStates: [{ gene: 'GENEB', state: 'canonical', phenotype: r.genes[0].phenotype, reasonCode: null }],
    strength: r.strength, recommendationText: r.recommendationText, implication: r.implication,
    citation: { guidelineId: r.guidelineId, guidelineVersion: r.guidelineVersion, sourceUrl: 'https://example.invalid/synthetic', locator: r.locator, verification: 'verified' },
  });
  if (shown.outcome !== 'shown') throw new Error('not shown');
  const view = explainableResultSchema.parse({
    drug: shown.drug, strength: shown.strength, genes: shown.geneStates.map(g => ({ gene: g.gene, phenotype: g.phenotype })),
    guidelineId: shown.citation.guidelineId, guidelineVersion: shown.citation.guidelineVersion, locator: shown.citation.locator,
    recommendationText: shown.recommendationText, implication: shown.implication,
  });
  expect(view).toEqual(r);
});
