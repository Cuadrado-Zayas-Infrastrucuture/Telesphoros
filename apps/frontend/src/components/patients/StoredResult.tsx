import { useState } from 'react';
import { drugPresentation, type EvaluationSummaryDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import type { DecisionLink } from '@/lib/clinicianDecisions';
import { DecisionPanel } from './DecisionPanel';

export function StoredResult({
  evaluation,
  result,
  followupBusy,
  onFollowup,
  decisions = true,
}: {
  evaluation: EvaluationSummaryDto;
  result: EvaluationSummaryDto['results'][number];
  followupBusy: boolean;
  onFollowup: (link: DecisionLink) => void;
  /** False in the synthetic staging, where decisions on results are not switched on: the result is shown and nothing can be recorded about it. */
  decisions?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const drug = drugPresentation({ name: result.drug });
  return (
    <section aria-label={`Stored result ${result.drug}`} className="flex flex-col gap-3 border-t border-border py-4">
      <h4 className="font-medium" aria-label={drug.ariaLabel}>
        {drug.displayName}
      </h4>
      <p className="text-sm">
        {result.genes.join(', ')} · {result.outcome}
        {result.reasonCode ? ` · ${result.reasonCode}` : ''}
      </p>
      {result.recommendationText && <p className="whitespace-pre-wrap wrap-anywhere">{result.recommendationText}</p>}
      {result.implication && <p className="text-sm wrap-anywhere">{result.implication}</p>}
      <details>
        <summary className="flex min-h-control cursor-pointer items-center text-sm">Source and provenance</summary>
        <div className="flex flex-col gap-1 text-xs wrap-anywhere">
          <p>Knowledge: {evaluation.knowledgeSetId}</p>
          <p>Engine: {evaluation.engineVersion}</p>
          <p>Report: {evaluation.reportId}</p>
          {result.strength && <p>Recorded strength: {result.strength}</p>}
          {result.citation && <pre className="whitespace-pre-wrap wrap-anywhere">{JSON.stringify(result.citation, null, 2)}</pre>}
        </div>
      </details>
      {decisions && (
        <Button variant="outline" size="sm" className="self-start" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          Decision and history
        </Button>
      )}
      {decisions && open && <DecisionPanel evaluation={evaluation} result={result} followupBusy={followupBusy} onFollowup={onFollowup} />}
    </section>
  );
}
