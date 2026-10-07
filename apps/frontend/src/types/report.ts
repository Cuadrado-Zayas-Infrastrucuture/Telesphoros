export const REPORT_TYPES = ['vcf', 'structured'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  vcf: 'VCF (variant call file)',
  structured: 'Structured PGx report (JSON)',
};
