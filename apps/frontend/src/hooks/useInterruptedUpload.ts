import { useEffect, useState } from 'react';
import type { useAuth } from '@/auth/AuthProvider';
import { readRecovery, RECOVERY_LIFETIME_MS, type RecoveryEntry } from '@/lib/uploadRecovery';

/**
 * After a reload the browser may still hold an interrupted upload of this tab (see lib/uploadRecovery.ts). Tracks that entry and re-reads it when it expires
 * or the tab regains focus, so the offer to finish or cancel never outlives the entry.
 */
export function useInterruptedUpload(recoverySession: ReturnType<typeof useAuth>['recoverySession']) {
  const [interrupted, setInterrupted] = useState<RecoveryEntry | undefined>(() => readRecovery(recoverySession));
  useEffect(() => {
    if (!interrupted) return;
    const refresh = () => setInterrupted(readRecovery(recoverySession));
    const timer = setTimeout(refresh, Math.max(0, Date.parse(interrupted.savedAt) + RECOVERY_LIFETIME_MS - Date.now()));
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [interrupted, recoverySession]);
  return [interrupted, setInterrupted] as const;
}
