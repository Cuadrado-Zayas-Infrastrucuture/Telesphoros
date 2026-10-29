import { useEffect, useState } from 'react';
import type { ReportDto, ReportStatus } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { listReports } from '@/lib/ownedStorageApi';
import { SubmitError } from '@/lib/api';

/** Status as a word in color, never a badge. */
export const STATUS_WORD: Record<ReportStatus, { label: string; tone: string }> = {
  received: { label: 'Received', tone: 'text-warning' },
  processing: { label: 'Processing', tone: 'text-warning' },
  processed: { label: 'Processed', tone: 'text-success' },
  failed: { label: 'Failed', tone: 'text-destructive' },
};

/** The first page of reports, in the existing drawer (specs/016 D7). The parent remounts it (a new key) on each opening, so it is never stale. */
export function PastReports({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { apiFetch } = useAuth();
  const [reports, setReports] = useState<ReportDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    listReports(apiFetch, 1, controller.signal)
      .then((page) => setReports(page.data))
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        setError(caught instanceof SubmitError ? caught.message : 'Reports could not be loaded. Please retry.');
      });
    return () => controller.abort();
  }, [open, apiFetch, attempt]);
  return (
    <ContextDrawer open={open} onClose={onClose} title="Past reports" id="one-screen-history">
      {error ? (
        <div role="alert" className="flex flex-col items-start gap-3 text-sm">
          <p className="text-destructive">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : reports === null ? (
        <>
          <p role="status" className="sr-only">
            Loading reports…
          </p>
          <div aria-hidden="true" className="flex flex-col gap-3">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-10 w-full" />
            ))}
          </div>
        </>
      ) : reports.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reports yet. Attach one in the box to start.</p>
      ) : (
        <ul className="flex flex-col">
          {reports.map((report) => (
            <li key={report.id} className="border-b border-divider py-2 last:border-0">
              <span className="block truncate text-sm font-medium">{report.filename}</span>
              <span className={`text-xs ${STATUS_WORD[report.status].tone}`}>{STATUS_WORD[report.status].label}</span>
              <span className="text-xs text-muted-foreground"> · {new Date(report.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            </li>
          ))}
        </ul>
      )}
    </ContextDrawer>
  );
}
