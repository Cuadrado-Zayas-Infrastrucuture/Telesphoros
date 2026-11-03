import { useState } from 'react';
import type { StructuredRecordState } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';

const reviewLabels: Record<StructuredRecordState['review']['status'], string> = {
  'not-reviewable': 'Not open for findings review',
  'awaiting-review': 'Awaiting independent review',
  'in-progress': 'Findings review in progress',
  attention: 'Findings review needs attention',
  complete: 'Findings review complete',
};
const outstanding: Record<StructuredRecordState['review']['outstanding'][number], string> = {
  'review-findings': 'Check each saved finding against its source and record a decision.',
  'reopen-held-findings': 'Findings on hold need a new decision once the question is answered.',
  'resolve-source-conflict': 'Choose between the conflicting sources, or record that none is usable.',
  'await-new-source': 'Wait for a new or corrected laboratory source.',
  'recheck-changed-binding': 'A stored source or patient link changed. Recheck the source history.',
};
const decisions = {
  unreviewed: 'Not reviewed',
  'accepted-as-evidence': 'Matches its source',
  rejected: 'Does not match its source',
  held: 'On hold · needs clarification',
};
const words = (value: string | null) => (value ? value.replace(/-/g, ' ') : 'not stated');

export type FindingChoice = 'accepted-as-evidence' | 'rejected' | 'held';
export type SourceChoice = { outcome: 'use-revision'; revisionId: string } | { outcome: 'none-usable' } | { outcome: 'keep-held' };

/**
 * Independent review of stored findings and explicit handling of conflicting sources. A decision here says only whether a stored finding
 * matches its source: uncertainty stays attached, and nothing here is an interpretation or a prescribing recommendation.
 */
export function StructuredFindingsReview({
  state,
  canReview,
  busy,
  thisReportId,
  onFinding,
  onSources,
}: {
  state: StructuredRecordState;
  canReview: boolean;
  busy: boolean;
  thisReportId: string;
  onFinding: (findingId: string, choice: FindingChoice) => void;
  onSources: (choice: SourceChoice) => void;
}) {
  const { review, conflict } = state;
  const [pick, setPick] = useState('');
  if (!state.record) return null;
  const reviewable = state.state === 'candidate-for-review';
  const resolving = conflict !== null && conflict.resolution === null && state.state === 'held' && !state.reasons.includes('source-or-review-changed');
  const named = (id: string) => state.history.find((h) => h.id === id);
  function submit() {
    if (pick === 'none') onSources({ outcome: 'none-usable' });
    else if (pick === 'hold') onSources({ outcome: 'keep-held' });
    else if (pick) onSources({ outcome: 'use-revision', revisionId: pick });
  }
  return (
    <div className="space-y-3 border-t border-divider pt-3" aria-label="Findings review">
      <p className="font-semibold">{reviewLabels[review.status]}</p>
      <p className="text-muted-foreground">
        A decision here records only whether a saved finding matches its source. It is not an interpretation, and it does not approve prescribing or any clinical use. Uncertain
        findings stay uncertain.
      </p>
      {review.outstanding.length > 0 && (
        <ul aria-label="Outstanding actions" className="list-disc space-y-1 pl-5">
          {review.outstanding.map((action) => (
            <li key={action}>{outstanding[action]}</li>
          ))}
        </ul>
      )}
      {review.findings.length > 0 && (
        <ul aria-label="Findings for review" className="divide-y divide-divider">
          {review.findings.map((finding) => (
            <li key={finding.findingId} className="space-y-2 break-words py-2">
              <p className="font-semibold">{finding.gene ?? finding.findingId}</p>
              <p className="text-muted-foreground">
                Coverage {words(finding.coverage)} · analytical result {words(finding.analyticalState)} · interpretation {words(finding.interpretationState)}
              </p>
              <p>{decisions[finding.decision]}</p>
              {reviewable && canReview && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="h-auto min-h-control whitespace-normal"
                    disabled={busy}
                    aria-label={`${finding.gene ?? finding.findingId}: Matches source`}
                    onClick={() => onFinding(finding.findingId, 'accepted-as-evidence')}
                  >
                    Matches source
                  </Button>
                  <Button
                    variant="outline"
                    className="h-auto min-h-control whitespace-normal"
                    disabled={busy}
                    aria-label={`${finding.gene ?? finding.findingId}: Does not match`}
                    onClick={() => onFinding(finding.findingId, 'rejected')}
                  >
                    Does not match
                  </Button>
                  <Button
                    variant="outline"
                    className="h-auto min-h-control whitespace-normal"
                    disabled={busy}
                    aria-label={`${finding.gene ?? finding.findingId}: Hold for clarification`}
                    onClick={() => onFinding(finding.findingId, 'held')}
                  >
                    Hold for clarification
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {reviewable && !canReview && <p>A reviewer who did not upload or save this evidence records the findings review.</p>}
      {conflict && conflict.resolution && (
        <p>
          Source decision recorded:{' '}
          {conflict.resolution.outcome === 'use-revision'
            ? `${named(conflict.resolution.chosenRevisionId ?? '')?.laboratoryReportId ?? 'one source'} selected; the others stay in history and are not used.`
            : conflict.resolution.outcome === 'none-usable'
              ? 'none of the conflicting sources is usable.'
              : 'kept on hold until the laboratory clarifies.'}
        </p>
      )}
      {resolving && canReview && (
        <fieldset className="space-y-1" disabled={busy}>
          <legend className="font-semibold">Conflicting sources: choose one, or hold</legend>
          <p className="text-muted-foreground">Nothing is deleted. A source you do not select stays in the saved history and is not used for review.</p>
          {conflict.revisionIds.map((id) => {
            const item = named(id);
            return (
              <label key={id} className="flex min-h-control items-center gap-3 break-words">
                <input type="radio" name="source-choice" className="size-5 shrink-0" checked={pick === id} onChange={() => setPick(id)} />
                <span>
                  Use {item?.laboratoryReportId ?? 'this source'} · saved {item ? new Date(item.createdAt).toLocaleString() : ''}
                  {item?.reportId === thisReportId ? ' · This upload' : ''}
                </span>
              </label>
            );
          })}
          <label className="flex min-h-control items-center gap-3">
            <input type="radio" name="source-choice" className="size-5 shrink-0" checked={pick === 'none'} onChange={() => setPick('none')} />
            <span>None of these is usable</span>
          </label>
          <label className="flex min-h-control items-center gap-3">
            <input type="radio" name="source-choice" className="size-5 shrink-0" checked={pick === 'hold'} onChange={() => setPick('hold')} />
            <span>Keep on hold until the laboratory clarifies</span>
          </label>
          <Button className="h-auto min-h-control whitespace-normal" disabled={busy || !pick} onClick={submit}>
            Record source decision
          </Button>
        </fieldset>
      )}
      {resolving && !canReview && <p>A reviewer who did not upload or save these sources records the source decision.</p>}
    </div>
  );
}
