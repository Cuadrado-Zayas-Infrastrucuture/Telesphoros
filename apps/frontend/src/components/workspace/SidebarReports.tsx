import { useCallback, useEffect, useState } from 'react';
import type { ReportDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { STATUS_WORD } from '@/components/workspace/PastReports';
import { listReports } from '@/lib/ownedStorageApi';
import { onReportsChanged } from '@/lib/workspaceEvents';

/** The panel's "Past reports": the first page, newest first, each with its status as a word in color (specs/024 D2). Reloads when the chat uploads or checks a report. */
export function SidebarReports() {
  const { apiFetch } = useAuth();
  const [reports, setReports] = useState<ReportDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    (signal?: AbortSignal) => {
      listReports(apiFetch, 1, signal, undefined, 'newest')
        .then((result) => {
          setFailed(false);
          setReports(result.data);
        })
        .catch((caught: unknown) => {
          if (signal?.aborted || caught instanceof SessionEndedError) return;
          setFailed(true);
        });
    },
    [apiFetch],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const stop = onReportsChanged(() => load());
    return () => {
      controller.abort();
      stop();
    };
  }, [load]);
  return (
    <section aria-labelledby="panel-reports-heading" data-panel-item="Past reports" className="workspace-panel-section flex flex-col gap-1 px-3 py-2">
      <p id="panel-reports-heading" className="text-xs font-medium text-muted-foreground">
        Past reports
      </p>
      {failed ? (
        <div role="alert" className="flex flex-col items-start gap-1 text-xs">
          <span className="text-destructive">Reports could not be loaded.</span>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-control px-2"
            onClick={() => {
              setFailed(false);
              load();
            }}
          >
            Retry
          </Button>
        </div>
      ) : reports === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="text-xs text-muted-foreground">No reports yet.</p>
      ) : (
        <ul aria-label="Past reports" className="flex flex-col">
          {reports.map((report) => (
            <li key={report.id} className="py-1 text-xs">
              <span className="block truncate font-medium text-foreground">{report.filename}</span>
              <span className={STATUS_WORD[report.status].tone}>{STATUS_WORD[report.status].label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
