import { useEffect, useState } from 'react';
import type { ApiFetch } from '@/lib/api';
import { loadUsage, UsageLoadError, type UsageReport } from '@/lib/usage';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/SkeletonCard';
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
      // Shaped like UsageSummary (two month cards, then storage), so nothing moves when the figures arrive.
      <div className="flex flex-col gap-6">
        <p role="status" className="sr-only">
          Loading usage…
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonCard rows={2} description />
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
