import { useEffect, useState } from 'react';
import type { ApiFetch } from '@/lib/api';
import { UsageLoadError } from '@/lib/usage';
import { calendarYears } from '@/lib/usageCalendar';
import { loadUsageDays, type UsageDaysReport } from '@/lib/usageDays';
import { Button } from '@/components/ui/Button';
import { UsageCalendarSkeleton } from './UsageCalendarSkeleton';
import { UsageCalendarYear } from './UsageCalendarYear';

type Loaded = UsageDaysReport | { state: 'loading' } | { state: 'failed'; message: string };

/** One year's request. Each attempt and each year is a fresh mount (the parent keys it), so loading starts in its initial state. */
export function UsageCalendarLoader({ apiFetch, year, onYears, onRetry }: { apiFetch: ApiFetch; year?: number; onYears: (years: number[]) => void; onRetry: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    loadUsageDays(apiFetch, year, controller.signal).then(
      (report) => {
        setLoaded(report);
        if (report.state === 'ready') onYears(calendarYears(report.days));
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ state: 'failed', message: error instanceof UsageLoadError ? error.message : 'The calendar could not be loaded. Please retry.' });
      },
    );
    return () => controller.abort();
  }, [apiFetch, year, onYears]);

  if (loaded.state === 'loading')
    return (
      <div>
        <p role="status" className="sr-only">
          Loading the calendar…
        </p>
        <UsageCalendarSkeleton />
      </div>
    );
  if (loaded.state === 'ready') return <UsageCalendarYear days={loaded.days} />;
  if (loaded.state === 'unavailable') return <p className="text-muted-foreground">The calendar is not available on this server yet.</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert">{loaded.message}</p>
      <Button variant="outline" className="text-sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
