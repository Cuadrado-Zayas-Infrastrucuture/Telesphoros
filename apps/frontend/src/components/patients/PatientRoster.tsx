import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DemographicsCompleteness } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { IncompleteWord } from '@/components/patients/IncompleteWord';
import { Button } from '@/components/ui/Button';
import { usePatientSearch } from '@/hooks/usePatientSearch';
import { useWorkspacePatients } from '@/hooks/useWorkspacePatients';
import { Input } from '@/components/ui/Input';
import { getCompleteness } from '@/lib/patientDemographics';
import { onPatientAdded } from '@/lib/workspaceEvents';
import { patientSummary } from '@/lib/patientSummary';

/** The sentence under the field: how far the list below has been searched. Only a 200 from the server says "all" while pages remain. */
function scopeSentence(loaded: number, hasMore: boolean, matches: number | null) {
  if (matches !== null) return matches === 0 ? 'Searched all patients: no match.' : `Searched all patients: ${matches} ${matches === 1 ? 'match' : 'matches'}.`;
  return hasMore ? `Typing looks through the ${loaded} patients loaded so far. Search all patients looks through every one.` : `Typing looks through all ${loaded} patients.`;
}

/**
 * The Patients page's roster (specs/034, from the panel's former list, specs/024 D2a): the synthetic labels, newest first, each a link to the
 * patient's page and marked "Incomplete" when its demographics are missing, under a line counting complete demographics.
 *
 * Finding a patient (spec 040 slice B, D4): typing filters the loaded rows at once. While more pages remain, "Search all patients" (or Enter)
 * asks the server, and only its 200 replaces the rows with the matches. Any other answer keeps the loaded rows and their filter, and says the
 * whole list was not searched, with Retry. Changing the text returns to the loaded rows.
 */
export function PatientRoster() {
  const { apiFetch } = useAuth();
  const { patients, loading, error, hasMore, loadMore } = useWorkspacePatients();
  const [filter, setFilter] = useState('');
  const { state: search, search: searchAll, more: moreMatches, reset: resetSearch } = usePatientSearch();
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
  const text = filter.trim();
  const found = search.status === 'found' ? search : null;
  const visible = found ? found.patients : patients?.filter((patient) => patient.label.toLowerCase().includes(text.toLowerCase()));
  const describedBy = search.status === 'refused' ? 'patient-roster-refused patient-roster-scope' : 'patient-roster-scope';

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
        <form
          className="flex max-w-lg flex-col gap-1 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (hasMore) searchAll(text);
          }}
        >
          <label htmlFor="patient-roster-filter">Find a patient</label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="patient-roster-filter"
              className="min-w-0 flex-1 basis-48"
              aria-describedby={describedBy}
              aria-invalid={search.status === 'refused' || undefined}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                resetSearch();
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="Patient code"
            />
            {hasMore && (
              <Button type="submit" variant="outline" className="min-h-control" pending={search.status === 'searching'} pendingLabel="Searching all patients…">
                Search all patients
              </Button>
            )}
          </div>
          {search.status === 'refused' && (
            <p id="patient-roster-refused" className="text-xs text-destructive">
              {search.message}
            </p>
          )}
          <p id="patient-roster-scope" aria-live="polite" className="text-xs text-muted-foreground">
            {scopeSentence(patients.length, hasMore, found ? found.total : null)}
          </p>
          {search.status === 'failed' && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-destructive">
                {search.message}
              </p>
              <Button variant="ghost" size="sm" onClick={() => searchAll(search.text)} aria-label="Retry searching all patients">
                Retry
              </Button>
            </div>
          )}
        </form>
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
                  className="flex min-h-control min-w-0 flex-1 items-center truncate font-medium text-foreground slashed-zero underline-offset-2 hover:underline"
                >
                  {patient.label}
                </Link>
                {/* Beside the link, not inside it: the link's name stays the code that tests and tools find a patient by. */}
                {patientSummary(patient) && <span className="shrink-0 text-muted-foreground">{patientSummary(patient)}</span>}
                <IncompleteWord patient={patient} className="shrink-0" />
              </li>
            ))}
          </ul>
          {visible?.length === 0 && !found && (
            <p role="status" className="text-sm text-muted-foreground">
              No match among loaded patients.{hasMore ? ' Search all patients to keep looking.' : ''}
            </p>
          )}
        </>
      )}
      {found?.moreFailed && (
        <p role="alert" className="text-sm text-destructive">
          More matches could not be loaded. Please retry.
        </p>
      )}
      {found?.hasMore && (
        <Button variant="outline" size="sm" className="self-start" pending={found.loadingMore} pendingLabel="Loading matches…" onClick={moreMatches}>
          More matches
        </Button>
      )}
      {hasMore && !error && !found && (
        <Button variant="outline" size="sm" className="self-start" pending={loading} pendingLabel="Loading patients…" onClick={loadMore}>
          More patients
        </Button>
      )}
    </section>
  );
}
