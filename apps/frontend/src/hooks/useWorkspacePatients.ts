import { useCallback, useEffect, useRef, useState } from 'react';
import type { PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { listPatients, SubmitError } from '@/lib/api';
import { onPatientAdded } from '@/lib/workspaceEvents';

type RosterSession = { controller: AbortController; nextPage: number; pending: boolean };

/** Bounded patient pages, loaded on demand. A failed page keeps the existing choices and retries that same page. */
export function useWorkspacePatients(enabled = true) {
  const { apiFetch } = useAuth();
  const [patients, setPatients] = useState<PatientDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const session = useRef<RosterSession | null>(null);
  const load = useCallback(
    (current: RosterSession) => {
      if (current.pending || current.controller.signal.aborted) return;
      current.pending = true;
      return listPatients(apiFetch, current.nextPage, current.controller.signal, 'newest')
        .then((page) => {
          if (current.controller.signal.aborted) return;
          setPatients((existing) => {
            // Keep locally added/updated rows when a response started before patient creation arrives late.
            const known = new Set(existing?.map((patient) => patient.id));
            return [...(existing ?? []), ...page.data.filter((patient) => !known.has(patient.id))];
          });
          current.nextPage = page.meta.page + 1;
          setHasMore(page.meta.page < page.meta.totalPages);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (current.controller.signal.aborted || caught instanceof SessionEndedError) return;
          setError(caught instanceof SubmitError ? caught.message : 'Patients could not be loaded. Please retry.');
        })
        .finally(() => {
          current.pending = false;
          if (!current.controller.signal.aborted) setLoading(false);
        });
    },
    [apiFetch],
  );
  useEffect(() => {
    if (!enabled) return;
    const current: RosterSession = { controller: new AbortController(), nextPage: 1, pending: false };
    session.current = current;
    void load(current);
    const stop = onPatientAdded((patient) => {
      setPatients((existing) =>
        existing?.some((row) => row.id === patient.id) ? existing.map((row) => (row.id === patient.id ? { ...row, ...patient } : row)) : [patient, ...(existing ?? [])],
      );
    });
    return () => {
      current.controller.abort();
      stop();
      if (session.current === current) session.current = null;
    };
  }, [enabled, load]);
  const loadMore = () => {
    if (!session.current || session.current.pending) return;
    setLoading(true);
    setError(null);
    void load(session.current);
  };
  return { patients, loading: enabled && loading, error, hasMore, loadMore };
}
