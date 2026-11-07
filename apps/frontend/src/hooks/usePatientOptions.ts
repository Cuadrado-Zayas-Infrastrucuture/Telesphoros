import { useEffect, useState } from 'react';
import type { Paginated, PatientDto } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { listPatients } from '@/lib/api';
import { EMPTY_PAGE_META } from '@/lib/emptyPageMeta';

/** One page of patients for a filter menu. A failure leaves the rest of the page usable, so the message says so. */
export function usePatientOptions() {
  const { apiFetch } = useAuth();
  const [request, setRequest] = useState({ page: 1, attempt: 0 });
  const [patients, setPatients] = useState<Paginated<PatientDto> | null>(null);
  const [meta, setMeta] = useState(EMPTY_PAGE_META);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listPatients(apiFetch, request.page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setPatients(result);
          setMeta(result.meta);
          setLoading(false);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted && !(caught instanceof SessionEndedError) && !(caught instanceof NotSignedInError)) {
          setError('Patient options could not be loaded. Reports remain available.');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [apiFetch, request]);
  function load(page: number) {
    setPatients(null);
    setError(null);
    setLoading(true);
    setMeta((current) => ({ ...current, page }));
    setRequest((current) => ({ page, attempt: current.attempt + 1 }));
  }
  return { patients, meta, loading, error, requestedPage: request.page, load };
}
