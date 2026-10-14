import type { ReportDto } from '@telesphoros/shared-types';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { REPORT_TYPE_LABELS } from '@/types/report';
import { Download, FileText } from 'lucide-react';

export function ReportDetails({ report, patientLabel, canDownload, downloading, downloadError, onDownload }: { report: ReportDto | null; patientLabel?: string; canDownload: boolean; downloading: string | null; downloadError?: string; onDownload: (report: ReportDto) => void }) {
  if (!report) return <div className="flex flex-col items-start gap-4 p-6"><FileText aria-hidden="true" className="size-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">Select a report to inspect its metadata.</p><p className="text-xs text-muted-foreground">File information and upload verification appear here.</p></div>;
  return (
    <div className="flex min-w-0 flex-col gap-5 p-5">
      <div>
        <p className="break-words text-lg font-semibold">{report.filename}</p>
        <p className="mt-1 text-sm text-muted-foreground">{REPORT_TYPE_LABELS[report.type]}</p>
      </div>
      <dl className="flex flex-col gap-4 rounded-lg bg-background p-4 text-sm">
        <div><dt className="text-muted-foreground">Patient</dt><dd className={patientLabel ? 'mt-1 break-words' : 'mt-1 break-all font-mono'}>{patientLabel ?? report.patientId}</dd></div>
        <div><dt className="text-muted-foreground">Record status</dt><dd className="mt-1 capitalize">{report.status}</dd></div>
        <div><dt className="text-muted-foreground">File uploaded</dt><dd className={report.fileUploaded ? 'mt-1 text-success' : 'mt-1'}>{report.fileUploaded ? 'Yes — server verified' : 'No — not complete'}</dd></div>
      </dl>
      {canDownload && report.fileUploaded && <Button variant="outline" className="h-auto min-h-control w-full whitespace-normal text-sm aria-disabled:opacity-60" aria-label={`Download ${report.filename}`} aria-disabled={downloading !== null} onClick={() => { if (downloading === null) onDownload(report); }}><Download aria-hidden="true" className="size-4 shrink-0" />{downloading === report.id ? 'Verifying download…' : 'Download file'}</Button>}
      {downloadError && <p role="alert" className="text-sm text-destructive">{downloadError}</p>}
      <div className="border-t border-divider pt-4">
        <h3 className="text-base">{report.fileUploaded ? 'Upload verified' : 'Upload not complete'}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{report.fileUploaded
          ? 'The stored file was verified. This does not establish capture acceptance, clinical processing or a guideline result.'
          : 'Only metadata is available. The file has not been marked uploaded.'}</p>
      </div>
      {import.meta.env.DEV && location.hostname === '127.0.0.1' && <div className="border-t border-divider pt-4"><h3 className="text-base">Explore the explanation design</h3><p className="mt-2 text-sm text-muted-foreground">Open a separate synthetic example. This report and its patient information are not used.</p><Button asChild variant="outline" className="mt-3 h-auto min-h-control w-full whitespace-normal"><Link to="/local-interpretation">Open PGx explanation preview</Link></Button></div>}
      <details key={report.id} className="border-t border-divider pt-2">
        <summary className="min-h-control cursor-pointer py-3 text-sm font-semibold">Technical details</summary>
        <dl className="flex flex-col gap-3 pb-2 text-sm">
          <div><dt className="text-muted-foreground">Declared size</dt><dd className="tabular-nums">{report.sizeBytes.toLocaleString()} bytes</dd></div>
          <div><dt className="text-muted-foreground">Content type</dt><dd className="break-words">{report.contentType ?? 'Not recorded'}</dd></div>
          <div><dt className="text-muted-foreground">Created</dt><dd className="tabular-nums"><time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time></dd></div>
          <div><dt className="text-muted-foreground">Updated</dt><dd className="tabular-nums"><time dateTime={report.updatedAt}>{new Date(report.updatedAt).toLocaleString()}</time></dd></div>
          <div><dt className="text-muted-foreground">Report ID</dt><dd className="break-all font-mono" translate="no">{report.id}</dd></div>
        </dl>
      </details>
    </div>
  );
}
