import { Link } from 'react-router-dom';
import { Check, ChevronRight, Minus } from 'lucide-react';
import type { Paginated, ReportDto } from '@telesphoros/shared-types';
import { ReportListSkeleton } from '@/components/ReportListSkeleton';
import { ReportStatusText } from '@/components/ReportStatusText';
import { Button } from '@/components/ui/Button';

/** The page of report rows, or the empty or error state that takes its place, with the action that gets the person unstuck. */
export function ReportRecordsTable({
  reports,
  visibleReports,
  loading,
  error,
  hasPageFilters,
  patientId,
  selectedId,
  canAttach,
  patientLabel,
  onSelect,
  onRetry,
  onFirstPage,
  onResetFilters,
}: {
  reports: Paginated<ReportDto> | null;
  visibleReports: ReportDto[];
  loading: boolean;
  error: string | null;
  hasPageFilters: boolean;
  patientId: string;
  selectedId: string | undefined;
  canAttach: boolean;
  patientLabel: (id: string) => string | undefined;
  onSelect: (report: ReportDto, trigger: HTMLButtonElement) => void;
  onRetry: () => void;
  onFirstPage: () => void;
  onResetFilters: () => void;
}) {
  const filteredOut = hasPageFilters && Boolean(reports?.data.length);
  return (
    <div
      role="region"
      aria-label="Report records table"
      aria-busy={loading}
      tabIndex={0}
      className="report-records-region h-report-list max-w-full overflow-auto border-y border-divider"
    >
      {loading || visibleReports.length ? (
        <table className="w-full table-fixed text-left text-sm">
          <caption className="sr-only">Reports on the selected page</caption>
          <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="w-1/2 px-3 py-3 sm:w-5/12">
                {patientId ? 'Report' : 'Report / patient'}
              </th>
              <th scope="col" className="w-1/4 px-2 py-3 sm:px-3">
                Record status
              </th>
              <th scope="col" className="w-1/4 px-2 py-3 sm:w-1/3 sm:px-3">
                Upload
              </th>
            </tr>
          </thead>
          {loading ? (
            <ReportListSkeleton showPatient={!patientId} />
          ) : (
            <tbody>
              {visibleReports.map((report) => (
                <tr key={report.id} className={selectedId === report.id ? 'border-b border-divider bg-muted' : 'border-b border-divider hover:bg-surface focus-within:bg-muted'}>
                  <td className={`border-l-2 px-3 py-0 ${selectedId === report.id ? 'border-primary' : 'border-transparent'}`}>
                    <Button
                      variant="ghost"
                      data-testid={`report-${report.id}`}
                      aria-label={`Open ${report.filename}`}
                      aria-controls="report-detail-panel"
                      title={report.filename}
                      aria-pressed={selectedId === report.id}
                      className="group h-auto min-h-control w-full scroll-mt-16 justify-start rounded-sm px-0 py-2 text-left text-sm whitespace-normal"
                      onClick={(event) => onSelect(report, event.currentTarget)}
                    >
                      <span className="min-w-0 wrap-anywhere group-hover:underline group-focus-visible:underline">{report.filename}</span>
                      <ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
                    </Button>
                    {!patientId && (
                      <p
                        className={patientLabel(report.patientId) ? 'truncate pb-2 text-xs text-muted-foreground' : 'truncate pb-2 font-mono text-xs text-muted-foreground'}
                        title={patientLabel(report.patientId) ?? report.patientId}
                      >
                        {patientLabel(report.patientId) ?? report.patientId}
                      </p>
                    )}
                  </td>
                  <td className="break-words px-2 py-2 sm:px-3">
                    <ReportStatusText status={report.status} />
                  </td>
                  <td className={report.fileUploaded ? 'break-words px-2 py-2 text-success sm:px-3' : 'break-words px-2 py-2 text-primary sm:px-3'}>
                    <span className="inline-flex items-start gap-2">
                      {report.fileUploaded ? (
                        <Check aria-hidden="true" className="mt-0.5 hidden size-4 shrink-0 sm:block" />
                      ) : (
                        <Minus aria-hidden="true" className="mt-0.5 hidden size-4 shrink-0 sm:block" />
                      )}
                      <span>{report.fileUploaded ? 'Verified' : 'Not complete'}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
      ) : (
        <div className="flex h-full flex-col items-start justify-center gap-3 p-5 text-sm text-muted-foreground">
          <h3 className="text-base text-foreground">
            {error
              ? 'Reports unavailable'
              : filteredOut
                ? 'No matches on this page'
                : reports?.meta.total === 0
                  ? 'No reports found for this selection.'
                  : 'No reports on this page'}
          </h3>
          <p>
            {error
              ? 'Try loading this page again. Your patient filter will be kept.'
              : filteredOut
                ? 'Change the filename or storage filter, or reset page filters to see the loaded records.'
                : reports && reports.meta.total > 0
                  ? 'The available records may have changed. Return to the first page to continue.'
                  : patientId
                    ? 'Clear the patient filter to see other available reports.'
                    : 'Report records will appear here after a synthetic report is registered.'}
          </p>
          {error ? (
            <Button variant="outline" onClick={onRetry}>
              Retry loading reports
            </Button>
          ) : filteredOut ? (
            <Button variant="outline" onClick={onResetFilters}>
              Show all records on this page
            </Button>
          ) : reports && reports.meta.total > 0 ? (
            <Button variant="outline" onClick={onFirstPage}>
              Go to first page
            </Button>
          ) : (
            !patientId &&
            canAttach && (
              <Button asChild variant="outline">
                <Link to="/workspace">Attach first report in chat</Link>
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}
