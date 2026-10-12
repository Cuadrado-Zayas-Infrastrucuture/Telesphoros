import { useEffect, useState } from 'react';
import type { Paginated, ReportDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { downloadReport, listReports } from '@/lib/ownedStorageApi';
import { REPORT_TYPE_LABELS } from '@/types/report';

export default function ReportsPage() {
  usePageTitle('Reports');
  const { apiFetch, roles } = useAuth();
  const [query, setQuery] = useState({ page: 1, attempt: 0 });
  const [result, setResult] = useState<Paginated<ReportDto> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);
  const canDownload = roles.some(role => ['clinician', 'reviewer', 'admin'].includes(role));
  useEffect(() => {
    const controller = new AbortController();
    void listReports(apiFetch, query.page, controller.signal).then(value => {
      if (!controller.signal.aborted) { setResult(value); setLoading(false); }
    }).catch(() => { if (!controller.signal.aborted) { setError('Reports could not be loaded. Please retry.'); setLoading(false); } });
    return () => controller.abort();
  }, [apiFetch, query]);
  function load(page: number) { setLoading(true); setError(null); setResult(null); setQuery(old => ({ page, attempt: old.attempt + 1 })); }
  async function download(report: ReportDto) {
    setDownloading(report.id); setError(null);
    try { await downloadReport(apiFetch, report.id, report.filename, report.sizeBytes, report.sha256); }
    catch { setError('This file is unavailable or could not be verified. Refresh Reports and try again.'); }
    finally { setDownloading(null); }
  }
  return <div className="flex max-w-prose flex-col gap-4">
    <h1 className="text-3xl font-bold">Reports</h1>
    <p>Synthetic files only. Storage verification does not indicate clinical review or processing.</p>
    {!canDownload && <p>Your role can view report metadata only.</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <p role="status">{loading ? 'Loading reports…' : result ? `${result.meta.total} reports. Page ${result.meta.page} of ${Math.max(1, result.meta.totalPages)}.` : 'Reports unavailable.'}</p>
    {result && <ul className="flex flex-col gap-4" aria-label="Reports">
      {result.data.map(report => <li key={report.id} className="flex flex-col gap-2 border-b border-divider pb-4">
        <h2 className="break-all text-lg font-semibold">{report.filename}</h2>
        <p>{REPORT_TYPE_LABELS[report.type]} · {report.sizeBytes} bytes</p>
        <p className="break-all">Reference {report.id}</p>
        <p>{report.fileUploaded ? 'Storage verified' : 'Upload incomplete'}</p>
        {canDownload && report.fileUploaded && <Button variant="outline" disabled={downloading !== null} onClick={() => void download(report)}>{downloading === report.id ? 'Verifying download…' : `Download ${report.filename}`}</Button>}
      </li>)}
    </ul>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={loading} onClick={() => load(query.page)}>Refresh reports</Button>
      <Button variant="outline" disabled={loading || query.page <= 1} onClick={() => load(query.page - 1)}>Previous reports</Button>
      <Button variant="outline" disabled={loading || !result || query.page >= result.meta.totalPages} onClick={() => load(query.page + 1)}>Next reports</Button>
    </div>
  </div>;
}
