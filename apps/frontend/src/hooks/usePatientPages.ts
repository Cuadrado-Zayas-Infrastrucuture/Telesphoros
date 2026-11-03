import { useEffect, useState } from 'react';
import type { Paginated, PatientDto } from '@telesphoros/shared-types';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { listPatients } from '@/lib/api';

/** One page of patients at a time (the page is replaced, not appended). `load(page)` fetches a page, and again for the same page to retry or refresh. */
export function usePatientPages() {
  const { apiFetch } = useAuth();
  const [patients, setPatients] = useState<Paginated<PatientDto> | null>(null);
  const [request, setRequest] = useState({ page: 1, attempt: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listPatients(apiFetch, request.page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setPatients(result);
          setLoading(false);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted && !(caught instanceof SessionEndedError)) {
          setError('Patients could not be loaded. Please retry.');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [apiFetch, request]);
  function load(page: number) {
    setError(null);
    setLoading(true);
    setRequest((current) => ({ page, attempt: current.attempt + 1 }));
  }
  return { patients, loading, error, requestedPage: request.page, load };
}
