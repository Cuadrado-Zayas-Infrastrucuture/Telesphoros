import { Link } from 'react-router-dom';
import { drugPresentation, type EvaluationDto } from '@telesphoros/shared-types';
import { evaluationLine, evaluationStanding } from '@/lib/resultStatus';
import { ResultDetails } from './ResultDetails';
import { StandingNotices } from './StandingNotices';

/** One stored synthetic assessment, read-only: the outcome and wording per drug, its source and provenance, and the way to the patient's stored results. */
export function AssessmentResult({ evaluation, created }: { evaluation: EvaluationDto; created: boolean }) {
  const line = evaluationLine(evaluation.results);
  // An assessment already stored may since have been withdrawn or quarantined: say so, as the stored results do.
  const standing = evaluationStanding(evaluation);
  return (
    <div aria-label="Assessment result" role="status" className="space-y-3">
      <p>{created ? 'Stored just now.' : 'The same assessment was already stored.'}</p>
      <StandingNotices notices={standing.notices} />
      {evaluation.disposition === 'held' ? (
        <p className="text-warning">
          Held: {evaluation.hold?.message ?? evaluation.holdCode ?? 'No interpretation available.'} {evaluation.hold?.reviewerAction}
        </p>
      ) : (
        <p className={line.tone === 'warning' ? 'text-warning' : undefined}>{line.message}</p>
      )}
      {evaluation.results.map((result) => (
        <section key={result.id} aria-label={`Assessment ${result.drug}`} className="space-y-1 border-t border-divider pt-2">
          <p className="font-medium">{drugPresentation({ name: result.drug }).displayName}</p>
          <ResultDetails
            result={result}
            geneStates={evaluation.geneStates}
            fold={standing.fold}
            provenance={
              <>
                <p>Knowledge: {evaluation.knowledgeSetId}</p>
                <p>Engine: {evaluation.engineVersion}</p>
              </>
            }
          />
        </section>
      ))}
      <Link className="inline-flex min-h-control items-center underline" to={`/patients/${evaluation.patientId}`}>
        Open this patient’s stored results
      </Link>
    </div>
  );
}
