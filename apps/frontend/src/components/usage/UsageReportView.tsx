import { useEffect, useState } from 'react';
import type { ApiFetch } from '@/lib/api';
import { loadUsage, UsageLoadError, type UsageReport } from '@/lib/usage';
import { Button } from '@/components/ui/Button';
import { UsageSummary } from './UsageSummary';

type Loaded = UsageReport | { state: 'loading' } | { state: 'failed'; message: string };

/** Loads and shows usage. Each attempt is a fresh mount (the page keys it), so loading starts in its initial state. */
export function UsageReportView({ apiFetch, onRetry }: { apiFetch: ApiFetch; onRetry: () => void }) {
  const [report, setReport] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    loadUsage(apiFetch, controller.signal).then(
      (loaded) => setReport(loaded),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setReport({ state: 'failed', message: error instanceof UsageLoadError ? error.message : 'Usage could not be loaded. Please retry.' });
      },
    );
    return () => controller.abort();
  }, [apiFetch]);

  if (report.state === 'loading')
    return (
      <div>
        <p role="status" className="sr-only">
          Loading usage…
        </p>
        <UsageSummary usage={null} />
      </div>
    );
  if (report.state === 'ready') return <UsageSummary usage={report.usage} />;
  if (report.state === 'unavailable') return <p className="text-muted-foreground">Usage is not available on this server yet.</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert">{report.message}</p>
      <Button variant="outline" className="text-sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
