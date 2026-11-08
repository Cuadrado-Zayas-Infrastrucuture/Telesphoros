import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useEffect, useState } from 'react';
import type { EvaluationSummaryDto, Paginated } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { readPatientResults, type DecisionLink } from '@/lib/clinicianDecisions';
import { SubmitError } from '@/lib/api';
import { evaluationStanding } from '@/lib/resultStatus';
import { syntheticStagingMode } from '@/lib/storageMode';
import { StandingNotices } from '@/components/StandingNotices';
import { StoredResult } from './StoredResult';

export function ResultsList({ patientId, followupBusy, onFollowup }: { patientId: string; followupBusy: boolean; onFollowup: (link: DecisionLink) => void }) {
  const { apiFetch } = useAuth();
  // In the synthetic staging a result can be read but nothing can be recorded about it (decisions are not switched on there).
  const decisions = !syntheticStagingMode();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  // A correction can land while the page is open: re-read in place (no skeleton) on focus, when the tab is shown again, and after a decision
  // write the server refused because the result changed. The time of the last read is shown so a reader can tell how fresh the list is.
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<{ list: Paginated<EvaluationSummaryDto>; readAt: Date } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    readPatientResults(apiFetch, patientId, page, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setData({ list: value, readAt: new Date() });
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof SubmitError ? caught.message : 'Stored results could not be loaded. Please retry.');
      },
    );
    return () => controller.abort();
  }, [apiFetch, patientId, page, attempt, refresh]);
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState === 'visible') setRefresh((value) => value + 1);
    };
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);
    return () => {
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
    };
  }, []);
  function reload(next = page) {
    setData(null);
    setError('');
    setPage(next);
    setAttempt((value) => value + 1);
  }
  if (error)
    return (
      <div>
        <p role="alert">{error}</p>
        <Button variant="outline" onClick={() => reload()}>
          Retry stored results
        </Button>
      </div>
    );
  if (!data) return <ContentSkeleton label="Loading stored results…" variant="list" />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Stored synthetic results. Clinical use is not approved.{decisions ? ' Decisions below document intent only.' : ''}</p>
      <p className="text-sm text-muted-foreground">Updated {data.readAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      {data.list.data.length === 0 && <p>No stored evaluations for this patient.</p>}
      {data.list.data.map((evaluation) => {
        const standing = evaluationStanding(evaluation);
        return (
          <article key={evaluation.id} className="rounded-lg border border-border bg-panel p-4">
            <h3 className="font-medium">Evaluation · {new Date(evaluation.createdAt).toLocaleString()}</h3>
            <StandingNotices notices={standing.notices} />
            {!standing.fold && <p className="text-sm text-muted-foreground">Current evaluation</p>}
            {evaluation.advisory.activeDisputes > 0 && <p className="text-warning">Active evidence dispute. New decisions are unavailable.</p>}
            {evaluation.disposition === 'held' && (
              <p role="status" className="text-warning">
                Held: {evaluation.hold?.message ?? evaluation.holdCode ?? 'No interpretation available.'} {evaluation.hold?.reviewerAction}
              </p>
            )}
            {evaluation.results.map((result) => (
              <StoredResult
                key={result.id}
                evaluation={evaluation}
                result={result}
                followupBusy={followupBusy}
                onFollowup={onFollowup}
                onStale={() => setRefresh((value) => value + 1)}
                decisions={decisions}
              />
            ))}
          </article>
        );
      })}
      {data.list.meta.totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={page === 1} onClick={() => reload(page - 1)}>
            Previous results
          </Button>
          <p className="text-sm">
            Page {page} of {data.list.meta.totalPages}
          </p>
          <Button variant="outline" disabled={page >= data.list.meta.totalPages} onClick={() => reload(page + 1)}>
            More results
          </Button>
        </div>
      )}
    </div>
  );
}
