import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useEffect, useState } from 'react';
import type { FollowupResponseSummary as Summary } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { onFollowupsChanged, readFollowupResponseSummary } from '@/lib/patientFollowups';

const categories = [
  ['improved', 'Improved'],
  ['unchanged', 'Unchanged'],
  ['worsened', 'Worsened'],
  ['notAssessed', 'Response not assessed'],
  ['noAssessment', 'No assessment recorded'],
] as const;

export function FollowupResponseSummary() {
  const { apiFetch } = useAuth();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    readFollowupResponseSummary(apiFetch, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setError(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [apiFetch, revision]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1);
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const stop = onFollowupsChanged(refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      stop();
    };
  }, []);
  return (
    <section id="followup-response-summary" aria-label="Recorded treatment responses" className="flex flex-col gap-3 border-b border-border py-4">
      <p className="text-sm text-muted-foreground">All recorded follow-ups, including closed reminders. Latest assessment per follow-up; a patient may have several.</p>
      {error ? (
        <p role="alert" className="text-sm">
          Response summary is unavailable. Counts could not be verified.
        </p>
      ) : !data ? (
        <ContentSkeleton label="Loading response summary…" variant="detail" />
      ) : data.total === 0 ? (
        <p>No follow-ups recorded yet.</p>
      ) : (
        <>
          <p className="text-sm font-medium">
            Response documented in {data.responses.improved + data.responses.unchanged + data.responses.worsened} of {data.total} follow-ups.
          </p>
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">Latest recorded treatment responses, all time. Bar lengths use the total follow-up count.</caption>
            <thead>
              <tr>
                <th scope="col" className="text-left font-medium">
                  Recorded response
                </th>
                <th scope="col" className="w-16 text-right font-medium">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.map(([key, label]) => (
                <tr key={key}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {label}
                    <svg aria-hidden="true" focusable="false" viewBox="0 0 100 6" preserveAspectRatio="none" className="mt-1 h-2 w-full rounded-sm">
                      <rect width="100" height="6" className="fill-muted" />
                      <rect width={(100 * data.responses[key]) / data.total} height="6" className="fill-foreground" />
                    </svg>
                  </th>
                  <td className="text-right tabular-nums">{data.responses[key]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">Recorded observations do not establish treatment effectiveness.</p>
        </>
      )}
      {!error && data && (
        <p className="text-xs text-muted-foreground">
          Updated <time dateTime={data.asOf}>{new Date(data.asOf).toLocaleString()}</time>
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setRevision((value) => value + 1);
        }}
      >
        {error ? 'Retry response summary' : 'Refresh response summary'}
      </Button>
    </section>
  );
}
