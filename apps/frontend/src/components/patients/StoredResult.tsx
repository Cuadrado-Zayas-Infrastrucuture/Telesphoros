import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { drugPresentation, type EvaluationSummaryDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { ResultDetails } from '@/components/ResultDetails';
import { RecommendationSummaryRegion } from '@/components/renders/RecommendationSummaryRegion';
import { decisionStanding, type DecisionLink } from '@/lib/clinicianDecisions';
import { evaluationStanding, outcomeLabel } from '@/lib/resultStatus';
import { DecisionPanel } from './DecisionPanel';
import { ResultEvidence } from './ResultEvidence';

/**
 * One stored result (specs/038 D4, D7). Its row always shows the drug, the outcome in plain words and the phenotype it rests on, so a long
 * list stays scannable. The selected result opens below its row: the wording, the evidence beside it on a wide screen and after it on a
 * narrow one, and then the decision. A result a decision can be recorded on shows the decision controls; any other says why none can be
 * recorded and keeps its history behind a disclosure.
 */
export function StoredResult({
  evaluation,
  result,
  followupBusy,
  onFollowup,
  onStale,
  decisions = true,
  selected = true,
  onSelect,
  renders = false,
}: {
  /** True where the API records render events (specs/019): the open result's summary is then measured as displayed. */
  renders?: boolean;
  evaluation: EvaluationSummaryDto;
  result: EvaluationSummaryDto['results'][number];
  followupBusy: boolean;
  onFollowup: (link: DecisionLink) => void;
  /** The server refused a decision because the result changed: re-read the list. */
  onStale: () => void;
  /** False in the synthetic staging, where decisions on results are not switched on: the result is shown and nothing can be recorded about it. */
  decisions?: boolean;
  /** Whether this result's detail is open. The list keeps one result selected at a time. */
  selected?: boolean;
  /** Absent when the result stands alone and cannot be closed. */
  onSelect?: (select: boolean) => void;
}) {
  const [history, setHistory] = useState(false);
  const detailId = useId();
  const drug = drugPresentation({ name: result.drug });
  const fold = evaluationStanding(evaluation).fold;
  const standing = decisionStanding(evaluation, result);
  const outcome = outcomeLabel(result.outcome);
  const phenotypes = result.genes
    .map((gene) => {
      const state = evaluation.geneStates.find((entry) => entry.gene === gene);
      return state?.phenotype ? `${gene}: ${state.phenotype}` : gene;
    })
    .join(' · ');
  const tone = fold ? 'text-muted-foreground' : result.outcome === 'held' ? 'text-warning' : result.outcome === 'shown' ? '' : 'text-muted-foreground';
  const summary = (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 text-left">
      <span className="font-medium wrap-anywhere">{drug.displayName}</span>
      <span className={`text-sm ${tone}`}>{fold ? `Not current · ${outcome}` : outcome}</span>
      {phenotypes && <span className="text-sm text-muted-foreground wrap-anywhere">{phenotypes}</span>}
    </span>
  );
  const panel = <DecisionPanel evaluation={evaluation} result={result} followupBusy={followupBusy} onFollowup={onFollowup} onStale={onStale} />;
  const details = (
    <ResultDetails
      result={result}
      geneStates={evaluation.geneStates}
      fold={fold}
      source={false}
      lead={false}
      provenance={
        <>
          <p>Knowledge: {evaluation.knowledgeSetId}</p>
          <p>Engine: {evaluation.engineVersion}</p>
          <p>Report: {evaluation.reportId}</p>
          {evaluation.corrections.map((correction) => (
            <p key={correction.id}>
              Correction: {correction.kind} · {correction.reasonCode}
            </p>
          ))}
        </>
      }
    />
  );
  return (
    <section aria-label={`Stored result ${result.drug}`} className="flex flex-col gap-3 border-t border-border py-2">
      <h4 aria-label={drug.ariaLabel}>
        {onSelect ? (
          <button
            type="button"
            className="flex min-h-control w-full items-center gap-2 rounded-md py-1 hover:bg-muted"
            aria-expanded={selected}
            aria-controls={detailId}
            aria-label={`${drug.ariaLabel}: ${fold ? 'not current, ' : ''}${outcome}`}
            onClick={() => onSelect(!selected)}
          >
            {selected ? <ChevronDown aria-hidden="true" className="size-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0" />}
            {summary}
          </button>
        ) : (
          <span className="flex min-h-control items-center">{summary}</span>
        )}
      </h4>
      {selected && (
        <div id={detailId} className="grid gap-4 pb-2 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            {/* Display only (specs/019): that this was on screen says nothing of reading, agreement or a decision. A folded result shows no wording, so it is not measured. */}
            {renders && !fold ? (
              <RecommendationSummaryRegion resultId={result.id} patientId={evaluation.patientId} label={`Recommendation summary for ${drug.ariaLabel}`}>
                {details}
              </RecommendationSummaryRegion>
            ) : (
              details
            )}
          </div>
          <ResultEvidence evaluation={evaluation} result={result} historical={fold} className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1" />
          {decisions && (
            <div className="flex min-w-0 flex-col gap-3">
              {standing.open ? (
                panel
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">{standing.reason}</p>
                  <Button variant="ghost" size="sm" className="self-start" aria-expanded={history} onClick={() => setHistory((value) => !value)}>
                    Decision history
                  </Button>
                  {history && panel}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
