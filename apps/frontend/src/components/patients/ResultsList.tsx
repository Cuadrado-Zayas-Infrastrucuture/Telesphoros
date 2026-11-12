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

/** The result opened when a page is first read: the one a link named if it is there, else the first result the API marks current. */
function firstToOpen(evaluations: readonly EvaluationSummaryDto[], linked: string | null | undefined): string | null {
  const listed = evaluations.flatMap((evaluation) => evaluation.results.map((result) => ({ evaluation, result })));
  return listed.find(({ result }) => result.id === linked)?.result.id ?? listed.find(({ evaluation }) => !evaluationStanding(evaluation).fold)?.result.id ?? null;
}

export function ResultsList({
  patientId,
  followupBusy,
  onFollowup,
  initialResultId,
}: {
  patientId: string;
  followupBusy: boolean;
  onFollowup: (link: DecisionLink) => void;
  /** A result a link named (`?result=`): it opens first when it is on the page read. */
  initialResultId?: string | null;
}) {
  const { apiFetch } = useAuth();
  // The one result whose detail is open (specs/038 D7). It is settled when a page is first read: the result a link named, or the first
  // result of the first evaluation the API marks current. After that only the reader moves it: a re-read that finds the open result
  // withdrawn leaves it open, now marked not current, instead of taking it away.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  // In the synthetic staging a result can be read but nothing can be recorded about it: decisions are not switched on there, and neither
  // is the route that records render events (it needs the report pipeline), so neither is mounted.
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
        if (controller.signal.aborted) return;
        setData({ list: value, readAt: new Date() });
        setChosen((current) => (current === undefined ? firstToOpen(value.data, initialResultId) : current));
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof SubmitError ? caught.message : 'Stored results could not be loaded. Please retry.');
      },
    );
    return () => controller.abort();
  }, [apiFetch, patientId, page, attempt, refresh, initialResultId]);
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
    if (next !== page) setChosen(undefined);
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
  const selected = chosen ?? null;
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
                renders={decisions}
                selected={selected === result.id}
                onSelect={(select) => setChosen(select ? result.id : null)}
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
