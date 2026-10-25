/**
 * Fixed text for every engine outcome that is not an explainable `shown` result (FR-002, FR-006), and the eligibility rule.
 * DRAFT wording: the pharmacist reviews these sentences (D5). They add no clinical fact: they say why nothing is explained.
 */
export const FALLBACK_TEXT: Readonly<Record<string, string>> = {
  'duplicate-gene-conflict': 'No explanation is generated. The report gives conflicting results for the same gene; a person must resolve them first.',
  'duplicate-identical': 'No explanation is generated. The report repeats the same gene result; a person must confirm it first.',
  'sentinel-literal-in-source': 'No explanation is generated. The report holds a placeholder value instead of a result; a person must check it first.',
  'other-gene-unresolved': 'No explanation is generated. Another gene behind this result is unresolved; a person must resolve it first.',
  'out-of-review-scope': 'No explanation is generated. This guideline entry is outside the reviewed scope; a person must review it first.',
  'cell-disputed': 'No explanation is generated. This guideline entry is disputed; a person must review it first.',
  'gene-absent': 'No explanation is generated. A gene this result needs is absent from the report.',
  'malformed-diplotype': 'No explanation is generated. A diplotype in the report could not be read.',
  'allele-not-in-definitions': 'No explanation is generated. An allele in the report is not in the gene definitions.',
  'no-phenotype-mapping': 'No explanation is generated. The report result has no phenotype mapping.',
  'no-gene-definition': 'No explanation is generated. There is no gene definition for a gene in the report.',
  'association-abstained': 'No explanation is generated. The engine abstained on this gene and drug association.',
  'no-published-recommendation': 'No explanation is generated. The guideline publishes no recommendation for this case.',
  'no-guideline-for-drug': 'No explanation is generated. No guideline is loaded for this drug.',
  'no-recommendation-strength': 'No explanation is generated. The guideline strength for this result is "No recommendation".',
  'unknown-outcome': 'No explanation is generated. The engine result was not recognised.',
};
export type Eligibility = { eligible: true } | { eligible: false; reason: string; text: string };

/** Only a `shown` result with a strength other than "No recommendation" may reach a model. Anything unrecognised fails closed. */
export function eligibility(outcome: string, reasonCode: string | null, strength: string | null): Eligibility {
  const no = (reason: string): Eligibility => ({ eligible: false, reason, text: Object.hasOwn(FALLBACK_TEXT, reason) ? FALLBACK_TEXT[reason] : FALLBACK_TEXT['unknown-outcome'] });
  if (outcome === 'shown')
    return strength === 'Strong' || strength === 'Moderate' || strength === 'Optional'
      ? { eligible: true }
      : no(strength === 'No recommendation' ? 'no-recommendation-strength' : 'unknown-outcome');
  if (
    ['held', 'abstained', 'no-published-recommendation', 'no-guideline'].includes(outcome) &&
    reasonCode !== null &&
    Object.hasOwn(FALLBACK_TEXT, reasonCode) &&
    reasonCode !== 'unknown-outcome' &&
    reasonCode !== 'no-recommendation-strength'
  )
    return no(reasonCode);
  return no('unknown-outcome');
}
