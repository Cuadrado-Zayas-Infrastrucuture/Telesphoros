import type { ExplainableResult } from '../../src/evaluators/types';

const locator = (row: string) => ({ table: 'Synthetic Table 1', row, column: null });
const base = { guidelineVersion: 'synthetic-1' };

/**
 * Hand-written engine results with invented drugs and genes, shaped like real guideline cells (a directive, a number, a
 * qualifier, an implication). Not CPIC content and not clinical wording: they prove the harness, not clinical accuracy.
 */
export const RESULTS = {
  avoid: { ...base, drug: 'drugv', strength: 'Strong', genes: [{ gene: 'GENEA', phenotype: 'Synthetic Poor' }], guidelineId: 'drugv-genea', locator: locator('Synthetic Poor'),
    recommendationText: 'Avoid drugv. Consider an alternative agent that does not depend on this pathway.', implication: 'Reduced enzyme function increases exposure to drugv.' },
  dose: { ...base, drug: 'drugx', strength: 'Moderate', genes: [{ gene: 'GENEB', phenotype: 'Synthetic Intermediate' }], guidelineId: 'drugx-geneb', locator: locator('Synthetic Intermediate'),
    recommendationText: 'Start drugx at 50% of the standard dose and titrate to response. Monitor for adverse effects.', implication: 'Reduced enzyme function lowers clearance of drugx.' },
  optional: { ...base, drug: 'drugy', strength: 'Optional', genes: [{ gene: 'GENEC', phenotype: 'Synthetic Rapid' }], guidelineId: 'drugy-genec', locator: locator('Synthetic Rapid'),
    recommendationText: 'Consider a higher dose of drugy if the response is inadequate.', implication: null },
  normal: { ...base, drug: 'drugw', strength: 'Strong', genes: [{ gene: 'GENEA', phenotype: 'Synthetic Normal' }], guidelineId: 'drugw-genea', locator: locator('Synthetic Normal'),
    recommendationText: 'Use drugw at the standard dose.', implication: null },
  two: { ...base, drug: 'drugz', strength: 'Strong', genes: [{ gene: 'GENEA', phenotype: 'Synthetic Poor' }, { gene: 'GENEE', phenotype: 'Synthetic Normal' }], guidelineId: 'drugz-genea-genee', locator: locator('Synthetic Poor / Synthetic Normal'),
    recommendationText: 'Avoid drugz in patients with this combination unless no alternative exists.', implication: 'Both genes affect clearance of drugz.' },
} as const satisfies Record<string, ExplainableResult>;
export type ResultKey = keyof typeof RESULTS;
