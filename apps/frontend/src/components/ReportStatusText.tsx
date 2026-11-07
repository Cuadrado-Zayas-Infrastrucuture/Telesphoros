import type { ReportStatus } from '@telesphoros/shared-types';
import { cn } from '@/lib/utils';

const STATUS_WORD: Record<ReportStatus, { label: string; tone: string }> = {
  received: { label: 'Received', tone: 'text-warning' },
  processing: { label: 'Processing', tone: 'text-warning' },
  processed: { label: 'Processed', tone: 'text-success' },
  failed: { label: 'Failed', tone: 'text-destructive' },
};

/** A report is registered before its file is sent, so a failed or abandoned upload still has a record, with status "received" and no file. */
const UNFINISHED = { label: 'Upload not finished', tone: 'text-warning' };

/**
 * API-validated record status as a word in color. This does not indicate clinical review. Pass `fileUploaded` from the record wherever it is known, so a
 * record whose file never arrived does not read as received.
 */
export function ReportStatusText({ status, fileUploaded, className }: { status: ReportStatus; fileUploaded?: boolean; className?: string }) {
  const word = fileUploaded === false ? UNFINISHED : STATUS_WORD[status];
  return <span className={cn(className, word.tone)}>{word.label}</span>;
}
