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
      {historical && <p className="text-sm text-muted-foreground">This is the evidence as it was stored with this earlier result.</p>}
      <EvidenceBlock title={worded ? 'Why this applies' : 'What the assessment used'}>
        {view.used.length > 0 ? (
          <>
            <p className="text-muted-foreground">Gene results used, from the report assessed {when(evaluation.createdAt)}:</p>
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
          <p>No gene result was used for this drug.</p>
        )}
        {view.notRecorded.map((gene) => (
          <p key={gene} className="text-warning">
            {gene}: no state was recorded with this result. It is not assumed.
          </p>
        ))}
        <p className="text-muted-foreground">Not used by this assessment: the medication list and the demographics. They are recorded in the chart only.</p>
      </EvidenceBlock>
      <EvidenceBlock title="Show the source">
        {worded && result.citation ? (
          <ResultSource citation={result.citation} strength={result.strength} />
        ) : (
          <p>{worded ? 'No citation was stored with this result.' : 'This outcome has no guideline wording, so there is no source to show.'}</p>
        )}
      </EvidenceBlock>
      <EvidenceBlock title="What is missing?">
        {view.missing.length === 0 ? (
          <p>Nothing the assessment needed is recorded as missing.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.missing.map((item, index) => (
              <li key={index} className="flex flex-col gap-1">
                <span className="text-muted-foreground">
                  {ABOUT[item.about]}
                  {item.gene ? ` · ${item.gene}` : ''}
                </span>
                <span>{item.message}</span>
                <span>{item.nextStep ? `A reviewer's next step: ${item.nextStep}` : 'Nothing can be done about this in the product yet.'}</span>
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
