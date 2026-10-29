/** Report types the upload form OFFERS. `lab-pdf` is deliberately absent: it has no upload screen in this phase. */
export const REPORT_TYPES = ['structured'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Every type the API can return, so a row of any type can be labelled. */
export type KnownReportType = ReportType | 'lab-pdf';

export const REPORT_TYPE_LABELS: Record<KnownReportType, string> = {
  structured: 'Structured PGx report (JSON)',
  'lab-pdf': 'Lab report (PDF)',
};
