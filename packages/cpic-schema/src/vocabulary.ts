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
  // held: the guideline file has no cell for this combination (audit DATA-01)
  'knowledge-gap',
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
  'knowledge-gap': 'held',
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

/**
 * What the reason means, in plain words. Messages and reviewer actions were reviewed and approved by the founder and the co-founder,
 * both pharmacists, in the spec 038 D11 wording review (2026-11-14); `knowledge-gap` was first approved in audit T3 (2026-11-07).
 */
export const REASON_MESSAGES: Readonly<Record<ReasonCode, string>> = {
  'duplicate-gene-conflict': 'The report lists this gene more than once with different values.',
  'duplicate-identical': 'The report lists this gene more than once with identical values.',
  'sentinel-literal-in-source': 'The report lists “no result” or similar wording for this gene.',
  'other-gene-unresolved': 'This system does not recognize the reported value as a phenotype. It may use unfamiliar wording or provide only a genotype.',
  'out-of-review-scope': "The guideline entry for this case has not passed this system's review.",
  'cell-disputed': 'The guideline entry for this case is under dispute.',
  'gene-absent': 'A gene result required by this guideline is missing from the report.',
  'malformed-diplotype': 'The reported diplotype does not match the allele/allele format expected by this system.',
  'allele-not-in-definitions': 'An allele in this report is not included in the definitions available in this system.',
  'no-phenotype-mapping': 'The available guideline tables do not define a phenotype for this allele combination.',
  'no-gene-definition': 'This system has no definitions available for this gene.',
  'knowledge-gap': 'The available guideline data have no entry for this result combination. A pharmacist must review the case before a recommendation can be provided.',
  'association-abstained': 'The report does not clearly link values to genes. This system did not assign them.',
  'no-published-recommendation': 'This guideline provides no recommendation for this case.',
  'no-guideline-for-drug': 'The guidelines available in this system do not cover this drug.',
};

/** What a reviewer does next. `null` means no reviewer action is specified for the reason, and the screen says so. */
export const REVIEWER_ACTIONS: Readonly<Record<ReasonCode, string | null>> = {
  'duplicate-gene-conflict': 'Obtain documentation confirming which result should be used, or request a corrected report.',
  'duplicate-identical': 'Confirm that the duplicate is a repeated summary entry.',
  'sentinel-literal-in-source': 'Ask the lab to clarify why no result was reported.',
  'other-gene-unresolved': 'Request the phenotype from the lab.',
  'out-of-review-scope': null,
  'cell-disputed': 'Resolve the dispute through the guidance review process. An independent second reviewer is required.',
  'gene-absent': 'Request the missing gene result from the lab.',
  'malformed-diplotype': 'Ask the lab to clarify the diplotype or provide it in the required format.',
  'allele-not-in-definitions': 'Request the phenotype from the lab, or have the allele added through the definition review process.',
  'no-phenotype-mapping': 'Request the phenotype from the lab.',
  'no-gene-definition': 'Request the phenotype from the lab. A reviewed definition is also needed for this gene.',
  'knowledge-gap': 'Use the knowledge review process to add an entry or sign off that this case is not covered.',
  'association-abstained': 'Request a report that clearly links each value to its gene.',
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

/**
 * The only reasons a caller (the report adapter) may attach to a gene it could not resolve. The two duplicate codes are
 * there because only the adapter still has the literal facts (diplotype text, result text, field presence) that decide
 * which one applies (docs/design/report-adapter-spec.md, section 5.4). The engine's own duplicate rule remains the backstop.
 */
export const CALLER_REASON_CODES = ['other-gene-unresolved', 'association-abstained', 'duplicate-identical', 'duplicate-gene-conflict'] as const satisfies readonly ReasonCode[];
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
