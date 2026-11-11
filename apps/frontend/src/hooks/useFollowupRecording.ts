import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { readFollowupAvailability, type FollowupRecording } from '@/lib/patientFollowups';

/** Whether this environment records follow-ups; 'unknown' until the API answers, and when it cannot. */
export function useFollowupRecording(): FollowupRecording {
  const { apiFetch } = useAuth();
  const [recording, setRecording] = useState<FollowupRecording>('unknown');
  useEffect(() => {
    const controller = new AbortController();
    readFollowupAvailability(apiFetch, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setRecording(value);
      })
      .catch(() => {
        /* A sign-in that ended is handled by the request that surfaces it; this read stays 'unknown'. */
      });
    return () => controller.abort();
  }, [apiFetch]);
  return recording;
}
