import { useEffect, useState } from 'react';
import type { FollowupInboxFilters, FollowupList } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { onFollowupsChanged, readFollowups } from '@/lib/patientFollowups';
export function useFollowups(patient?: string, thread?: string, filters?: FollowupInboxFilters) {
  const { apiFetch } = useAuth();
  const [result, setResult] = useState<{ key: string; data: FollowupList | null; error: boolean } | null>(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const assignment = filters?.assignment ?? 'all';
  const status = filters?.status ?? 'all';
  const key = JSON.stringify([patient, thread, page, assignment, status]);
  useEffect(() => {
    const controller = new AbortController();
    readFollowups(apiFetch, patient, page, thread, controller.signal, { assignment, status })
      .then((result) => {
        if (!controller.signal.aborted) {
          setResult({ key, data: result, error: false });
          setLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResult({ key, data: null, error: true });
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [apiFetch, patient, page, thread, revision, assignment, status, key]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setRevision((value) => value + 1);
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const stop = onFollowupsChanged(() => setRevision((value) => value + 1));
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      stop();
    };
  }, []);
  return {
    data: result?.key === key ? result.data : null,
    error: result?.key === key && result.error,
    loading: loading || result?.key !== key,
    page,
    reload: () => {
      setLoading(true);
      setRevision((value) => value + 1);
    },
    go: (next: number) => {
      if (next === page) return;
      setLoading(true);
      setPage(next);
    },
  };
}
