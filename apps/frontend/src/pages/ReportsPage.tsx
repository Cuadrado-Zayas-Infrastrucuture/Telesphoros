import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpFromLine, RefreshCw } from 'lucide-react';
import type { PatientDto, ReportDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { Button } from '@/components/ui/Button';
import { PaginationControls } from '@/components/PaginationControls';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { PageFilters } from '@/components/reports/PageFilters';
import { PatientFilter } from '@/components/reports/PatientFilter';
import { ReportRecordsTable } from '@/components/reports/ReportRecordsTable';
import { ReportDetails } from '@/components/ReportDetails';
import { ReportStages } from '@/components/ReportStages';
import { usePageTitle } from '@/hooks/usePageTitle';
import { usePatientOptions } from '@/hooks/usePatientOptions';
import { useReportDownload } from '@/hooks/useReportDownload';
import { useReportList } from '@/hooks/useReportList';
import { ownedStorageMode } from '@/lib/storageMode';

export default function ReportsPage() {
  usePageTitle('Reports');
  const { roles } = useAuth();
  const { request, reports, meta: reportMeta, loading: reportsLoading, error: reportError, load } = useReportList();
  const { patients, meta: patientMeta, loading: patientsLoading, error: patientError, requestedPage: patientPage, load: loadPatientOptions } = usePatientOptions();
  // Stage counts follow the patient filter and Refresh, not table pagination.
  const [stagesRefresh, setStagesRefresh] = useState(0);
  const [searchText, setSearchText] = useState('');
  const [uploadFilter, setUploadFilter] = useState('all');
  const [selected, setSelected] = useState<ReportDto | null>(null);
  const downloadRole = roles.some((role) => ['clinician', 'reviewer'].includes(role));
  // Signed file links need explicitly configured storage origins, which only the owned-storage build has (the publish script refuses them).
  const canDownload = downloadRole && ownedStorageMode();
  const canAttach = roles.some((role) => WRITER_ROLES.includes(role));
  const { downloading, error: downloadError, clearError: clearDownloadError, download } = useReportDownload(canDownload);
  const [filterPatient, setFilterPatient] = useState<PatientDto | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const pageSearch = useRef<HTMLInputElement>(null);
  const reportsHeading = useRef<HTMLHeadingElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (selected) detailHeading.current?.focus();
    else selectionTrigger.current?.focus(); // Reveal the mobile list before returning keyboard focus.
  }, [selected]);

  const hasPageFilters = Boolean(searchText.trim()) || uploadFilter !== 'all';
  const visibleReports =
    reports?.data.filter(
      (report) => report.filename.toLowerCase().includes(searchText.trim().toLowerCase()) && (uploadFilter === 'all' || report.fileUploaded === (uploadFilter === 'verified')),
    ) ?? [];
  function changePageFilters(text: string, upload: string) {
    selectionTrigger.current = null;
    setSelected(null);
    clearDownloadError();
    setSearchText(text);
    setUploadFilter(upload);
  }

  function resetPageFilters() {
    changePageFilters('', 'all');
    pageSearch.current?.focus();
  }

  function loadReports(page: number, patientId = request.patientId) {
    if (page !== request.page || patientId !== request.patientId) {
      setSearchText('');
      setUploadFilter('all');
    }
    setSelected(null);
    clearDownloadError();
    selectionTrigger.current = null;
    load(page, patientId);
  }
  function recoverReports(page: number, clearPatient = false) {
    // Recovery buttons disappear during loading. Keep focus on a mounted heading.
    reportsHeading.current?.focus();
    if (clearPatient) setFilterPatient(null);
    loadReports(page, clearPatient ? '' : request.patientId);
  }
  function patientLabel(id: string) {
    return filterPatient?.id === id ? filterPatient.label : patients?.data.find((patient) => patient.id === id)?.label;
  }

  return (
    <div className="reports-workspace flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl leading-tight tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">Report records and verified upload information.</p>
        </div>
        {canAttach && (
          <Button asChild className="min-h-control w-full whitespace-normal px-5 sm:w-auto">
            <Link to="/workspace">
              <ArrowUpFromLine aria-hidden="true" className="size-4 shrink-0" />
              Attach report in chat
            </Link>
          </Button>
        )}
      </div>
      <p className="rounded-lg border border-divider bg-muted px-4 py-3 text-sm">
        <strong>Synthetic data only.</strong> Clinical use not approved. Clinical processing is disabled. Storage verification does not indicate clinical review.
      </p>
      {!downloadRole && <p className="text-sm text-muted-foreground">Your role can view report metadata only.</p>}
      {downloadRole && !canDownload && <p className="text-sm text-muted-foreground">File downloads are not available in this build.</p>}
      <div className="min-w-0">
        <section aria-labelledby="reports-heading" className="min-w-0 rounded-lg border border-divider bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-4 py-3 sm:px-5">
            <h2 id="reports-heading" ref={reportsHeading} tabIndex={-1} className="text-xl">
              Report records
            </h2>
            <Button
              variant="outline"
              size="sm"
              aria-label="Refresh reports"
              aria-disabled={reportsLoading}
              onClick={() => {
                if (reportsLoading) return;
                setStagesRefresh((current) => current + 1);
                loadReports(reports && reports.data.length === 0 ? 1 : request.page);
              }}
            >
              <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
              Refresh
            </Button>
          </div>
          <PatientFilter
            value={request.patientId}
            chosen={filterPatient}
            patients={patients}
            meta={patientMeta}
            loading={patientsLoading}
            error={patientError}
            onSelect={(id) => {
              setFilterPatient(patients?.data.find((patient) => patient.id === id) ?? (filterPatient?.id === id ? filterPatient : null));
              loadReports(1, id);
            }}
            onRefresh={() => loadPatientOptions(patientPage)}
            onClear={() => recoverReports(1, true)}
            onPage={loadPatientOptions}
          />
          <ReportStages key={`${request.patientId}:${stagesRefresh}`} patientId={request.patientId} />
          {reportError && (
            <p role="alert" className="border-t border-divider bg-destructive-surface px-5 py-3 text-sm text-destructive">
              {reportError}
            </p>
          )}
          <PageFilters
            searchRef={pageSearch}
            searchText={searchText}
            uploadFilter={uploadFilter}
            active={hasPageFilters}
            status={reportsLoading ? 'Loading page…' : reportError ? 'Page unavailable.' : `${visibleReports.length} of ${reports?.data.length ?? 0} records on this page.`}
            onChange={changePageFilters}
            onReset={resetPageFilters}
          />
          <ReportRecordsTable
            reports={reports}
            visibleReports={visibleReports}
            loading={reportsLoading}
            error={reportError}
            hasPageFilters={hasPageFilters}
            patientId={request.patientId}
            selectedId={selected?.id}
            canAttach={canAttach}
            patientLabel={patientLabel}
            onSelect={(report, trigger) => {
              selectionTrigger.current = trigger;
              clearDownloadError();
              if (selected?.id === report.id) detailHeading.current?.focus();
              else setSelected(report);
            }}
            onRetry={() => recoverReports(request.page)}
            onFirstPage={() => recoverReports(1)}
            onResetFilters={resetPageFilters}
          />
          <div className="px-4 py-3 sm:px-5">
            <PaginationControls
              label="Report"
              meta={reportMeta}
              busy={reportsLoading}
              preserveFocus
              statusMessage={reportsLoading ? 'Loading reports…' : reportError ? 'Report page unavailable.' : undefined}
              onPage={loadReports}
            />
          </div>
        </section>
        <ContextDrawer
          id="report-detail-panel"
          title="Report details"
          open={Boolean(selected)}
          onClose={() => {
            setSelected(null);
            clearDownloadError();
          }}
          headingRef={detailHeading}
          closeLabel="Back to reports"
        >
          {selected && (
            <section aria-label="Report details">
              <ReportDetails
                report={selected}
                compact={ownedStorageMode() && selected.type === 'structured'}
                patientLabel={patientLabel(selected.patientId)}
                canDownload={canDownload}
                downloading={downloading}
                downloadError={downloadError?.id === selected.id ? downloadError.message : undefined}
                onDownload={download}
              />
            </section>
          )}
        </ContextDrawer>
      </div>
    </div>
  );
}
