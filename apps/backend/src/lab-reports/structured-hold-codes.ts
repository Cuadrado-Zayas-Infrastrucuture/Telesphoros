/**
 * Why a stored structured revision is held before any drug is evaluated (032 S3). Separate from the PDF report holds, whose list is frozen by its own
 * test. Every code here is one migration 0070 allows for a structured source (`evaluations_hold_code_kind`); `missing-prerequisite` is allowed there
 * too but is raised only by the later slice that snapshots medication and indication context. Messages are fixed text; none ever contains a value from
 * a report.
 */
export const STRUCTURED_HOLD_CODES = ['findings-not-reviewed', 'source-conflict', 'unresolved-finding', 'unsupported-source'] as const;
export type StructuredHoldCode = (typeof STRUCTURED_HOLD_CODES)[number];

export const STRUCTURED_HOLD_MESSAGES: Readonly<Record<StructuredHoldCode, string>> = {
  'findings-not-reviewed': 'A second person has not yet accepted every finding of this stored laboratory report.',
  'source-conflict': 'The stored sources of this laboratory report conflict, or their history cannot be used.',
  'unresolved-finding': 'A finding of this laboratory report is uncertain, was not tested, or was rejected by the reviewer.',
  'unsupported-source': 'This stored laboratory report is not a kind this assessment can read.',
};

export const STRUCTURED_HOLD_ACTIONS: Readonly<Record<StructuredHoldCode, string>> = {
  'findings-not-reviewed': 'A reviewer who did not save or upload the report accepts or rejects each finding, then the assessment is run again.',
  'source-conflict': 'A reviewer chooses which stored source to use, or waits for a new source.',
  'unresolved-finding': 'A pharmacist reviews the laboratory report itself; no result is shown for it.',
  'unsupported-source': 'Use a final report whose findings are resolved diplotypes from a provided assay.',
};
