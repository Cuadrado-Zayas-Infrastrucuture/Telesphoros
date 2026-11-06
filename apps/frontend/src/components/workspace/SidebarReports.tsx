import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useCallback, useEffect, useState } from 'react';
import type { ReportDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Link } from 'react-router-dom';
import { ReportStatusText } from '@/components/ReportStatusText';
import { listReports } from '@/lib/ownedStorageApi';
import { onReportsChanged } from '@/lib/workspaceEvents';

/**
 * The panel's "Recents" (specs/034, was "Past reports", specs/024 D2): the first page, newest first, one line each with the status as a word in color.
 * A row opens that report on the Reports page. Reloads when the chat uploads or checks a report.
 */
/** The file name without its report extension; the full name stays in the row's tooltip. */
const shortName = (filename: string) => filename.replace(/\.(json|pdf)$/i, '') || filename;

export function SidebarReports({ onNavigate }: { onNavigate?: () => void }) {
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
    <section aria-labelledby="panel-reports-heading" data-panel-item="Recents" className="workspace-panel-section workspace-recents flex min-h-0 flex-col gap-1">
      <p id="panel-reports-heading" className="workspace-group-label px-3 text-xs font-medium text-muted-foreground">
        Recents
      </p>
      {failed ? (
        <div role="alert" className="flex flex-col items-start gap-1 px-3 text-xs">
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
        <div className="px-3">
          <ContentSkeleton label="Loading reports…" variant="compact" />
        </div>
      ) : reports.length === 0 ? (
        <p className="px-3 text-xs text-muted-foreground">No reports yet.</p>
      ) : (
        <div role="region" aria-label="Recent reports" tabIndex={0} className="workspace-recents-list rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
          <ul aria-label="Recent reports" className="flex flex-col">
            {reports.map((report) => (
              <li key={report.id}>
                <Link
                  to="/reports"
                  state={{ report }}
                  onClick={onNavigate}
                  title={report.filename}
                  className="flex min-h-control min-w-0 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <span className="min-w-0 flex-1 truncate">{shortName(report.filename)}</span>
                  <span className="sr-only">, </span>
                  <ReportStatusText status={report.status} className="shrink-0 text-xs" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
