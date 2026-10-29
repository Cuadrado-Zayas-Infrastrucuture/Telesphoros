import type { KnownReportType } from '@/types/report';

/** The one-screen box has no type picker: the extension decides (specs/016 D5). No raw genomic data is stored (#154), so a VCF is refused like any other file. */
export function reportTypeFor(filename: string): KnownReportType | null {
  const name = filename.toLowerCase();
  if (name.endsWith('.json')) return 'structured';
  if (name.endsWith('.pdf')) return 'lab-pdf';
  return null;
}
