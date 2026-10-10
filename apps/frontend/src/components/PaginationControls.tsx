import type { PaginationMeta } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';

export function PaginationControls({ label, meta, busy, onPage }: {
  label: string;
  meta: PaginationMeta;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <nav aria-label={`${label} pages`} className="flex flex-wrap items-center gap-3">
      <Button variant="outline" disabled={busy || meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
        Previous {label.toLowerCase()} page
      </Button>
      <p role="status">
        {meta.total === 0 ? 'No records.' : `Page ${meta.page} of ${meta.totalPages}. ${meta.total} records.`}
      </p>
      <Button variant="outline" disabled={busy || meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>
        Next {label.toLowerCase()} page
      </Button>
    </nav>
  );
}
