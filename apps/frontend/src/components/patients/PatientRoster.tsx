import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DemographicsCompleteness } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { IncompleteWord } from '@/components/patients/IncompleteWord';
import { Button } from '@/components/ui/Button';
import { useWorkspacePatients } from '@/hooks/useWorkspacePatients';
import { Input } from '@/components/ui/Input';
import { getCompleteness } from '@/lib/patientDemographics';
import { onPatientAdded } from '@/lib/workspaceEvents';

/**
 * The Patients page's roster (specs/034, from the panel's former list, specs/024 D2a): the synthetic labels, newest first, each a link to the
 * patient's page and marked "Incomplete" when its demographics are missing, under a line counting complete demographics.
 */
export function PatientRoster() {
  const { apiFetch } = useAuth();
  const { patients, loading, error, hasMore, loadMore } = useWorkspacePatients();
  const [filter, setFilter] = useState('');
  const [counts, setCounts] = useState<DemographicsCompleteness | null>(null);

  // The line is an extra: when the counts cannot be read (the in-memory store has none), it is left out, with no alert.
  const loadCounts = useCallback(
    (signal?: AbortSignal) => {
      getCompleteness(apiFetch, signal)
        .then(setCounts)
        .catch(() => {
          if (!signal?.aborted) setCounts(null);
        });
    },
    [apiFetch],
  );
  useEffect(() => {
    const controller = new AbortController();
    loadCounts(controller.signal);
    const stop = onPatientAdded(() => loadCounts(controller.signal));
    return () => {
      controller.abort();
      stop();
    };
  }, [loadCounts]);
  const visible = patients?.filter((patient) => patient.label.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <section aria-labelledby="patient-roster-heading" className="flex flex-col gap-3 rounded-lg border border-divider bg-panel px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="patient-roster-heading" className="text-xl">
          Patient records
        </h2>
        {counts && counts.patients > 0 && (
          <p className="text-sm text-muted-foreground">
            Demographics:{' '}
            <span className={counts.complete < counts.patients ? 'text-warning' : 'text-success'}>
              {counts.complete} of {counts.patients} complete
            </span>
          </p>
        )}
      </div>
      {patients && patients.length > 5 && (
        <label htmlFor="patient-roster-filter" className="flex max-w-sm flex-col gap-1 text-sm">
          Find loaded patients
          <Input id="patient-roster-filter" value={filter} onChange={(event) => setFilter(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Patient code" />
        </label>
      )}
      {error && (
        <div className="flex flex-col items-start gap-1 text-sm">
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={loadMore} aria-label="Retry patient list">
            Retry
          </Button>
        </div>
      )}
      {patients === null ? (
        !error && <ContentSkeleton label="Loading patients…" variant="compact" />
      ) : patients.length === 0 ? (
        <p className="text-sm text-muted-foreground">No patients yet.</p>
      ) : (
        <>
          <ul aria-label="Patients" className="flex flex-col">
            {visible?.map((patient) => (
              <li
                key={patient.id}
                className="flex min-w-0 items-center justify-between gap-3 rounded-sm border-b border-divider px-2 text-sm transition-colors duration-150 last:border-0 hover:bg-muted motion-reduce:transition-none"
              >
                {/* The whole row is the link's target, not just the code: easier to hit, and the hover shows which row will open. */}
                <Link
                  to={`/patients/${patient.id}`}
                  title={patient.label}
                  className="flex min-h-control min-w-0 flex-1 items-center truncate font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {patient.label}
                </Link>
                <IncompleteWord patient={patient} className="shrink-0" />
              </li>
            ))}
          </ul>
          {visible?.length === 0 && (
            <p role="status" className="text-sm text-muted-foreground">
              No match among loaded patients.{hasMore ? ' Load more to keep looking.' : ''}
            </p>
          )}
        </>
      )}
      {hasMore && !error && (
        <Button variant="outline" size="sm" className="self-start" pending={loading} pendingLabel="Loading patients…" onClick={loadMore}>
          More patients
        </Button>
      )}
    </section>
  );
}
