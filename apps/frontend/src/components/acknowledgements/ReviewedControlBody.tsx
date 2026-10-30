import { useEffect, useRef, useState } from 'react';
import { ackKindFor, type AckKind, type ResultAcknowledgementCreateInput, type ResultAcknowledgementDto, type ResultAcknowledgementsDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { AcknowledgementRefusedError, AcknowledgementsLoadError, AcknowledgementUnconfirmedError, loadAcknowledgements, submitAcknowledgement } from '@/lib/resultAcknowledgements';

type State =
  | { state: 'loading' }
  | { state: 'load-failed'; message: string }
  | { state: 'ready'; status: ResultAcknowledgementsDto }
  | { state: 'sending'; status: ResultAcknowledgementsDto; request: ResultAcknowledgementCreateInput }
  | { state: 'failed'; status: ResultAcknowledgementsDto; request: ResultAcknowledgementCreateInput; message: string }
  | { state: 'refused'; message: string }
  | { state: 'reviewed'; entry: Pick<ResultAcknowledgementDto, 'kind' | 'createdAt'> };

const LABELS: Record<AckKind, string> = { review: 'Review', 'retraction-reviewed': 'Retraction reviewed' };
const DONE: Record<AckKind, string> = { review: 'Reviewed', 'retraction-reviewed': 'Retraction reviewed' };

/** The caller's own review of the result as it is now, if one is stored. */
function ownCurrent(status: ResultAcknowledgementsDto) {
  const kind = ackKindFor(status.basis);
  return status.acknowledgements.find((a) => a.byYou && a.basisIsCurrent && a.kind === kind && a.reviewTask === 'result-review');
}

/** The body of `ReviewedControl` for one result. Use `ReviewedControl`: it keys this by result, so a new result is a new mount. */
export function ReviewedControlBody({ resultId }: { resultId: string }) {
  const { apiFetch, roles } = useAuth();
  const canReview = roles.includes('clinician'); // the API refuses anyone else (403); the button is not offered to them
  const [view, setView] = useState<State>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const sending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadAcknowledgements(apiFetch, resultId, controller.signal).then(
      (status) => {
        const own = ownCurrent(status);
        setView(own ? { state: 'reviewed', entry: own } : { state: 'ready', status });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setView({ state: 'load-failed', message: error instanceof AcknowledgementsLoadError ? error.message : 'Review status could not be loaded.' });
      },
    );
    return () => controller.abort();
  }, [apiFetch, resultId, attempt]);

  // Unmounting (another result or patient, or leaving the page) abandons a pending review: its answer is never shown here.
  useEffect(() => () => sending.current?.abort(), []);

  const reload = () => {
    setView({ state: 'loading' });
    setAttempt((n) => n + 1);
  };

  const send = (status: ResultAcknowledgementsDto, request: ResultAcknowledgementCreateInput) => {
    if (sending.current) return; // one request at a time
    const controller = new AbortController();
    sending.current = controller;
    setView({ state: 'sending', status, request });
    submitAcknowledgement(apiFetch, request, controller.signal).then(
      (entry) => {
        sending.current = null;
        if (!controller.signal.aborted) setView({ state: 'reviewed', entry });
      },
      (error: unknown) => {
        sending.current = null;
        if (controller.signal.aborted) return;
        if (error instanceof AcknowledgementRefusedError) setView({ state: 'refused', message: error.message });
        else
          setView({
            state: 'failed',
            status,
            request,
            message: error instanceof AcknowledgementUnconfirmedError ? error.message : 'The review was not confirmed. Retry to try again.',
          });
      },
    );
  };

  const review = (status: ResultAcknowledgementsDto) =>
    send(status, {
      requestId: crypto.randomUUID(),
      resultId,
      patientId: status.patientId,
      kind: ackKindFor(status.basis),
      reviewTask: 'result-review',
      displayedBasis: status.basis,
    });

  return (
    <div role="group" aria-label={`Review of result ${resultId}`} className="flex flex-wrap items-center gap-3 text-sm">
      {view.state === 'loading' && (
        <p role="status" className="text-muted-foreground">
          Loading review status…
        </p>
      )}
      {view.state === 'load-failed' && (
        <>
          <p role="alert" className="text-destructive">
            {view.message}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        </>
      )}
      {(view.state === 'ready' || view.state === 'sending' || view.state === 'failed') && (
        <>
          {view.status.basis.includes('retracted') && <p className="text-warning">Retracted</p>}
          {!canReview ? (
            <p className="text-muted-foreground">Only a clinician can record a review.</p>
          ) : view.state === 'failed' ? (
            <>
              <p role="alert" className="text-destructive">
                {view.message}
              </p>
              <Button variant="outline" size="sm" onClick={() => send(view.status, view.request)}>
                Retry
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" disabled={view.state === 'sending'} aria-busy={view.state === 'sending'} onClick={() => review(view.status)}>
              {LABELS[ackKindFor(view.status.basis)]}
            </Button>
          )}
          {view.state === 'sending' && (
            <p role="status" className="text-muted-foreground">
              Saving review…
            </p>
          )}
        </>
      )}
      {view.state === 'refused' && (
        <>
          <p role="alert" className="text-destructive">
            {view.message}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            Refresh
          </Button>
        </>
      )}
      {view.state === 'reviewed' && (
        <p role="status">
          <span className="font-semibold text-success">{DONE[view.entry.kind]}</span>{' '}
          <span className="text-muted-foreground">
            by you, <time dateTime={view.entry.createdAt}>{new Date(view.entry.createdAt).toLocaleString('en-US')}</time>
          </span>
        </p>
      )}
    </div>
  );
}
