import { useState } from 'react';
import { drugPresentation, type EvaluationSummaryDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { ResultDetails } from '@/components/ResultDetails';
import { decisionStanding, type DecisionLink } from '@/lib/clinicianDecisions';
import { evaluationStanding } from '@/lib/resultStatus';
import { DecisionPanel } from './DecisionPanel';

/**
 * One stored result with what can be done about it (specs/038 D4). A result a decision can be recorded on shows its decision and the
 * controls at once. Any other result says why no decision can be recorded, and keeps its decision history behind a disclosure.
 */
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
  const [history, setHistory] = useState(false);
  const drug = drugPresentation({ name: result.drug });
  const standing = decisionStanding(evaluation, result);
  const panel = <DecisionPanel evaluation={evaluation} result={result} followupBusy={followupBusy} onFollowup={onFollowup} onStale={onStale} />;
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
      {decisions &&
        (standing.open ? (
          panel
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{standing.reason}</p>
            <Button variant="ghost" size="sm" className="self-start" aria-expanded={history} onClick={() => setHistory((value) => !value)}>
              Decision history
            </Button>
            {history && panel}
          </>
        ))}
    </section>
  );
}
