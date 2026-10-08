import { z } from 'zod';

/**
 * Why the engine produced no recommendation. Clinicians need the reason, not just the absence, so
 * every "no answer" carries exactly one of these codes. The messages are fixed text: they never
 * contain a genotype, diplotype or any other value from a report.
 */
export const INDETERMINATE_REASON_CODES = [
  // Reported by the report parsers (the engine passes them through).
  'UNPHASED_VCF',
  'STRUCTURAL_VARIANT',
  'MULTIALLELIC_SITE',
  'ALLELE_NOT_IN_DEFINITIONS',
  'MALFORMED_DIPLOTYPE',
  // Decided by the engine.
  'NO_GENE_DEFINITION',
  'NO_PHENOTYPE_MAPPING',
  'CONFLICTING_CALLS',
  'GENE_NOT_IN_REPORT',
  'NO_MATCHING_GUIDELINE',
  'PHENOTYPE_NOT_IN_GUIDELINE',
] as const;
export const indeterminateReasonCodeSchema = z.enum(INDETERMINATE_REASON_CODES);
export type IndeterminateReasonCode = z.infer<typeof indeterminateReasonCodeSchema>;

/** The subset a parser may attach to a gene it could not call. */
export const CALLER_REASON_CODES = [
  'UNPHASED_VCF',
  'STRUCTURAL_VARIANT',
  'MULTIALLELIC_SITE',
  'ALLELE_NOT_IN_DEFINITIONS',
  'MALFORMED_DIPLOTYPE',
] as const satisfies readonly IndeterminateReasonCode[];
export const callerReasonCodeSchema = z.enum(CALLER_REASON_CODES);
export type CallerReasonCode = z.infer<typeof callerReasonCodeSchema>;

export const REASON_MESSAGES: Readonly<Record<IndeterminateReasonCode, string>> = {
  UNPHASED_VCF: 'The variants for this gene are unphased, so the two haplotypes cannot be told apart. A laboratory-reported diplotype is needed.',
  STRUCTURAL_VARIANT: 'This gene has a structural variant or copy-number change that this report format cannot represent.',
  MULTIALLELIC_SITE: 'A target position has more than one alternate allele, which this analysis does not call.',
  ALLELE_NOT_IN_DEFINITIONS: 'An allele in the report is not in the allele definitions used by this system.',
  MALFORMED_DIPLOTYPE: 'The diplotype in the report is not in the expected "allele/allele" form.',
  NO_GENE_DEFINITION: 'This system has no allele definitions for this gene.',
  NO_PHENOTYPE_MAPPING: 'The guideline tables define no phenotype for this combination of alleles.',
  CONFLICTING_CALLS: 'The report gives different results for this gene.',
  GENE_NOT_IN_REPORT: 'The report has no result for the gene this guideline needs.',
  NO_MATCHING_GUIDELINE: 'No loaded guideline covers this drug.',
  PHENOTYPE_NOT_IN_GUIDELINE: 'The guideline has no recommendation for this phenotype.',
};

/** CPIC's own strength-of-recommendation terms. */
export const CPIC_STRENGTHS = ['Strong', 'Moderate', 'Optional', 'No recommendation'] as const;
export const cpicStrengthSchema = z.enum(CPIC_STRENGTHS);
export type CpicStrength = z.infer<typeof cpicStrengthSchema>;
