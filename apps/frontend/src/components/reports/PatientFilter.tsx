import { RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import type { Paginated, PaginationMeta, PatientDto } from '@telesphoros/shared-types';
import { PaginationControls } from '@/components/PaginationControls';
import { Button } from '@/components/ui/Button';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { Skeleton } from '@/components/ui/Skeleton';

/** Filter the reports by patient: the menu, its refresh and clear buttons, and the pager for patient options. */
export function PatientFilter({
  value,
  chosen,
  patients,
  meta,
  loading,
  error,
  onSelect,
  onRefresh,
  onClear,
  onPage,
}: {
  value: string;
  /** The patient chosen earlier, kept in the menu while the loaded page of options does not list it. */
  chosen: PatientDto | null;
  patients: Paginated<PatientDto> | null;
  meta: PaginationMeta;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onClear: () => void;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2 bg-background px-4 py-4 sm:px-5">
      <label htmlFor="patient-filter" className="flex items-center gap-2 text-sm font-medium">
        <SlidersHorizontal aria-hidden="true" className="size-4" />
        Filter by patient
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <NativeSelect id="patient-filter" className="min-w-0 flex-1" value={value} disabled={loading} onChange={(event) => onSelect(event.target.value)}>
          <option value="">All patients</option>
          {chosen && !patients?.data.some((patient) => patient.id === chosen.id) && <option value={chosen.id}>{chosen.label}</option>}
          {patients?.data.map((patient) => (
            <option key={patient.id} value={patient.id}>
              {patient.label}
            </option>
          ))}
        </NativeSelect>
        <Button
          variant="outline"
          size="sm"
          aria-label="Refresh patient options"
          title="Refresh patient options"
          aria-disabled={loading}
          className="shrink-0 px-0"
          onClick={() => {
            if (!loading) onRefresh();
          }}
        >
          <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
        </Button>
        {value && (
          <Button variant="outline" size="sm" aria-label="Clear patient filter" title="Clear patient filter" className="shrink-0 px-0" onClick={onClear}>
            <X aria-hidden="true" className="size-4 shrink-0" />
          </Button>
        )}
      </div>
      {loading && <Skeleton className="h-10 w-full" />}
      {meta.totalPages <= 1 && (
        <p role="status" className={loading || !patients || patients.meta.total === 0 ? 'text-xs text-muted-foreground' : 'sr-only'}>
          {loading
            ? 'Loading patient options…'
            : patients?.meta.total === 0
              ? 'No patient options available.'
              : patients
                ? 'Showing available patient options.'
                : 'Patient options unavailable.'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {meta.totalPages > 1 && (
        <PaginationControls
          compact
          label="Patient"
          meta={meta}
          busy={loading}
          preserveFocus
          statusMessage={loading ? 'Loading patient options…' : error ? 'Patient page unavailable.' : `Patient options: page ${meta.page} of ${meta.totalPages}.`}
          onPage={onPage}
        />
      )}
    </div>
  );
}
