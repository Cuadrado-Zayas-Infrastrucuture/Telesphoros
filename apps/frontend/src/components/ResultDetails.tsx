import type { ReactNode } from 'react';
import type { EvaluationDto } from '@telesphoros/shared-types';
import { outcomeLabel, reasonMessage, showsWording } from '@/lib/resultStatus';

type Result = EvaluationDto['results'][number];
type GeneState = EvaluationDto['geneStates'][number];

/**
 * One result's body, shared by the assessment and the stored results: the outcome in plain words, the phenotype it rests on, its wording
 * (folded behind "Show the text anyway" when the evaluation is not current), and the raw codes in its provenance. Guideline wording is
 * shown only for an outcome that carries it (`showsWording`).
 */
export function ResultDetails({ result, geneStates, fold, provenance }: { result: Result; geneStates: readonly GeneState[]; fold: boolean; provenance: ReactNode }) {
  const genes = result.genes.map((gene) => geneStates.find((state) => state.gene === gene) ?? { gene, phenotype: null, diplotype: null, activityScore: null });
  const reason = reasonMessage(result);
  const wording = showsWording(result) && (result.recommendationText || result.implication) && (
    <>
      {result.recommendationText && <p className="whitespace-pre-wrap wrap-anywhere">{result.recommendationText}</p>}
      {result.implication && <p className="text-sm wrap-anywhere">{result.implication}</p>}
    </>
  );
  const tone = result.outcome === 'shown' ? 'font-medium' : result.outcome === 'held' ? 'text-warning' : 'text-muted-foreground';
  return (
    <>
      <p className={`text-sm ${tone}`}>{outcomeLabel(result.outcome)}</p>
      {reason && <p className="text-sm">{reason}</p>}
      {genes.length > 0 && (
        <p className="text-sm">
          {genes.map((gene, index) => (
            <span key={gene.gene}>
              {index > 0 && ' · '}
              <span>{gene.phenotype ? `${gene.gene}: ${gene.phenotype}` : gene.gene}</span>
            </span>
          ))}
        </p>
      )}
      {wording &&
        (fold ? (
          <details>
            <summary className="flex min-h-control cursor-pointer items-center text-sm">Show the text anyway</summary>
            <div className="flex flex-col gap-1">{wording}</div>
          </details>
        ) : (
          wording
        ))}
      <details>
        <summary className="flex min-h-control cursor-pointer items-center text-sm">Source and provenance</summary>
        <div className="flex flex-col gap-1 text-xs wrap-anywhere">
          <p>
            Outcome code: {result.outcome}
            {result.reasonCode ? ` · Reason code: ${result.reasonCode}` : ''}
          </p>
          {genes
            .filter((gene) => gene.diplotype || gene.activityScore)
            .map((gene) => (
              <p key={gene.gene}>
                {gene.gene} {[gene.diplotype && `diplotype ${gene.diplotype}`, gene.activityScore && `activity score ${gene.activityScore}`].filter(Boolean).join(', ')}
              </p>
            ))}
          {provenance}
          {result.strength && <p>Recorded strength: {result.strength}</p>}
          {result.citation && <pre className="whitespace-pre-wrap wrap-anywhere">{JSON.stringify(result.citation, null, 2)}</pre>}
        </div>
      </details>
    </>
  );
}
