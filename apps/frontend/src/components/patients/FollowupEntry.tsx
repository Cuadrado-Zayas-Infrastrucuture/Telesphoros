import { useEffect, useRef, useState } from 'react';
import { followupQuerySchema, type FollowupDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { readFollowups } from '@/lib/patientFollowups';
import { FollowupForm } from './FollowupForm';
import { FollowupValues } from './FollowupValues';
import { FollowupHistory } from './FollowupHistory';

type State = { kind: 'loading' | 'failed' | 'missing' } | { kind: 'ready'; entry: FollowupDto };
export function FollowupEntry({ patientId, threadId, onClose, onSaved }: { patientId: string; threadId: string; onClose: () => void; onSaved: () => void }) {
  const { apiFetch, roles } = useAuth();
  const validated = followupQuerySchema.safeParse({ threadId });
  const canonical = validated.success ? validated.data.threadId : null;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!canonical) return;
    const controller = new AbortController();
    // Read once for this editor. Background polling must not replace a physician's draft/version.
    readFollowups(apiFetch, patientId, 1, canonical, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const current = result.items.filter((entry) => entry.current && entry.patientId === patientId && entry.threadId === canonical);
        setState(current.length === 1 ? { kind: 'ready', entry: current[0]! } : { kind: 'missing' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'failed' });
      });
    return () => controller.abort();
  }, [apiFetch, patientId, canonical, attempt]);
  useEffect(() => {
    heading.current?.scrollIntoView?.({ block: 'start' });
    heading.current?.focus({ preventScroll: true });
  }, [state.kind]);
  const entry = state.kind === 'ready' ? state.entry : null;
  const canDocument = roles.includes('clinician') && !!entry?.next;
  return (
    <section id="followups" aria-label="Selected follow-up" className="flex flex-col gap-4 border-t border-border pt-6">
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">
        Follow-up
      </h2>
      {!canonical ? (
        <p role="alert">That follow-up link is invalid.</p>
      ) : state.kind === 'loading' ? (
        <p role="status">Loading selected follow-up…</p>
      ) : state.kind === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">This follow-up could not be loaded. Please retry.</p>
          <Button
            variant="outline"
            onClick={() => {
              setState({ kind: 'loading' });
              setAttempt((value) => value + 1);
            }}
          >
            Retry selected follow-up
          </Button>
        </div>
      ) : state.kind === 'missing' ? (
        <p role="alert">This follow-up is not available for this patient.</p>
      ) : (
        entry && (
          <>
            <div className="flex flex-col gap-1">
              <p className="font-medium wrap-anywhere">
                {entry.patientLabel} · {entry.medicationName}
              </p>
              {entry.next ? (
                <p className="text-sm">
                  Current reminder: {entry.next.date} ({entry.next.timezone})
                </p>
              ) : (
                <p role="status" className="text-sm">
                  This reminder is closed.
                </p>
              )}
              <FollowupValues entry={entry} />
            </div>
            {canDocument ? (
              <FollowupForm patientId={patientId} action="document" entry={entry} onClose={onClose} onSaved={onSaved} />
            ) : (
              <p className="text-sm text-muted-foreground">Review the recorded follow-up below or return to the patient’s follow-ups.</p>
            )}
            <Button variant="ghost" size="sm" aria-expanded={history} onClick={() => setHistory((value) => !value)}>
              History
            </Button>
            {history && <FollowupHistory patientId={patientId} threadId={entry.threadId} />}
          </>
        )
      )}
      {!canDocument && (
        <Button variant="outline" className="self-start" onClick={onClose}>
          Return to follow-ups
        </Button>
      )}
    </section>
  );
}
