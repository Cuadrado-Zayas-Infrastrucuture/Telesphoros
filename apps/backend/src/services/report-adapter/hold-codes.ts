/**
 * Why a whole report is held before any drug is evaluated (docs/design/report-adapter-spec.md, section 6).
 *
 * A report-level hold produces NO drug results. This list is separate from the engine's reason codes and, like them, is
 * frozen by a test: a new code is a reviewed change to the specification first. Messages are fixed text; none ever
 * contains a value from a report.
 */
export const REPORT_HOLD_CODES = [
  // raised by the adapter
  'capture-not-accepted',
  'capture-hash-mismatch',
  'poppler-version-mismatch',
  'reader-binding-mismatch',
  'packet-invalid',
  'evidence-overlap',
  // raised by the reader (its own reason strings, unchanged)
  'unsupported-layout',
  'alignment-unsupported',
  'unsupported-column-layout',
  'unaccounted-text',
  'mixed-frame-set',
  'selector-quarantined',
  'source-limit',
  'candidate-or-frame-limit',
  'source-time-budget',
  'worker-error',
] as const;
export type ReportHoldCode = (typeof REPORT_HOLD_CODES)[number];

export const READER_HOLD_CODES = REPORT_HOLD_CODES.slice(6) as readonly ReportHoldCode[];

export const REPORT_HOLD_MESSAGES: Readonly<Record<ReportHoldCode, string>> = {
  'capture-not-accepted': 'No person has accepted the text capture of this report.',
  'capture-hash-mismatch': 'The accepted capture is not the text that was read.',
  'poppler-version-mismatch': 'The capture was made with a different Poppler version than the one this system is validated for.',
  'reader-binding-mismatch': 'The reader that processed this report is not the approved build.',
  'packet-invalid': 'The reader output failed its integrity checks.',
  'evidence-overlap': 'The reader output uses the same text as evidence for more than one thing.',
  'unsupported-layout': 'The report layout is not one the reader recognizes.',
  'alignment-unsupported': 'A column table in the report could not be aligned reliably.',
  'unsupported-column-layout': 'The column layout in the report is not supported.',
  'unaccounted-text': 'The report contains text the reader does not recognize.',
  'mixed-frame-set': 'The report ties some genes to values and others not.',
  'selector-quarantined': 'More than one reading of the report was possible and none is permitted.',
  'source-limit': 'The report is larger than the reader accepts.',
  'candidate-or-frame-limit': 'The report has more findings than the reader accepts.',
  'source-time-budget': 'The reader did not finish in time.',
  'worker-error': 'The reader failed.',
};

export const REPORT_HOLD_ACTIONS: Readonly<Record<ReportHoldCode, string>> = {
  'capture-not-accepted': 'A person must review the paired PDF and text and accept the capture.',
  'capture-hash-mismatch': 'Re-capture the report and accept the new capture.',
  'poppler-version-mismatch': 'Re-capture the report with the pinned Poppler version.',
  'reader-binding-mismatch': 'Stop and investigate: the reader is not the approved build.',
  'packet-invalid': 'Treat as a defect: the reader output failed its own integrity checks.',
  'evidence-overlap': 'Treat as a defect: evidence for two things overlaps.',
  'unsupported-layout': 'Transcribe the result by hand or obtain another export from the lab.',
  'alignment-unsupported': 'Transcribe the result by hand or obtain another export from the lab.',
  'unsupported-column-layout': 'Transcribe the result by hand or obtain another export from the lab.',
  'unaccounted-text': 'A person must read the report.',
  'mixed-frame-set': 'A person must read the report.',
  'selector-quarantined': 'A person must read the report.',
  'source-limit': 'Retry once with a smaller report, then treat as a defect.',
  'candidate-or-frame-limit': 'Retry once, then treat as a defect.',
  'source-time-budget': 'Retry once, then treat as a defect.',
  'worker-error': 'Retry once, then treat as a defect.',
};

/** The hold for a reason string the reader gave, or null if the reader named a reason this adapter does not know. */
export function holdCodeForReaderReason(reason: string | null): ReportHoldCode | null {
  return reason !== null && (READER_HOLD_CODES as readonly string[]).includes(reason) ? (reason as ReportHoldCode) : null;
}
