import { useState } from 'react';
import { drugPresentation, type EvaluationSummaryDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { ResultDetails } from '@/components/ResultDetails';
import type { DecisionLink } from '@/lib/clinicianDecisions';
import { evaluationStanding } from '@/lib/resultStatus';
import { DecisionPanel } from './DecisionPanel';

export function StoredResult({
  evaluation,
  result,
  followupBusy,
  onFollowup,
  onStale,
  decisions = true,
}: {
  evaluation: EvaluationSummaryDto;
  result: EvaluationSummaryDto['results'][number];
  followupBusy: boolean;
  onFollowup: (link: DecisionLink) => void;
  /** The server refused a decision because the result changed: re-read the list. */
  onStale: () => void;
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
      <ResultDetails
        result={result}
        geneStates={evaluation.geneStates}
        fold={evaluationStanding(evaluation).fold}
        provenance={
          <>
            <p>Knowledge: {evaluation.knowledgeSetId}</p>
            <p>Engine: {evaluation.engineVersion}</p>
            <p>Report: {evaluation.reportId}</p>
          </>
        }
      />
      {decisions && (
        <Button variant="outline" size="sm" className="self-start" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          Decision and history
        </Button>
      )}
      {decisions && open && <DecisionPanel evaluation={evaluation} result={result} followupBusy={followupBusy} onFollowup={onFollowup} onStale={onStale} />}
    </section>
  );
}
