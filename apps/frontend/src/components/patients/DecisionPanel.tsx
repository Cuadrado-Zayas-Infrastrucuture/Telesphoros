import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useEffect, useState } from 'react';
import type { ClinicianDecisionCreate, ClinicianDecisionHistoryDto, EvaluationSummaryDto } from '@telesphoros/shared-types';
import { CDR_CODE_LABELS, drugPresentation } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { currentDecisionEntry, decisionLabels, readDecisionHistory, type DecisionLink } from '@/lib/clinicianDecisions';
import { readFollowupAssignees } from '@/lib/patientFollowups';
import { DecisionForm } from './DecisionForm';
import { DecisionNote } from './DecisionNote';
import { clinicianLabel } from '@/lib/clinicianLabel';

export function DecisionPanel({
  evaluation,
  result,
  followupBusy,
  onFollowup,
  onStale,
}: {
  evaluation: EvaluationSummaryDto;
  result: EvaluationSummaryDto['results'][number];
  followupBusy: boolean;
  onFollowup: (link: DecisionLink) => void;
  /** A write was refused because the result changed (409): the list re-reads, so `evaluation.current` here is fresh again. */
  onStale: () => void;
}) {
  const { apiFetch, roles } = useAuth();
  const [read, setRead] = useState<{ history: ClinicianDecisionHistoryDto; actor: string } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<ClinicianDecisionCreate['entryKind'] | null>(null);
  const [saved, setSaved] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([readDecisionHistory(apiFetch, result.id, evaluation.id, evaluation.patientId, controller.signal), readFollowupAssignees(apiFetch, controller.signal)]).then(
      ([history, people]) => {
        if (!controller.signal.aborted) {
          setRead({ history, actor: people.currentActor });
          setError(false);
        }
      },
      () => {
        if (!controller.signal.aborted) setError(true);
      },
    );
    return () => controller.abort();
  }, [apiFetch, result.id, evaluation.id, evaluation.patientId, attempt]);
  function reload(wasSaved = false) {
    setRead(null);
    setError(false);
    setEditing(null);
    setSaved(wasSaved);
    setAttempt((value) => value + 1);
  }
  if (error)
    return (
      <div>
        <p role="alert">Decision history could not be loaded. No decision is inferred.</p>
        <Button variant="outline" onClick={() => reload()}>
          Retry decision history
        </Button>
      </div>
    );
  if (!read) return <ContentSkeleton label="Loading decision history…" variant="list" />;
  const { history, actor } = read;
  const current = currentDecisionEntry(history);
  const head = history.entries.find((entry) => entry.id === history.headEntryId);
  const eligible =
    evaluation.current &&
    evaluation.state === 'active' &&
    evaluation.disposition === 'evaluated' &&
    result.outcome === 'shown' &&
    evaluation.advisory.activeDisputes === 0 &&
    history.basis.length === 1 &&
    history.basis[0] === 'active';
  const canWrite = roles.includes('clinician') && eligible;
  const author = head?.createdBy === actor && head.entryKind !== 'entered-in-error';
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <p className="text-sm text-muted-foreground">A decision records clinical intent. It does not record an order, dispensing or medication use.</p>
      {saved && <p role="status">Decision saved.</p>}
      {current?.response ? <p className="font-medium">Current decision: {decisionLabels[current.response]}</p> : <p>No decisions recorded.</p>}
      {current && (
        <p className="text-sm">
          {current.detailCodes.map((code) => CDR_CODE_LABELS[code]).join(' · ')}
          {current.reviewBy ? ` · Review by ${current.reviewBy}` : ''}
        </p>
      )}
      {!eligible && <p className="text-sm text-warning">New decisions are unavailable for this result. State: {history.basis.join(', ')}.</p>}
      {editing ? (
        <DecisionForm history={history} kind={editing} initial={head} onCancel={() => reload()} onSaved={() => reload(true)} onStale={onStale} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {canWrite && (
            <Button
              size="sm"
              onClick={() => {
                setSaved(false);
                setEditing('decision');
              }}
            >
              Record decision
            </Button>
          )}
          {canWrite && author && (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing('amendment')}>
                Correct decision
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing('entered-in-error')}>
                Withdraw entry
              </Button>
            </>
          )}
          {canWrite && history.currentDecisionId && current?.response && (
            <Button
              size="sm"
              variant="outline"
              disabled={followupBusy}
              onClick={() => onFollowup({ id: history.currentDecisionId!, label: `${drugPresentation({ name: result.drug }).displayName} · ${decisionLabels[current.response!]}` })}
            >
              Schedule linked follow-up
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => reload()}>
            Refresh decision history
          </Button>
        </div>
      )}
      {history.entries.length > 0 && (
        <>
          <Button size="sm" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory((value) => !value)}>
            Decision history ({history.entries.length})
          </Button>
          {showHistory && (
            <ol aria-label="Decision entries" className="divide-y divide-border">
              {[...history.entries].reverse().map((entry) => (
                <li key={entry.id} className="flex flex-col gap-1 py-3 text-sm">
                  <p className="font-medium">
                    {entry.entryKind === 'entered-in-error' ? 'Entry withdrawn' : `${entry.entryKind === 'amendment' ? 'Correction: ' : ''}${decisionLabels[entry.response!]}`}
                  </p>
                  {entry.detailCodes.length > 0 && <p>{entry.detailCodes.map((code) => CDR_CODE_LABELS[code]).join(' · ')}</p>}
                  {entry.reviewBy && <p>Review by {entry.reviewBy}</p>}
                  <p className="wrap-anywhere">
                    Recorded {new Date(entry.createdAt).toLocaleString()} · {clinicianLabel(entry.createdBy, actor, 'You')}
                  </p>
                  {entry.note && <DecisionNote note={entry.note} />}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
