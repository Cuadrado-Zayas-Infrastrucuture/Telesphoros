import type { Ref } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NativeSelect } from '@/components/ui/NativeSelect';

/** Search and storage filters that apply only to the loaded page of reports. */
export function PageFilters({
  searchRef,
  searchText,
  uploadFilter,
  active,
  status,
  onChange,
  onReset,
}: {
  searchRef: Ref<HTMLInputElement>;
  searchText: string;
  uploadFilter: string;
  active: boolean;
  status: string;
  onChange: (text: string, upload: string) => void;
  onReset: () => void;
}) {
  return (
    <details className="group border-t border-divider px-4 sm:px-5">
      <summary className="flex min-h-control cursor-pointer items-center text-sm font-medium">
        Search and filter this page{active ? ' — active' : ''}
        <ChevronDown aria-hidden="true" className="ml-auto size-4 shrink-0 group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-3 pb-4">
        <p id="page-filter-help" className="text-xs text-muted-foreground">
          Filters apply only to the loaded page. Use patient filtering and pagination to find other records. Page filters reset when you change page or patient.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="report-search" className="text-sm font-medium">
              Filename on this page
            </label>
            <Input
              ref={searchRef}
              id="report-search"
              type="search"
              value={searchText}
              aria-describedby="page-filter-help"
              onChange={(event) => onChange(event.target.value, uploadFilter)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="upload-filter" className="text-sm font-medium">
              Storage upload
            </label>
            <NativeSelect id="upload-filter" value={uploadFilter} aria-describedby="page-filter-help" onChange={(event) => onChange(searchText, event.target.value)}>
              <option value="all">All upload states</option>
              <option value="verified">Verified storage</option>
              <option value="incomplete">Incomplete storage</option>
            </NativeSelect>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-sm text-muted-foreground">
            {status}
          </p>
          <Button variant="ghost" size="sm" disabled={!active} onClick={onReset}>
            Reset page filters
          </Button>
        </div>
      </div>
    </details>
  );
}
