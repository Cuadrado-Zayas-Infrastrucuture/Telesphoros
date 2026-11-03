import { useCallback, useEffect, useRef, useState } from 'react';
import { structuredRecordStateSchema, type StructuredPreview, type StructuredRecordState } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';

const labels = {
  'not-recorded': 'Findings not saved for review',
  'candidate-for-review': 'Saved · ready for findings review',
  superseded: 'Saved · a newer revision is available',
  held: 'Saved · reconciliation needed',
};
const reasons: Record<string, string> = {
  'source-or-review-changed': 'A stored source or patient-link decision changed. Recheck the source history.',
  'duplicate-revision-content': 'Different files claim the same laboratory revision.',
  'revision-gap': 'A preceding revision is missing.',
  'predecessor-mismatch': 'The declared preceding report does not match the history.',
  'latest-status-ineligible': 'The latest laboratory report is not eligible for review.',
  'report-id-reused': 'A laboratory report identifier was reused.',
  'accession-reused': 'An accession was reused across report series.',
  'source-patient-mismatch': 'Patient references differ within the series.',
  'accession-mismatch': 'Accessions differ within the series.',
  'specimen-mismatch': 'Specimen details differ within the series.',
  'issue-time-reversal': 'Revision dates are out of order.',
  'terminal-revision-has-successor': 'A cancelled or erroneous report has a successor.',
};

/** Remounted for a new source or patient-link decision; mutation uncertainty always requires a fresh read. */
export function StructuredRevisionRecord({ preview }: { preview: StructuredPreview }) {
  const { apiFetch } = useAuth();
  const [state, setState] = useState<StructuredRecordState | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const fetchRecord = useCallback(
    async (controller: AbortController, save: boolean) => {
      const response = await apiFetch(`/api/v1/reports/${preview.reportId}/structured-preview/record`, {
        signal: controller.signal,
        ...(save
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                patientId: preview.patientId,
                ...preview.source,
                sourcePatientReference: preview.laboratoryReport.patientId,
                patientLinkDecisionId: preview.patientLink.decision?.id,
              }),
            }
          : {}),
      });
      if (!response.ok) throw new Error('Unavailable');
      const value = structuredRecordStateSchema.parse(await response.json());
      if (value.reportId !== preview.reportId || value.patientId !== preview.patientId || (value.record && value.record.reportId !== preview.reportId))
        throw new Error('Mismatched response');
      return value;
    },
    [apiFetch, preview],
  );
  const receive = useCallback(
    (controller: AbortController, save: boolean) => {
      void fetchRecord(controller, save)
        .then(
          (value) => {
            if (!controller.signal.aborted) setState(value);
          },
          () => {
            if (!controller.signal.aborted)
              setError(
                save
                  ? 'Save could not be confirmed. Reload saved findings before trying again; the save may already have completed.'
                  : 'Saved findings are unavailable. Reload to check the current source and review.',
              );
          },
        )
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    },
    [fetchRecord],
  );
  function request(save: boolean) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setState(null);
    receive(controller, save);
  }
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    receive(controller, false);
    return () => pending.current?.abort();
  }, [receive]);
  return (
    <section aria-label="Saved findings" aria-busy={busy} className="space-y-2 border-t border-divider pt-3">
      {busy && <p>Checking saved findings…</p>}
      {error && <p role="alert">{error}</p>}
      {state && (
        <>
          <p className="font-semibold">{labels[state.state]}</p>
          <p className="text-muted-foreground">Synthetic evidence only. Findings still require independent review before any clinical interpretation.</p>
          {state.reasons.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {state.reasons.map((reason) => (
                <li key={reason}>{reasons[reason] ?? 'Source history requires reconciliation.'}</li>
              ))}
            </ul>
          )}
          {state.state === 'not-recorded' &&
            (preview.patientLink.state === 'verified' ? (
              <Button className="h-auto min-h-control whitespace-normal" disabled={busy} onClick={() => void request(true)}>
                Save findings for review
              </Button>
            ) : (
              <p>Verify the patient link before saving findings for review.</p>
            ))}
          {state.history.length > 0 && (
            <details>
              <summary className="min-h-control cursor-pointer py-3 font-semibold">Saved source history ({state.history.length})</summary>
              <ul aria-label="Saved source history" className="divide-y divide-divider">
                {state.history.map((item) => (
                  <li key={item.id} className="space-y-1 break-words py-2">
                    <p>
                      {item.laboratoryId} · {item.laboratoryReportId} · Revision {item.revision} ({item.status})
                    </p>
                    <p className="text-muted-foreground">
                      {item.findingIds.length} findings · {new Date(item.createdAt).toLocaleString()}
                      {item.reportId === preview.reportId ? ' · This upload' : ''}
                      {!item.currentBinding ? ' · Source or review changed' : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {!busy && (
        <Button variant="outline" onClick={() => void request(false)}>
          Reload saved findings
        </Button>
      )}
    </section>
  );
}
