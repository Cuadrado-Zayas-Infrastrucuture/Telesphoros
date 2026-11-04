import { useEffect, useRef, useState } from 'react';
import { evaluationDtoSchema, type EvaluationDto, type StructuredPreview, type StructuredRecordState } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { AssessmentResult } from './AssessmentResult';
import { Button } from '@/components/ui/Button';

/** Every saved finding has a decision: reviewed (complete) or reviewed with some on hold (attention). Before that the server would only store a hold. */
const READY = new Set<StructuredRecordState['review']['status']>(['complete', 'attention']);

function failureText(status: number | undefined) {
  if (status === 409) return 'The assessment was refused: the saved evidence is not ready or has changed. Reload saved findings and check the review, then try again.';
  if (status === 503) return 'The synthetic assessment is not switched on in this environment.';
  if (status === 403) return 'Your role cannot run an assessment.';
  return 'The assessment could not be confirmed. Reload saved findings before trying again; running it again returns the same stored assessment if nothing changed.';
}

/**
 * The synthetic staging only (VITE_SYNTHETIC_ASSESSMENT): turns the saved, independently reviewed findings of one stored structured report into a stored
 * synthetic assessment and shows it. Nothing here is an interpretation of a patient: the server evaluates invented knowledge, holds anything incomplete,
 * and labels the result synthetic and not approved for clinical use.
 */
export function StructuredAssessment({ preview, state }: { preview: StructuredPreview; state: StructuredRecordState }) {
  const { apiFetch, roles } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ evaluation: EvaluationDto; created: boolean } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (!roles.some((role) => role === 'clinician' || role === 'reviewer')) return null;
  const ready = state.state === 'candidate-for-review' && state.record !== null && READY.has(state.review.status);

  async function run() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await apiFetch(`/api/v1/reports/${preview.reportId}/structured-assessment`, { method: 'POST', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error('Refused'), { status: response.status });
      }
      const evaluation = evaluationDtoSchema.parse(await response.json());
      if (evaluation.reportId !== preview.reportId || evaluation.patientId !== preview.patientId) throw new Error('Mismatched response');
      if (!controller.signal.aborted) setResult({ evaluation, created: response.status === 201 });
    } catch (failure) {
      if (!controller.signal.aborted) setError(failureText((failure as { status?: number })?.status));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <section aria-label="Synthetic assessment" aria-busy={busy} data-surface="synthetic-staging-assessment" className="space-y-2 border-t border-divider pt-3">
      <p className="font-semibold">Synthetic assessment</p>
      <p className="text-muted-foreground">
        Synthetic data only. Clinical use is not approved. The result is derived from the saved findings and their independent review; it is not a recommendation.
      </p>
      {!ready && <p>Available once every saved finding has an independent decision.</p>}
      <Button className="h-auto min-h-control whitespace-normal" disabled={!ready || busy} onClick={() => void run()}>
        {busy ? 'Running the synthetic assessment…' : 'Run synthetic assessment'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && <AssessmentResult evaluation={result.evaluation} created={result.created} />}
    </section>
  );
}
