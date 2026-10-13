import type { PaginationMeta } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function PaginationControls({ label, meta, busy, onPage, preserveFocus = false, statusMessage }: {
  label: string;
  meta: PaginationMeta;
  busy: boolean;
  onPage: (page: number) => void;
  /** Use guarded aria-disabled controls when loading must preserve keyboard focus. */
  preserveFocus?: boolean;
  statusMessage?: string;
}) {
  const previousUnavailable = busy || meta.page <= 1;
  const nextUnavailable = busy || meta.page >= meta.totalPages;
  const previous = <Button variant="outline" aria-label={preserveFocus ? `Previous ${label.toLowerCase()} page` : undefined} disabled={!preserveFocus && previousUnavailable} aria-disabled={preserveFocus ? previousUnavailable : undefined} className={preserveFocus ? 'h-auto min-h-control whitespace-normal px-3 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60' : undefined} onClick={() => { if (!previousUnavailable) onPage(meta.page - 1); }}>
    {preserveFocus && <ChevronLeft aria-hidden="true" className="size-4 shrink-0" />}
    {preserveFocus ? 'Previous' : `Previous ${label.toLowerCase()} page`}
  </Button>;
  const next = <Button variant="outline" aria-label={preserveFocus ? `Next ${label.toLowerCase()} page` : undefined} disabled={!preserveFocus && nextUnavailable} aria-disabled={preserveFocus ? nextUnavailable : undefined} className={preserveFocus ? 'h-auto min-h-control whitespace-normal px-3 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60' : undefined} onClick={() => { if (!nextUnavailable) onPage(meta.page + 1); }}>
    {preserveFocus ? 'Next' : `Next ${label.toLowerCase()} page`}
    {preserveFocus && <ChevronRight aria-hidden="true" className="size-4 shrink-0" />}
  </Button>;
  const status = <p role="status" className="text-sm tabular-nums text-muted-foreground">
    {statusMessage ?? (preserveFocus && busy ? `Loading ${label.toLowerCase()} pages…` : meta.total === 0 ? 'No records.' : `Page ${meta.page} of ${meta.totalPages}. ${meta.total} records.`)}
  </p>;
  return <nav aria-label={`${label} pages`} className={preserveFocus ? 'flex flex-wrap items-center justify-between gap-3' : 'flex flex-wrap items-center gap-3'}>
    {preserveFocus ? <>{status}<div className="flex flex-wrap gap-2">{previous}{next}</div></> : <>{previous}{status}{next}</>}
  </nav>;
}
