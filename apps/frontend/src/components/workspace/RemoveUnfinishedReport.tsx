import { useState } from 'react';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { SubmitError } from '@/lib/api';
import { removeUnfinishedReport } from '@/lib/ownedStorageApi';
import { announceReportsChanged } from '@/lib/workspaceEvents';

/**
 * "Remove" for a report whose file never arrived, with a second step to confirm. Offered only for such reports: the request reads the report again and
 * refuses one whose file is stored. On success the report lists reload.
 */
export function RemoveUnfinishedReport({ reportId, filename }: { reportId: string; filename: string }) {
  const { apiFetch } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setRemoving(true);
    setError(null);
    try {
      await removeUnfinishedReport(apiFetch, reportId);
      announceReportsChanged();
    } catch (caught) {
      if (caught instanceof SessionEndedError) return;
      setError(caught instanceof SubmitError ? caught.message : 'The report could not be removed. Please retry.');
      setConfirming(false);
    } finally {
      setRemoving(false);
    }
  }

  if (!confirming)
    return (
      <span className="flex flex-col items-start">
        <Button variant="ghost" size="sm" className="min-h-control px-2 text-xs" aria-label={`Remove unfinished upload ${filename}`} onClick={() => setConfirming(true)}>
          Remove
        </Button>
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </span>
    );
  return (
    <span role="group" aria-label={`Remove unfinished upload ${filename}?`} className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-muted-foreground">Remove it?</span>
      <Button variant="ghost" size="sm" className="min-h-control px-2 text-xs text-destructive" pending={removing} pendingLabel="Removing…" onClick={() => void remove()}>
        Remove
      </Button>
      <Button variant="ghost" size="sm" className="min-h-control px-2 text-xs" disabled={removing} onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}
