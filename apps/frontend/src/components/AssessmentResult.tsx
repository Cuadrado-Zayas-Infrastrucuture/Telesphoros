import { Link } from 'react-router-dom';
import { drugPresentation, type EvaluationDto } from '@telesphoros/shared-types';

/** One stored synthetic assessment, read-only: the outcome and wording per drug, its source and provenance, and the way to the patient's stored results. */
export function AssessmentResult({ evaluation, created }: { evaluation: EvaluationDto; created: boolean }) {
  return (
    <div aria-label="Assessment result" role="status" className="space-y-3">
      <p>{created ? 'Stored just now.' : 'The same assessment was already stored.'}</p>
      {evaluation.disposition === 'held' ? (
        <p className="text-warning">
          Held: {evaluation.hold?.message ?? evaluation.holdCode ?? 'No interpretation available.'} {evaluation.hold?.reviewerAction}
        </p>
      ) : (
        <p className="text-success">Evaluated against synthetic knowledge.</p>
      )}
      {evaluation.results.map((result) => (
        <section key={result.id} aria-label={`Assessment ${result.drug}`} className="space-y-1 border-t border-divider pt-2">
          <p className="font-medium">{drugPresentation({ name: result.drug }).displayName}</p>
          <p className="text-sm">
            {result.genes.join(', ')} · {result.outcome}
            {result.reasonCode ? ` · ${result.reasonCode}` : ''}
          </p>
          {result.recommendationText && <p className="whitespace-pre-wrap wrap-anywhere">{result.recommendationText}</p>}
          {result.implication && <p className="text-sm wrap-anywhere">{result.implication}</p>}
          <details>
            <summary className="flex min-h-control cursor-pointer items-center text-sm">Source and provenance</summary>
            <div className="space-y-1 text-xs wrap-anywhere">
              {result.strength && <p>Recorded strength: {result.strength}</p>}
              {result.citation && <pre className="whitespace-pre-wrap wrap-anywhere">{JSON.stringify(result.citation, null, 2)}</pre>}
              <p>Knowledge: {evaluation.knowledgeSetId}</p>
              <p>Engine: {evaluation.engineVersion}</p>
            </div>
          </details>
        </section>
      ))}
      <Link className="inline-flex min-h-control items-center underline" to={`/patients/${evaluation.patientId}`}>
        Open this patient’s stored results
      </Link>
    </div>
  );
}
