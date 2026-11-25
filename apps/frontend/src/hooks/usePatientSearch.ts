import { useCallback, useEffect, useRef, useState } from 'react';
import type { PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { PATIENT_SEARCH_FAILED, SearchTextError, searchPatients, SubmitError } from '@/lib/api';

/** Where a search of the whole patient list stands (spec 040 slice B). */
export type PatientSearch =
  | { status: 'idle' }
  /** The text was not sent: the label's alphabet refuses it. */
  | { status: 'refused'; message: string }
  | { status: 'searching'; text: string }
  /** The server answered 200. `moreFailed` is set when a later page of the same search did not load; the matches already shown stay. */
  | { status: 'found'; text: string; patients: PatientDto[]; total: number; hasMore: boolean; loadingMore: boolean; moreFailed: boolean }
  /** Any other answer: the caller keeps the loaded patients and says the whole list was not searched. */
  | { status: 'failed'; text: string; message: string };

/**
 * Spec 040 slice B: one search of the whole patient list at a time. A new search, `reset` or unmounting aborts the one in flight, and an
 * answer that arrives after that is dropped (PS-12). `more` loads the next page of the current matches.
 */
export function usePatientSearch() {
  const { apiFetch } = useAuth();
  const [state, setState] = useState<PatientSearch>({ status: 'idle' });
  const current = useRef<{ controller: AbortController; text: string; nextPage: number; pending: boolean } | null>(null);

  const stop = useCallback(() => {
    current.current?.controller.abort();
    current.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const search = useCallback(
    (text: string) => {
      stop();
      const run = { controller: new AbortController(), text, nextPage: 1, pending: false };
      current.current = run;
      setState({ status: 'searching', text });
      searchPatients(apiFetch, text, 1, run.controller.signal)
        .then((page) => {
          if (current.current !== run) return;
          run.nextPage = 2;
          const hasMore = page.meta.page < page.meta.totalPages;
          setState({ status: 'found', text, patients: page.data, total: page.meta.total, hasMore, loadingMore: false, moreFailed: false });
        })
        .catch((caught: unknown) => {
          if (current.current !== run || caught instanceof SessionEndedError) return;
          current.current = null;
          if (caught instanceof SearchTextError) setState({ status: 'refused', message: caught.message });
          else setState({ status: 'failed', text, message: caught instanceof SubmitError ? caught.message : PATIENT_SEARCH_FAILED });
        });
    },
    [apiFetch, stop],
  );

  const more = useCallback(() => {
    const run = current.current;
    if (!run || run.pending) return;
    run.pending = true;
    setState((existing) => (existing.status === 'found' ? { ...existing, loadingMore: true, moreFailed: false } : existing));
    searchPatients(apiFetch, run.text, run.nextPage, run.controller.signal)
      .then((page) => {
        if (current.current !== run) return;
        run.nextPage = page.meta.page + 1;
        setState((existing) => {
          if (existing.status !== 'found') return existing;
          const known = new Set(existing.patients.map((patient) => patient.id));
          const patients = [...existing.patients, ...page.data.filter((patient) => !known.has(patient.id))];
          return { ...existing, patients, total: page.meta.total, hasMore: page.meta.page < page.meta.totalPages, loadingMore: false };
        });
      })
      .catch((caught: unknown) => {
        if (current.current !== run || caught instanceof SessionEndedError) return;
        setState((existing) => (existing.status === 'found' ? { ...existing, loadingMore: false, moreFailed: true } : existing));
      })
      .finally(() => {
        run.pending = false;
      });
  }, [apiFetch]);

  const reset = useCallback(() => {
    stop();
    setState({ status: 'idle' });
  }, [stop]);

  return { state, search, more, reset };
}
