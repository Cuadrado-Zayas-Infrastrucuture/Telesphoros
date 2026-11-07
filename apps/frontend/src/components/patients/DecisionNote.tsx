import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useEffect, useState } from 'react';
import type { NoteDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { readDecisionNote } from '@/lib/clinicianDecisions';

export function DecisionNote({ note }: { note: { id: string; bodySha256: string } }) {
  const { apiFetch } = useAuth();
  const [value, setValue] = useState<NoteDto | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    readDecisionNote(apiFetch, note, controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) {
          setValue(loaded);
          setError(false);
        }
      },
      () => {
        if (!controller.signal.aborted) setError(true);
      },
    );
    return () => controller.abort();
  }, [apiFetch, note, attempt]);
  return error ? (
    <div>
      <p role="alert">Decision note could not be loaded.</p>
      <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
        Retry note
      </Button>
    </div>
  ) : !value ? (
    <ContentSkeleton label="Loading note…" variant="compact" />
  ) : (
    <p className="whitespace-pre-wrap wrap-anywhere">{value.redacted ? 'Note redacted.' : value.body}</p>
  );
}
