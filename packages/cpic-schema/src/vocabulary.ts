import { z } from 'zod';

/**
 * The five things a result can be. They must look and behave differently everywhere they appear,
 * because each means something different to the person reading it:
 *
 *   shown                        a verified guideline cell applies; its wording is displayed
 *   held                         a person must act before anything can be shown (see the reviewer action)
 *   abstained                    the report lists values with no key tying them to genes; nothing is guessed
 *   no-published-recommendation  the guideline was consulted and publishes no recommendation for this case
 *   no-guideline                 no loaded guideline covers the drug
 */
export const OUTCOMES = ['shown', 'held', 'abstained', 'no-published-recommendation', 'no-guideline'] as const;
export const outcomeSchema = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof outcomeSchema>;

/**
 * Why a result is not `shown`. Every non-shown result carries exactly one. The names follow the
 * product design; the last block exists because the engine can also be fed a diplotype.
 * Messages and reviewer actions are fixed text: they never contain a value from a report.
 */
export const REASON_CODES = [
  // held: a person must act
  'duplicate-gene-conflict',
  'duplicate-identical',
  'sentinel-literal-in-source',
  'other-gene-unresolved',
  'out-of-review-scope',
  'cell-disputed',
  'gene-absent',
  // held: a diplotype could not be turned into a phenotype
  'malformed-diplotype',
  'allele-not-in-definitions',
  'no-phenotype-mapping',
  'no-gene-definition',
  // abstained
  'association-abstained',
  // not held, not shown
  'no-published-recommendation',
  'no-guideline-for-drug',
] as const;
export const reasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof reasonCodeSchema>;

export const REASON_OUTCOME: Readonly<Record<ReasonCode, Outcome>> = {
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
};

/**
 * When several genes behind one result have different problems, the result carries the first of
 * these that applies. Holds come before abstention: if a person is needed, say so.
 */
export const REASON_PRECEDENCE: readonly ReasonCode[] = [
  'duplicate-gene-conflict',
  'duplicate-identical',
  'sentinel-literal-in-source',
  'other-gene-unresolved',
  'malformed-diplotype',
  'allele-not-in-definitions',
  'no-phenotype-mapping',
  'no-gene-definition',
  'gene-absent',
  'association-abstained',
];

/** What the reason means, in plain words. */
export const REASON_MESSAGES: Readonly<Record<ReasonCode, string>> = {
  'duplicate-gene-conflict': 'The same gene appears more than once in the report with different values.',
  'duplicate-identical': 'The same gene appears more than once in the report with identical values.',
  'sentinel-literal-in-source': 'The report says "no result" (or similar) in place of a value for this gene.',
  'other-gene-unresolved': 'The value reported for this gene is not a recognized phenotype (unfamiliar wording, or a genotype only).',
  'out-of-review-scope': 'The guideline cell for this case exists but has not passed review.',
  'cell-disputed': 'The guideline cell for this case is under dispute.',
  'gene-absent': 'The report has no result for a gene this guideline needs.',
  'malformed-diplotype': 'The diplotype in the report is not in the expected "allele/allele" form.',
  'allele-not-in-definitions': 'An allele in the report is not in the allele definitions used by this system.',
  'no-phenotype-mapping': 'The guideline tables define no phenotype for this combination of alleles.',
  'no-gene-definition': 'This system has no definitions for this gene.',
  'association-abstained': 'The report lists values with no key tying them to genes, so none were assigned.',
  'no-published-recommendation': 'The guideline publishes no recommendation for this case.',
  'no-guideline-for-drug': 'No loaded guideline covers this drug.',
};

/** What a reviewer does next. `null` means nothing can be done in the product yet. */
export const REVIEWER_ACTIONS: Readonly<Record<ReasonCode, string | null>> = {
  'duplicate-gene-conflict': 'Obtain ordering or supersession evidence, or a corrected report.',
  'duplicate-identical': 'Confirm it is a repeated summary line.',
  'sentinel-literal-in-source': 'Ask the lab whether the test failed.',
  'other-gene-unresolved': 'Obtain the phenotype from the lab.',
  'out-of-review-scope': null,
  'cell-disputed': 'Resolve the dispute through the cell review process; an independent second person is required.',
  'gene-absent': 'Obtain the missing gene result from the lab.',
  'malformed-diplotype': 'Obtain a correctly formatted result from the lab.',
  'allele-not-in-definitions': 'Obtain the phenotype from the lab, or add the allele through the reviewed definition process.',
  'no-phenotype-mapping': 'Obtain the phenotype from the lab.',
  'no-gene-definition': 'Obtain the phenotype from the lab; the gene needs a reviewed definition.',
  'association-abstained': 'Request a corrected or differently laid out report.',
  'no-published-recommendation': null,
  'no-guideline-for-drug': null,
};

/**
 * The 5A codes this vocabulary replaces, so anything recorded under the old names stays readable.
 * `null` means the code no longer exists (it belonged to the VCF path, which is not built).
 */
export const RETIRED_REASON_CODES: Readonly<Record<string, ReasonCode | null>> = {
  UNPHASED_VCF: null,
  STRUCTURAL_VARIANT: null,
  MULTIALLELIC_SITE: null,
  ALLELE_NOT_IN_DEFINITIONS: 'allele-not-in-definitions',
  MALFORMED_DIPLOTYPE: 'malformed-diplotype',
  NO_GENE_DEFINITION: 'no-gene-definition',
  NO_PHENOTYPE_MAPPING: 'no-phenotype-mapping',
  CONFLICTING_CALLS: 'duplicate-gene-conflict',
  GENE_NOT_IN_REPORT: 'gene-absent',
  NO_MATCHING_GUIDELINE: 'no-guideline-for-drug',
  PHENOTYPE_NOT_IN_GUIDELINE: 'no-published-recommendation',
};

/** The only reasons a caller (the adapter) may attach to a gene it could not resolve. */
export const CALLER_REASON_CODES = ['other-gene-unresolved', 'association-abstained'] as const satisfies readonly ReasonCode[];
export const callerReasonCodeSchema = z.enum(CALLER_REASON_CODES);
export type CallerReasonCode = z.infer<typeof callerReasonCodeSchema>;

/** CPIC's own strength-of-recommendation terms. */
export const CPIC_STRENGTHS = ['Strong', 'Moderate', 'Optional', 'No recommendation'] as const;
export const cpicStrengthSchema = z.enum(CPIC_STRENGTHS);
export type CpicStrength = z.infer<typeof cpicStrengthSchema>;

/** Whether the position of a guideline cell has been rechecked against the published source. */
export const VERIFICATION_STATES = ['unverified', 'verified', 'disputed'] as const;
export const verificationStateSchema = z.enum(VERIFICATION_STATES);
export type VerificationState = z.infer<typeof verificationStateSchema>;
