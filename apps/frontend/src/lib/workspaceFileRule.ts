import { ownedStorageMode } from '@/lib/storageMode';
import { reportTypeFor } from '@/lib/reportTypeFor';

/**
 * Which files the chat accepts (specs/024 D4): a .json file is a structured report; a .pdf only in owned-storage mode, which a published (staging)
 * bundle refuses; anything else, VCF included, is refused. Returns the reason shown to the person, or null when the file may be sent.
 */
export function fileProblem(filename: string): string | null {
  const type = reportTypeFor(filename);
  if (type === 'structured') return null;
  if (type === 'lab-pdf') return ownedStorageMode() ? null : 'PDF reports can be attached in the local preview only. Attach a .json report here.';
  return ownedStorageMode() ? 'Use a .json or .pdf report. Raw genomic data (VCF) is not accepted.' : 'Use a .json report. Raw genomic data (VCF) is not accepted.';
}
