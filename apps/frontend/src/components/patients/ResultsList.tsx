import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useEffect, useState } from 'react';
import type { EvaluationSummaryDto, Paginated } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { readPatientResults, type DecisionLink } from '@/lib/clinicianDecisions';
import { SubmitError } from '@/lib/api';
import { StoredResult } from './StoredResult';

export function ResultsList({ patientId, followupBusy, onFollowup }: { patientId: string; followupBusy: boolean; onFollowup: (link: DecisionLink) => void }) {
  const { apiFetch } = useAuth();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<Paginated<EvaluationSummaryDto> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    readPatientResults(apiFetch, patientId, page, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setData(value);
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof SubmitError ? caught.message : 'Stored results could not be loaded. Please retry.');
      },
    );
    return () => controller.abort();
  }, [apiFetch, patientId, page, attempt]);
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
      <p className="text-sm text-muted-foreground">Stored synthetic results. Clinical use is not approved. Decisions below document intent only.</p>
      {data.data.length === 0 && <p>No stored evaluations for this patient.</p>}
      {data.data.map((evaluation) => (
        <article key={evaluation.id} className="rounded-lg border border-border bg-panel p-4">
          <h3 className="font-medium">Evaluation · {new Date(evaluation.createdAt).toLocaleString()}</h3>
          <p className="text-sm">
            {evaluation.state} · {evaluation.current ? 'Current evaluation' : 'Historical evaluation'} · Patient link: {evaluation.advisory.patientLink}
          </p>
          {evaluation.advisory.activeDisputes > 0 && <p className="text-warning">Active evidence dispute. New decisions are unavailable.</p>}
          {evaluation.disposition === 'held' && (
            <p role="status" className="text-warning">
              Held: {evaluation.hold?.message ?? evaluation.holdCode ?? 'No interpretation available.'} {evaluation.hold?.reviewerAction}
            </p>
          )}
          {evaluation.results.map((result) => (
            <StoredResult key={result.id} evaluation={evaluation} result={result} followupBusy={followupBusy} onFollowup={onFollowup} />
          ))}
        </article>
      ))}
      {data.meta.totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={page === 1} onClick={() => reload(page - 1)}>
            Previous results
          </Button>
          <p className="text-sm">
            Page {page} of {data.meta.totalPages}
          </p>
          <Button variant="outline" disabled={page >= data.meta.totalPages} onClick={() => reload(page + 1)}>
            More results
          </Button>
        </div>
      )}
    </div>
  );
}
