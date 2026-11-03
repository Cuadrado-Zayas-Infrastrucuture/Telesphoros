import { useState } from 'react';
import type { ReportDto } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { downloadReport } from '@/lib/ownedStorageApi';

/** Downloads one verified report file at a time. A failure is remembered against the report it belongs to. */
export function useReportDownload(canDownload: boolean) {
  const { apiFetch } = useAuth();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  async function download(report: ReportDto) {
    if (downloading !== null || !canDownload || !report.fileUploaded) return;
    setDownloading(report.id);
    setError(null);
    try {
      await downloadReport(apiFetch, report.id, report.filename, report.sizeBytes, report.sha256);
    } catch (caught) {
      if (!(caught instanceof SessionEndedError) && !(caught instanceof NotSignedInError)) {
        setError({ id: report.id, message: 'This file is unavailable or could not be verified. Refresh Reports and try again.' });
      }
    } finally {
      setDownloading(null);
    }
  }
  return { downloading, error, clearError: () => setError(null), download };
}
