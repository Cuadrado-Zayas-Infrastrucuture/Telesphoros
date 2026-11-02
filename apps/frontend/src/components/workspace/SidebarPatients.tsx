import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DemographicsCompleteness } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { IncompleteWord } from '@/components/patients/IncompleteWord';
import { Button } from '@/components/ui/Button';
import { useWorkspacePatients } from '@/hooks/useWorkspacePatients';
import { Input } from '@/components/ui/Input';
import { getCompleteness } from '@/lib/patientDemographics';
import { onPatientAdded } from '@/lib/workspaceEvents';

/**
 * The panel's "Patients": the first page of synthetic labels, each a link to the patient's page and marked "Incomplete" when its demographics are missing,
 * and for writer roles an "Add patient" link to the patient creation page.
 */
export function SidebarPatients({ onNavigate }: { onNavigate?: () => void }) {
  const { apiFetch, roles } = useAuth();
  const canAdd = roles.some((role) => WRITER_ROLES.includes(role));
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
    <section aria-labelledby="panel-patients-heading" data-panel-item="Patients" className="workspace-panel-section flex flex-col gap-1 px-3 py-2">
      <p id="panel-patients-heading" className="text-xs font-medium text-muted-foreground">
        Patients
      </p>
      {counts && counts.patients > 0 && (
        <p className="text-xs text-muted-foreground">
          Demographics:{' '}
          <span className={counts.complete < counts.patients ? 'text-warning' : 'text-success'}>
            {counts.complete} of {counts.patients} complete
          </span>
        </p>
      )}
      {canAdd && (
        <Button asChild variant="ghost" size="sm" className="min-h-control justify-start px-2 text-xs">
          <Link to="/patients/new" onClick={onNavigate}>
            Add patient
          </Link>
        </Button>
      )}
      {patients && patients.length > 5 && (
        <label htmlFor="sidebar-patient-filter" className="flex flex-col gap-1 text-xs">
          Find loaded patients
          <Input id="sidebar-patient-filter" value={filter} onChange={(event) => setFilter(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Patient code" />
        </label>
      )}
      {error && (
        <div className="flex flex-col items-start gap-1 text-xs">
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
        <p className="text-xs text-muted-foreground">No patients yet.</p>
      ) : (
        <>
          <ul aria-label="Patients" className="workspace-roster flex flex-col">
            {visible?.map((patient) => (
              <li key={patient.id} className="flex min-w-0 items-center gap-2 text-xs">
                <Link
                  to={`/patients/${patient.id}`}
                  onClick={onNavigate}
                  title={patient.label}
                  className="flex min-h-control min-w-0 items-center truncate text-foreground underline-offset-2 hover:underline"
                >
                  {patient.label}
                </Link>
                <IncompleteWord patient={patient} className="shrink-0" />
              </li>
            ))}
          </ul>
          {visible?.length === 0 && (
            <p role="status" className="text-xs text-muted-foreground">
              No match among loaded patients.{hasMore ? ' Load more to keep looking.' : ''}
            </p>
          )}
        </>
      )}
      {hasMore && !error && (
        <Button variant="ghost" size="sm" pending={loading} pendingLabel="Loading patients…" onClick={loadMore}>
          More patients
        </Button>
      )}
    </section>
  );
}
