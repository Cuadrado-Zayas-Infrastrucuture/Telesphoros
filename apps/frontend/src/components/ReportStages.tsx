import { useEffect, useState } from 'react';
import { NotSignedInError, SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { ReportStageNote } from '@/components/ReportStageNote';
import { ReportStageSummary } from '@/components/ReportStageSummary';
import { Skeleton } from '@/components/ui/Skeleton';
import { SubmitError } from '@/lib/api';
import { countReportStages, formatCount, type ReportStageCounts } from '@/lib/reportStages';

type StagesState = { status: 'loading' } | { status: 'ready'; counts: ReportStageCounts } | { status: 'error'; message: string };

/** Report stages for the current patient filter. Remount (key) to recount; the parent keys it on filter and Refresh. */
export function ReportStages({ patientId }: { patientId: string }) {
  const { apiFetch } = useAuth();
  const [state, setState] = useState<StagesState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void countReportStages(apiFetch, controller.signal, patientId || undefined)
      .then((counts) => {
        if (!controller.signal.aborted) setState({ status: 'ready', counts });
      })
      .catch((error) => {
        if (!controller.signal.aborted && !(error instanceof SessionEndedError) && !(error instanceof NotSignedInError)) {
          setState({ status: 'error', message: error instanceof SubmitError ? error.message : 'Report stages could not be counted. Please retry.' });
        }
      });
    return () => controller.abort();
  }, [apiFetch, patientId, attempt]);

  function retry() {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  }

  return (
    <section aria-labelledby="report-stages-heading" aria-busy={state.status === 'loading'} className="flex flex-col gap-2 border-t border-divider px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h3 id="report-stages-heading" className="text-sm font-medium">
          Report stages
        </h3>
        {state.status === 'ready' && state.counts.registered > 0 && (
          <p className="text-sm">
            <span className={state.counts.failed > 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'}>Failed</span> {formatCount(state.counts.failed)}
          </p>
        )}
      </div>
      {state.status === 'loading' && (
        <>
          <p role="status" className="sr-only">
            Counting report stages…
          </p>
          {/* Shaped like the counted result (funnel, three label/value pairs, note), so nothing jumps when counts arrive. */}
          <Skeleton className="h-16 w-full" />
          <div aria-hidden="true" className="grid w-full grid-cols-3 gap-x-2 text-sm">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex flex-col">
                <span className="flex h-5 items-center">
                  <Skeleton className="h-3 w-2/3" />
                </span>
                <span className="flex h-5 items-center">
                  <Skeleton className="h-3 w-1/2" />
                </span>
              </div>
            ))}
          </div>
          <ReportStageNote />
        </>
      )}
      {state.status === 'error' && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry count
          </Button>
        </div>
      )}
      {state.status === 'ready' && <ReportStageSummary counts={state.counts} />}
    </section>
  );
}
