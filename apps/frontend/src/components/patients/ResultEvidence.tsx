import type { EvaluationSummaryDto } from '@telesphoros/shared-types';
import { ResultSource } from '@/components/ResultSource';
import { when } from '@/lib/formatWhen';
import { resultEvidence, type MissingItem } from '@/lib/resultEvidence';
import { showsWording } from '@/lib/resultStatus';
import { EvidenceBlock } from './EvidenceBlock';

const ABOUT: Readonly<Record<MissingItem['about'], string>> = {
  assessment: 'The assessment',
  report: 'From the report',
  guideline: 'From the guidelines and definitions',
};

/**
 * The evidence beside one stored result (specs/038 D7): what the assessment used, where its wording comes from, what it needed and did not
 * have, and what has changed since. Each part is a view of fields the result already carries, shown without a click and without any
 * generated text. A part the result does not carry says so.
 */
export function ResultEvidence({
  evaluation,
  result,
  historical,
  className,
}: {
  evaluation: EvaluationSummaryDto;
  result: EvaluationSummaryDto['results'][number];
  /** True for a result that is not the current one: the evidence is what was stored with it then. */
  historical: boolean;
  className?: string;
}) {
  const view = resultEvidence(evaluation, result);
  const worded = showsWording(result);
  return (
    <aside aria-label={`Evidence for ${result.drug}`} className={`flex flex-col gap-4 rounded-md border border-divider p-3 ${className ?? ''}`}>
      {historical && <p className="text-sm text-muted-foreground">This evidence was saved with an earlier result.</p>}
      <EvidenceBlock title={worded ? 'Why this applies' : 'Assessment inputs'}>
        {view.used.length > 0 ? (
          <>
            <p className="text-muted-foreground">Gene results used (report assessed {when(evaluation.createdAt)}):</p>
            <ul className="flex flex-col gap-1">
              {view.used.map((input) => (
                <li key={input.gene} className="wrap-anywhere">
                  {input.gene}: {input.phenotype}
                  {input.detail && <span className="text-muted-foreground"> ({input.detail})</span>}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No gene results were used to assess this drug.</p>
        )}
        {view.notRecorded.map((gene) => (
          <p key={gene} className="text-warning">
            {gene}: No result status was saved. No status has been assumed.
          </p>
        ))}
        <p className="text-muted-foreground">This assessment did not use the medication list or patient demographics. Both are recorded in the chart only.</p>
      </EvidenceBlock>
      <EvidenceBlock title="View source">
        {worded && result.citation ? (
          <ResultSource citation={result.citation} strength={result.strength} />
        ) : (
          <p>{worded ? 'No source citation was saved with this result.' : 'No guideline text is associated with this outcome, so no guideline source is shown.'}</p>
        )}
      </EvidenceBlock>
      <EvidenceBlock title="Missing information and limitations">
        {view.missing.length === 0 ? (
          <p>No required information was recorded as missing.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.missing.map((item, index) => (
              <li key={index} className="flex flex-col gap-1">
                <span className="text-muted-foreground">
                  {ABOUT[item.about]}
                  {item.gene ? ` · ${item.gene}` : ''}
                </span>
                <span>{item.message}</span>
                <span>{item.nextStep ? `Reviewer next step: ${item.nextStep}` : 'No reviewer action is specified for this status.'}</span>
              </li>
            ))}
          </ul>
        )}
      </EvidenceBlock>
      {view.changes.length > 0 && (
        <EvidenceBlock title="What changed?">
          <ul className="flex flex-col gap-1">
            {view.changes.map((change, index) => (
              <li key={index}>
                {change.message}
                {change.when && <span className="text-muted-foreground"> {when(change.when)}</span>}
              </li>
            ))}
          </ul>
        </EvidenceBlock>
      )}
    </aside>
  );
}
