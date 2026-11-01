import type { ReportStatus } from '@telesphoros/shared-types';
import { cn } from '@/lib/utils';

const STATUS_WORD: Record<ReportStatus, { label: string; tone: string }> = {
  received: { label: 'Received', tone: 'text-warning' },
  processing: { label: 'Processing', tone: 'text-warning' },
  processed: { label: 'Processed', tone: 'text-success' },
  failed: { label: 'Failed', tone: 'text-destructive' },
};

/** API-validated record status as a word in color. This does not indicate clinical review. */
export function ReportStatusText({ status, className }: { status: ReportStatus; className?: string }) {
  const word = STATUS_WORD[status];
  return <span className={cn(className, word.tone)}>{word.label}</span>;
}
