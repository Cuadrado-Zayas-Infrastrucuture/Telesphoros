import type { ReportDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { REPORT_TYPE_LABELS } from '@/types/report';
import { Check, Download, FileText, Minus } from 'lucide-react';

export function ReportDetails({ report, patientLabel, canDownload, downloading, downloadError, onDownload, compact = false }: { report: ReportDto | null; patientLabel?: string; canDownload: boolean; downloading: string | null; downloadError?: string; onDownload: (report: ReportDto) => void; compact?: boolean }) {
  if (!report) return <div className={compact ? "flex items-center gap-3 p-3" : "flex flex-col items-start gap-4 p-6"}><FileText aria-hidden="true" className={compact ? "size-5 shrink-0 text-muted-foreground" : "size-8 text-muted-foreground"} /><p className="text-sm text-muted-foreground">Select a report to inspect its metadata.</p>{!compact && <p className="text-xs text-muted-foreground">File information and upload verification appear here.</p>}</div>;
  const downloadAction = canDownload && report.fileUploaded && <Button variant="outline" className={`h-auto min-h-control whitespace-normal text-sm aria-disabled:opacity-60 ${compact ? 'shrink-0' : 'w-full'}`} aria-label={`Download ${report.filename}`} aria-disabled={downloading !== null} onClick={() => { if (downloading === null) onDownload(report); }}><Download aria-hidden="true" className="size-4 shrink-0" />{downloading === report.id ? 'Verifying download…' : 'Download file'}</Button>;
  const verificationCompact = <div className="border-t border-divider pt-4"><h3 className="text-base text-primary">{report.fileUploaded ? 'Upload verified' : 'Upload not complete'}</h3><p className="mt-2 text-sm text-muted-foreground">{report.fileUploaded ? 'The stored file was verified. This does not establish capture acceptance, clinical processing or a guideline result.' : 'Only metadata is available. The file has not been marked uploaded.'}</p></div>;
  const verification = <div className={`flex gap-3 rounded-lg p-4 ${report.fileUploaded ? 'bg-success-surface' : 'bg-background'}`}>
    {report.fileUploaded ? <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" /> : <Minus aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />}
    <div><h3 className={`text-base ${report.fileUploaded ? 'text-success' : 'text-primary'}`}>{report.fileUploaded ? 'Upload verified' : 'Upload not complete'}</h3><p className="mt-1 text-sm text-foreground">{report.fileUploaded ? 'The stored file was verified. This does not establish capture acceptance, clinical processing or a guideline result.' : 'Only metadata is available. The file has not been marked uploaded.'}</p></div>
  </div>;
  return (
    <div className={compact ? "report-details--compact flex min-w-0 flex-col gap-1 p-3" : "flex min-w-0 flex-col gap-5 p-5"}>
      <div className={compact ? "flex min-w-0 items-center justify-between gap-3" : undefined}>
        <div className="min-w-0"><p className={compact ? "break-words text-sm font-semibold" : "break-words text-lg font-semibold"}>{report.filename}</p>
        {!compact && <p className="mt-1 text-sm text-muted-foreground">{REPORT_TYPE_LABELS[report.type]}</p>}</div>
      </div>
      {!compact && verification}
      <dl className={compact ? "grid grid-cols-3 gap-2 text-xs" : "grid grid-cols-2 gap-4 rounded-lg bg-background p-4 text-sm"}>
        <div className={compact ? undefined : 'col-span-2'}><dt className="text-muted-foreground">Patient</dt><dd className={patientLabel ? 'mt-1 break-words' : 'mt-1 break-all font-mono'}>{patientLabel ?? report.patientId}</dd></div>
        <div><dt className="text-muted-foreground">Record status</dt><dd className="mt-1 capitalize text-primary">{report.status}</dd></div>
        <div><dt className="text-muted-foreground">File uploaded</dt><dd className={report.fileUploaded ? 'mt-1 text-success' : 'mt-1 text-primary'}>{report.fileUploaded ? 'Yes — server verified' : 'No — not complete'}</dd></div>
      </dl>
      {!compact && downloadAction}
      {downloadError && <p role="alert" className="text-sm text-destructive">{downloadError}</p>}
      {compact && <p className="text-xs text-muted-foreground">Storage status only. Clinical processing is disabled.</p>}
      <div className={compact ? "flex items-start gap-2 border-t border-divider" : undefined}><details key={report.id} className={compact ? "min-w-0 flex-1" : "border-t border-divider"}>
        <summary className="min-h-control cursor-pointer py-3 text-sm font-semibold">Technical details</summary>
        {compact && <div className="mb-3"><p className="text-sm text-muted-foreground">{REPORT_TYPE_LABELS[report.type]}</p>{verificationCompact}</div>}
        <dl className="flex flex-col gap-3 pb-2 text-sm">
          <div><dt className="text-muted-foreground">Declared size</dt><dd className="tabular-nums">{report.sizeBytes.toLocaleString()} bytes</dd></div>
          <div><dt className="text-muted-foreground">Content type</dt><dd className="break-words">{report.contentType ?? 'Not recorded'}</dd></div>
          <div><dt className="text-muted-foreground">Created</dt><dd className="tabular-nums"><time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time></dd></div>
          <div><dt className="text-muted-foreground">Updated</dt><dd className="tabular-nums"><time dateTime={report.updatedAt}>{new Date(report.updatedAt).toLocaleString()}</time></dd></div>
          <div><dt className="text-muted-foreground">Report ID</dt><dd className="break-all font-mono" translate="no">{report.id}</dd></div>
        </dl>
      </details>{compact && downloadAction}</div>
    </div>
  );
}
