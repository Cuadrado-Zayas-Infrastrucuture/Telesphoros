import { useEffect, useState } from 'react';
import type { Paginated, ReportDto } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { SubmitError } from '@/lib/api';
import { EMPTY_PAGE_META } from '@/lib/emptyPageMeta';
import { listReports } from '@/lib/ownedStorageApi';

/** One page of reports for an optional patient. `load` replaces the page; call it again with the same arguments to retry or refresh. */
export function useReportList() {
  const { apiFetch } = useAuth();
  const [request, setRequest] = useState({ page: 1, patientId: '', attempt: 0 });
  const [reports, setReports] = useState<Paginated<ReportDto> | null>(null);
  const [meta, setMeta] = useState(EMPTY_PAGE_META);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listReports(apiFetch, request.page, controller.signal, request.patientId || undefined)
      .then((result) => {
        if (!controller.signal.aborted) {
          setReports(result);
          setMeta(result.meta);
          setLoading(false);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted && !(caught instanceof SessionEndedError) && !(caught instanceof NotSignedInError)) {
          setError(caught instanceof SubmitError ? caught.message : 'Reports could not be loaded. Please retry.');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [apiFetch, request]);
  function load(page: number, patientId = request.patientId) {
    setReports(null);
    setError(null);
    setLoading(true);
    setMeta((current) => ({ ...current, page }));
    setRequest((current) => ({ page, patientId, attempt: current.attempt + 1 }));
  }
  return { request, reports, meta, loading, error, load };
}
