import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpFromLine, Check, ChevronDown, ChevronRight, Minus, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import type { Paginated, PaginationMeta, PatientDto, ReportDto } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { PaginationControls } from '@/components/PaginationControls';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { ReportStatusText } from '@/components/ReportStatusText';
import { ReportDetails } from '@/components/ReportDetails';
import { ReportListSkeleton } from '@/components/ReportListSkeleton';
import { ReportStages } from '@/components/ReportStages';
import { usePageTitle } from '@/hooks/usePageTitle';
import { listPatients, SubmitError } from '@/lib/api';
import { downloadReport, listReports } from '@/lib/ownedStorageApi';
import { ownedStorageMode } from '@/lib/storageMode';

const REPORT_PAGE_SIZE = 20;

const EMPTY_META: PaginationMeta = { page: 1, pageSize: REPORT_PAGE_SIZE, total: 0, totalPages: 0 };

export default function ReportsPage() {
  usePageTitle('Reports');
  const { apiFetch, roles } = useAuth();
  const [request, setRequest] = useState({ page: 1, patientId: '', attempt: 0 });
  const [reports, setReports] = useState<Paginated<ReportDto> | null>(null);
  const [reportMeta, setReportMeta] = useState(EMPTY_META);
  const [reportsLoading, setReportsLoading] = useState(true);
  // Stage counts follow the patient filter and Refresh, not table pagination.
  const [stagesRefresh, setStagesRefresh] = useState(0);
  const [searchText, setSearchText] = useState('');
  const [uploadFilter, setUploadFilter] = useState('all');
  const [selected, setSelected] = useState<ReportDto | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ id: string; message: string } | null>(null);
  const downloadRole = roles.some((role) => ['clinician', 'reviewer'].includes(role));
  // Signed file links need explicitly configured storage origins, which only the owned-storage build has (the publish script refuses them).
  const canDownload = downloadRole && ownedStorageMode();
  const [reportError, setReportError] = useState<string | null>(null);
  const [patientRequest, setPatientRequest] = useState({ page: 1, attempt: 0 });
  const [patients, setPatients] = useState<Paginated<PatientDto> | null>(null);
  const [patientMeta, setPatientMeta] = useState(EMPTY_META);
  const [patientsLoading, setPatientsLoading] = useState(true);
  const [filterPatient, setFilterPatient] = useState<PatientDto | null>(null);
  const [patientError, setPatientError] = useState<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const pageSearch = useRef<HTMLInputElement>(null);
  const reportsHeading = useRef<HTMLHeadingElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listReports(apiFetch, request.page, controller.signal, request.patientId || undefined)
      .then((result) => {
        if (!controller.signal.aborted) {
          setReports(result);
          setReportMeta(result.meta);
          setReportsLoading(false);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && !(error instanceof SessionEndedError) && !(error instanceof NotSignedInError)) {
          setReportError(error instanceof SubmitError ? error.message : 'Reports could not be loaded. Please retry.');
          setReportsLoading(false);
        }
      });
    return () => controller.abort();
  }, [apiFetch, request]);

  useEffect(() => {
    const controller = new AbortController();
    void listPatients(apiFetch, patientRequest.page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setPatients(result);
          setPatientMeta(result.meta);
          setPatientsLoading(false);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && !(error instanceof SessionEndedError) && !(error instanceof NotSignedInError)) {
          setPatientError('Patient options could not be loaded. Reports remain available.');
          setPatientsLoading(false);
        }
      });
    return () => controller.abort();
  }, [apiFetch, patientRequest]);

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
    setDownloadError(null);
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
    setReports(null);
    setSelected(null);
    setReportError(null);
    setDownloadError(null);
    setReportsLoading(true);
    selectionTrigger.current = null;
    setReportMeta((current) => ({ ...current, page }));
    setRequest((current) => ({ page, patientId, attempt: current.attempt + 1 }));
  }
  function loadPatientOptions(page: number) {
    setPatients(null);
    setPatientError(null);
    setPatientsLoading(true);
    setPatientMeta((current) => ({ ...current, page }));
    setPatientRequest((current) => ({ page, attempt: current.attempt + 1 }));
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

  async function download(report: ReportDto) {
    if (downloading !== null || !canDownload || !report.fileUploaded) return;
    setDownloading(report.id);
    setDownloadError(null);
    try {
      await downloadReport(apiFetch, report.id, report.filename, report.sizeBytes, report.sha256);
    } catch (error) {
      if (!(error instanceof SessionEndedError) && !(error instanceof NotSignedInError)) {
        setDownloadError({ id: report.id, message: 'This file is unavailable or could not be verified. Refresh Reports and try again.' });
      }
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="reports-workspace flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl leading-tight tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">Report records and verified upload information.</p>
        </div>
        {roles.some((role) => WRITER_ROLES.includes(role)) && (
          <Button asChild className="min-h-control w-full whitespace-normal px-5 sm:w-auto">
            <Link to="/reports/upload">
              <ArrowUpFromLine aria-hidden="true" className="size-4 shrink-0" />
              Upload synthetic report
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
          <div className="flex flex-col gap-2 bg-background px-4 py-4 sm:px-5">
            <label htmlFor="patient-filter" className="flex items-center gap-2 text-sm font-medium">
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              Filter by patient
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <NativeSelect
                id="patient-filter"
                className="min-w-0 flex-1"
                value={request.patientId}
                disabled={patientsLoading}
                onChange={(event) => {
                  const id = event.target.value;
                  setFilterPatient(patients?.data.find((patient) => patient.id === id) ?? (filterPatient?.id === id ? filterPatient : null));
                  loadReports(1, id);
                }}
              >
                <option value="">All patients</option>
                {filterPatient && !patients?.data.some((patient) => patient.id === filterPatient.id) && <option value={filterPatient.id}>{filterPatient.label}</option>}
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
                aria-disabled={patientsLoading}
                className="shrink-0 px-0"
                onClick={() => {
                  if (!patientsLoading) loadPatientOptions(patientRequest.page);
                }}
              >
                <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
              </Button>
              {request.patientId && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Clear patient filter"
                  title="Clear patient filter"
                  className="shrink-0 px-0"
                  onClick={() => recoverReports(1, true)}
                >
                  <X aria-hidden="true" className="size-4 shrink-0" />
                </Button>
              )}
            </div>
            {patientMeta.totalPages <= 1 && (
              <p role="status" className={patientsLoading || !patients || patients.meta.total === 0 ? 'text-xs text-muted-foreground' : 'sr-only'}>
                {patientsLoading
                  ? 'Loading patient options…'
                  : patients?.meta.total === 0
                    ? 'No patient options available.'
                    : patients
                      ? 'Showing available patient options.'
                      : 'Patient options unavailable.'}
              </p>
            )}
            {patientError && (
              <p role="alert" className="text-sm text-destructive">
                {patientError}
              </p>
            )}
            {patientMeta.totalPages > 1 && (
              <PaginationControls
                compact
                label="Patient"
                meta={patientMeta}
                busy={patientsLoading}
                preserveFocus
                statusMessage={
                  patientsLoading
                    ? 'Loading patient options…'
                    : patientError
                      ? 'Patient page unavailable.'
                      : `Patient options: page ${patientMeta.page} of ${patientMeta.totalPages}.`
                }
                onPage={loadPatientOptions}
              />
            )}
          </div>
          <ReportStages key={`${request.patientId}:${stagesRefresh}`} patientId={request.patientId} />
          {reportError && (
            <p role="alert" className="border-t border-divider bg-destructive-surface px-5 py-3 text-sm text-destructive">
              {reportError}
            </p>
          )}
          <details className="group border-t border-divider px-4 sm:px-5">
            <summary className="flex min-h-control cursor-pointer items-center text-sm font-medium">
              Search and filter this page{hasPageFilters ? ' — active' : ''}
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
                    ref={pageSearch}
                    id="report-search"
                    type="search"
                    value={searchText}
                    aria-describedby="page-filter-help"
                    onChange={(event) => changePageFilters(event.target.value, uploadFilter)}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor="upload-filter" className="text-sm font-medium">
                    Storage upload
                  </label>
                  <NativeSelect id="upload-filter" value={uploadFilter} aria-describedby="page-filter-help" onChange={(event) => changePageFilters(searchText, event.target.value)}>
                    <option value="all">All upload states</option>
                    <option value="verified">Verified storage</option>
                    <option value="incomplete">Incomplete storage</option>
                  </NativeSelect>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p role="status" className="text-sm text-muted-foreground">
                  {reportsLoading ? 'Loading page…' : reportError ? 'Page unavailable.' : `${visibleReports.length} of ${reports?.data.length ?? 0} records on this page.`}
                </p>
                <Button variant="ghost" size="sm" disabled={!hasPageFilters} onClick={resetPageFilters}>
                  Reset page filters
                </Button>
              </div>
            </div>
          </details>
          <div
            role="region"
            aria-label="Report records table"
            aria-busy={reportsLoading}
            tabIndex={0}
            className="report-records-region h-report-list max-w-full overflow-auto border-y border-divider"
          >
            {reportsLoading || visibleReports.length ? (
              <table className="w-full table-fixed text-left text-sm">
                <caption className="sr-only">Reports on the selected page</caption>
                <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="w-1/2 px-3 py-3 sm:w-5/12">
                      {request.patientId ? 'Report' : 'Report / patient'}
                    </th>
                    <th scope="col" className="w-1/4 px-2 py-3 sm:px-3">
                      Record status
                    </th>
                    <th scope="col" className="w-1/4 px-2 py-3 sm:w-1/3 sm:px-3">
                      Upload
                    </th>
                  </tr>
                </thead>
                {reportsLoading ? (
                  <ReportListSkeleton showPatient={!request.patientId} />
                ) : (
                  <tbody>
                    {visibleReports.map((report) => (
                      <tr
                        key={report.id}
                        className={selected?.id === report.id ? 'border-b border-divider bg-muted' : 'border-b border-divider hover:bg-surface focus-within:bg-muted'}
                      >
                        <td className={`border-l-2 px-3 py-0 ${selected?.id === report.id ? 'border-primary' : 'border-transparent'}`}>
                          <Button
                            variant="ghost"
                            data-testid={`report-${report.id}`}
                            aria-label={`Open ${report.filename}`}
                            aria-controls="report-detail-panel"
                            title={report.filename}
                            aria-pressed={selected?.id === report.id}
                            className="group h-auto min-h-control w-full scroll-mt-16 justify-start rounded-sm px-0 py-2 text-left text-sm whitespace-normal"
                            onClick={(event) => {
                              selectionTrigger.current = event.currentTarget;
                              setDownloadError(null);
                              if (selected?.id === report.id) detailHeading.current?.focus();
                              else setSelected(report);
                            }}
                          >
                            <span className="min-w-0 wrap-anywhere group-hover:underline group-focus-visible:underline">{report.filename}</span>
                            <ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
                          </Button>
                          {!request.patientId && (
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
                  {reportError
                    ? 'Reports unavailable'
                    : hasPageFilters && reports?.data.length
                      ? 'No matches on this page'
                      : reports?.meta.total === 0
                        ? 'No reports found for this selection.'
                        : 'No reports on this page'}
                </h3>
                <p>
                  {reportError
                    ? 'Try loading this page again. Your patient filter will be kept.'
                    : hasPageFilters && reports?.data.length
                      ? 'Change the filename or storage filter, or reset page filters to see the loaded records.'
                      : reports && reports.meta.total > 0
                        ? 'The available records may have changed. Return to the first page to continue.'
                        : request.patientId
                          ? 'Clear the patient filter to see other available reports.'
                          : 'Report records will appear here after a synthetic report is registered.'}
                </p>
                {reportError ? (
                  <Button variant="outline" onClick={() => recoverReports(request.page)}>
                    Retry loading reports
                  </Button>
                ) : hasPageFilters && reports?.data.length ? (
                  <Button variant="outline" onClick={resetPageFilters}>
                    Show all records on this page
                  </Button>
                ) : reports && reports.meta.total > 0 ? (
                  <Button variant="outline" onClick={() => recoverReports(1)}>
                    Go to first page
                  </Button>
                ) : (
                  !request.patientId &&
                  roles.some((role) => WRITER_ROLES.includes(role)) && (
                    <Button asChild variant="outline">
                      <Link to="/reports/upload">Upload first synthetic report</Link>
                    </Button>
                  )
                )}
              </div>
            )}
          </div>
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
            setDownloadError(null);
          }}
          headingRef={detailHeading}
          closeLabel="Back to reports"
        >
          {selected && (
            <section aria-label="Report details">
              <ReportDetails
                report={selected}
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
