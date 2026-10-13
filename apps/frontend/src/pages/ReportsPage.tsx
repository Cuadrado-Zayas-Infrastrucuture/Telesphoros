import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Paginated, PaginationMeta, PatientDto, ReportDto } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { Button } from '@/components/ui/Button';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { PaginationControls } from '@/components/PaginationControls';
import { ReportDetails } from '@/components/ReportDetails';
import { usePageTitle } from '@/hooks/usePageTitle';
import { listPatients, SubmitError } from '@/lib/api';
import { downloadReport, listReports } from '@/lib/ownedStorageApi';

const REPORT_PAGE_SIZE = 20;

const EMPTY_META: PaginationMeta = { page: 1, pageSize: REPORT_PAGE_SIZE, total: 0, totalPages: 0 };

export default function ReportsPage() {
  usePageTitle('Reports');
  const { apiFetch, roles } = useAuth();
  const [request, setRequest] = useState({ page: 1, patientId: '', attempt: 0 });
  const [reports, setReports] = useState<Paginated<ReportDto> | null>(null);
  const [reportMeta, setReportMeta] = useState(EMPTY_META);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [selected, setSelected] = useState<ReportDto | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ id: string; message: string } | null>(null);
  const canDownload = roles.some(role => ['clinician', 'reviewer', 'admin'].includes(role));
  const [reportError, setReportError] = useState<string | null>(null);
  const [patientRequest, setPatientRequest] = useState({ page: 1, attempt: 0 });
  const [patients, setPatients] = useState<Paginated<PatientDto> | null>(null);
  const [patientMeta, setPatientMeta] = useState(EMPTY_META);
  const [patientsLoading, setPatientsLoading] = useState(true);
  const [filterPatient, setFilterPatient] = useState<PatientDto | null>(null);
  const [patientError, setPatientError] = useState<string | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listReports(apiFetch, request.page, controller.signal, request.patientId || undefined).then(result => {
      if (!controller.signal.aborted) {
        setReports(result); setReportMeta(result.meta); setReportsLoading(false);
      }
    }).catch(error => {
      if (!controller.signal.aborted && !(error instanceof SessionEndedError) && !(error instanceof NotSignedInError)) {
        setReportError(error instanceof SubmitError ? error.message : 'Reports could not be loaded. Please retry.');
        setReportsLoading(false);
      }
    });
    return () => controller.abort();
  }, [apiFetch, request]);

  useEffect(() => {
    const controller = new AbortController();
    void listPatients(apiFetch, patientRequest.page, controller.signal).then(result => {
      if (!controller.signal.aborted) { setPatients(result); setPatientMeta(result.meta); setPatientsLoading(false); }
    }).catch(error => {
      if (!controller.signal.aborted && !(error instanceof SessionEndedError) && !(error instanceof NotSignedInError)) {
        setPatientError('Patient options could not be loaded. Reports remain available.'); setPatientsLoading(false);
      }
    });
    return () => controller.abort();
  }, [apiFetch, patientRequest]);

  useEffect(() => {
    if (selected) detailHeading.current?.focus();
    else selectionTrigger.current?.focus(); // Reveal the mobile list before returning keyboard focus.
  }, [selected]);

  function loadReports(page: number, patientId = request.patientId) {
    setReports(null); setSelected(null); setReportError(null); setDownloadError(null); setReportsLoading(true);
    selectionTrigger.current = null;
    setReportMeta(current => ({ ...current, page }));
    setRequest(current => ({ page, patientId, attempt: current.attempt + 1 }));
  }
  function loadPatientOptions(page: number) {
    setPatients(null); setPatientError(null); setPatientsLoading(true);
    setPatientMeta(current => ({ ...current, page }));
    setPatientRequest(current => ({ page, attempt: current.attempt + 1 }));
  }
  function patientLabel(id: string) {
    return filterPatient?.id === id ? filterPatient.label : patients?.data.find(patient => patient.id === id)?.label;
  }

  async function download(report: ReportDto) {
    if (downloading !== null || !canDownload || !report.fileUploaded) return;
    setDownloading(report.id); setDownloadError(null);
    try { await downloadReport(apiFetch, report.id, report.filename, report.sizeBytes, report.sha256); }
    catch (error) {
      if (!(error instanceof SessionEndedError) && !(error instanceof NotSignedInError)) {
        setDownloadError({ id: report.id, message: 'This file is unavailable or could not be verified. Refresh Reports and try again.' });
      }
    } finally { setDownloading(null); }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-3xl leading-tight tracking-tight">Reports</h1><p className="mt-1 text-sm text-muted-foreground">Report records and verified upload information.</p></div>
        {roles.some(role => WRITER_ROLES.includes(role)) && <Button asChild className="h-auto min-h-control w-full whitespace-normal px-5 text-sm sm:w-auto"><Link to="/reports/upload">Upload synthetic report</Link></Button>}
      </div>
      <p className="border-l-4 border-primary bg-muted px-4 py-3 text-sm">Synthetic data only. Clinical use not approved. Clinical processing is disabled. Storage verification does not indicate clinical review.</p>
      {!canDownload && <p className="text-sm text-muted-foreground">Your role can view report metadata only.</p>}
      <div className="grid min-w-0 grid-cols-1 items-start gap-7 lg:grid-cols-3">
        <section aria-labelledby="reports-heading" className={selected ? 'hidden min-w-0 lg:col-span-2 lg:block' : 'min-w-0 lg:col-span-2'}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider pb-3">
            <h2 id="reports-heading" className="text-xl">Report records</h2>
            <Button variant="ghost" className="h-auto min-h-control whitespace-normal px-2 text-sm underline underline-offset-4 aria-disabled:opacity-60" aria-disabled={reportsLoading} onClick={() => { if (!reportsLoading) loadReports(reports && reports.data.length === 0 ? 1 : request.page); }}>Refresh reports</Button>
          </div>
          <div className="flex flex-col gap-2 py-4">
            <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label htmlFor="patient-filter" className="mb-1 block text-sm font-medium">Filter by patient</label>
                <NativeSelect id="patient-filter" value={request.patientId} disabled={patientsLoading} onChange={event => {
                  const id = event.target.value;
                  setFilterPatient(patients?.data.find(patient => patient.id === id) ?? (filterPatient?.id === id ? filterPatient : null));
                  loadReports(1, id);
                }}>
                  <option value="">All patients</option>
                  {filterPatient && !patients?.data.some(patient => patient.id === filterPatient.id) && <option value={filterPatient.id}>{filterPatient.label}</option>}
                  {patients?.data.map(patient => <option key={patient.id} value={patient.id}>{patient.label}</option>)}
                </NativeSelect>
              </div>
              <Button variant="ghost" className="h-auto min-h-control self-start whitespace-normal px-2 text-sm underline underline-offset-4 aria-disabled:opacity-60 sm:self-auto" aria-disabled={patientsLoading} onClick={() => { if (!patientsLoading) loadPatientOptions(patientRequest.page); }}>Refresh patient options</Button>
            </div>
            <p role="status" className="text-xs text-muted-foreground">{patientsLoading ? 'Loading patient options…' : patients?.meta.total === 0 ? 'No patient options available.' : patients && patients.meta.totalPages > 1 ? `Patient options: page ${patients.meta.page} of ${patients.meta.totalPages}.` : patients ? 'Showing available patient options.' : 'Patient options unavailable.'}</p>
            {patientError && <p role="alert" className="text-sm text-destructive">{patientError}</p>}
            {patientMeta.totalPages > 1 && <PaginationControls label="Patient" meta={patientMeta} busy={patientsLoading} preserveFocus statusMessage={patientError ? 'Patient page unavailable.' : undefined} onPage={loadPatientOptions} />}
          </div>
          {reportError && <p role="alert" className="mb-3 text-sm text-destructive">{reportError}</p>}
          <div role="region" aria-label="Report records table" aria-busy={reportsLoading} tabIndex={0} className="h-report-list max-w-full overflow-auto border-y border-divider">
            {reportsLoading ? <p className="p-5 text-sm text-muted-foreground">Loading reports…</p> : reports?.data.length ? <table className="w-full table-fixed text-left text-sm">
              <caption className="sr-only">Reports on the selected page</caption>
              <thead className="sticky top-0 bg-muted"><tr><th scope="col" className="w-1/2 px-3 py-3">Report / patient</th><th scope="col" className="w-1/4 px-3 py-3">Record status</th><th scope="col" className="w-1/4 px-3 py-3">Upload</th></tr></thead>
              <tbody>{reports.data.map(report => <tr key={report.id} className={selected?.id === report.id ? 'border-b border-divider bg-muted' : 'border-b border-divider hover:bg-surface'}>
                <td className="px-3 py-0">
                  <Button variant="ghost" data-testid={`report-${report.id}`} aria-label={`Open ${report.filename}`} title={report.filename} aria-pressed={selected?.id === report.id} className="min-h-control w-full scroll-mt-16 justify-start px-0 text-sm" onClick={event => { selectionTrigger.current = event.currentTarget; setDownloadError(null); if (selected?.id === report.id) detailHeading.current?.focus(); else setSelected(report); }}><span className="truncate">{report.filename}</span></Button>
                  <p className={patientLabel(report.patientId) ? 'pb-1 break-words text-xs text-muted-foreground' : 'truncate pb-1 font-mono text-xs text-muted-foreground'} title={patientLabel(report.patientId) ?? report.patientId}>{patientLabel(report.patientId) ?? report.patientId}</p>
                </td>
                <td className="break-words px-3 py-2 capitalize">{report.status}</td><td className={report.fileUploaded ? 'break-words px-3 py-2 text-success' : 'break-words px-3 py-2'}>{report.fileUploaded ? 'Verified' : 'Not complete'}</td>
              </tr>)}</tbody>
            </table> : <div className="flex h-full flex-col items-start justify-center gap-3 p-5 text-sm text-muted-foreground">
              <p>{reportError ? 'Report records are unavailable. Retry with Refresh reports.' : reports?.meta.total === 0 ? 'No reports found for this selection.' : 'This page has no reports. Return to an earlier page or refresh the list.'}</p>
              {request.patientId && <Button variant="outline" onClick={() => { setFilterPatient(null); loadReports(1, ''); }}>Show all patients</Button>}
            </div>}
          </div>
          <div className="pt-3"><PaginationControls label="Report" meta={reportMeta} busy={reportsLoading} preserveFocus statusMessage={reportError ? 'Report page unavailable.' : undefined} onPage={loadReports} /></div>
        </section>
        <section aria-labelledby="report-detail-heading" className={selected ? 'min-w-0 rounded-md bg-surface' : 'hidden min-w-0 rounded-md bg-surface lg:block'}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-5 py-3">
            <h2 id="report-detail-heading" ref={detailHeading} tabIndex={-1} className="text-xl">Report details</h2>
            {selected && <Button variant="ghost" className="h-auto min-h-control whitespace-normal px-0 text-sm underline underline-offset-4" onClick={() => { setSelected(null); setDownloadError(null); }}>Back to reports</Button>}
          </div>
          <ReportDetails report={selected} patientLabel={selected ? patientLabel(selected.patientId) : undefined} canDownload={canDownload} downloading={downloading} downloadError={downloadError?.id === selected?.id ? downloadError?.message : undefined} onDownload={download} />
        </section>
      </div>
    </div>
  );
}
