import { RefreshCw } from 'lucide-react';
import type { Paginated, PatientDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';

/** Page status, refresh and previous/next for the upload page's patient list. */
export function PatientPaging({
  patients,
  loading,
  error,
  busy,
  onPage,
}: {
  patients: Paginated<PatientDto> | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      {!loading && !error && patients && patients.meta.total > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          Patient page {patients.meta.page} of {patients.meta.totalPages}
        </p>
      )}
      <div className="-ml-3 flex flex-wrap gap-1 sm:ml-0">
        {!error && (
          <Button type="button" variant="ghost" size="sm" disabled={loading || busy} onClick={() => onPage(patients?.meta.page ?? 1)}>
            <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
            Refresh patients
          </Button>
        )}
        {patients && patients.meta.totalPages > 1 && (
          <>
            <Button type="button" variant="ghost" size="sm" disabled={loading || busy || patients.meta.page <= 1} onClick={() => onPage(patients.meta.page - 1)}>
              Previous patients
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || busy || patients.meta.page >= patients.meta.totalPages}
              onClick={() => onPage(patients.meta.page + 1)}
            >
              Next patients
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
